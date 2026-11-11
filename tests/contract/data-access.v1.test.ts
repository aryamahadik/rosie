// Contract test for K-05, the data-access calls: v1 and its additive minor versions v1.1 to v1.8 (T-084; T-1169, with
// T-1188 folded in by DL-373; T-1199 for v1.6; T-1214 for v1.7; T-1218 for v1.8; ops/plan/02-contracts.md K-05
// "Contract test" and section 2 item 12; contracts/data-access/README.md "Fixtures", "Producers and consumers" and each
// version's "Consumers of" list).
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed schemas, fixtures
// and README, and one part per producer or consumer side, added later by a QA side task that depends on this task and
// on that side's build task. SIDE_CHECKS (at the end) is the list where each side is added. The producer's side of v1.3,
// v1.4, v1.6, v1.7 and v1.8, every fixture of the five run through db/repo's own calls against local PostgreSQL, is
// data-access.v1.db-side.test.ts (T-1169; v1.6's by T-1199; v1.7's by T-1214; v1.8's by T-1218); v1.5 adds no database
// call.
//
// K-05 is frozen at v1 to v1.8 (frozen.json), and fixtures/index.json lists every version's fixtures. Each entry is
// checked against the schema its own `version` names, at the definition its `def` names (the T-003 harness:
// data-access.<version>.schema.json #/$defs/<def>), and entries are selected by version, never by a pinned list or
// count (DL-124, DL-125), so a later minor version's fixtures are checked by parts 1, 3 and 4 as they land. As DL-124
// settled for K-06, this file holds v1 and its additive minor versions: the v1.2 fixture part the README plans as
// T-128 ("every v1.2 fixture against its schema, refused ones refused") is covered here, and so are the fixture parts of
// v1.3, v1.4, v1.5, v1.6, v1.7 and v1.8 (README: "may join tests/contract/data-access.v1.test.ts, as v1.2's did"; v1.6's
// "joins tests/contract/data-access.v1.test.ts as v1.5's did"; v1.7's and v1.8's "joins
// tests/contract/data-access.v1.test.ts", "Consumers of v1.7" and "Consumers of v1.8"), with part 5, v1.5's rowReader
// read as README item 44 says and three faults no fixture shows refused (T-1188; T-1184's security note b), and part 6,
// v1.7's chat-opened entry named by its text as item 46 says.
//
// What this part proves:
//   1. every fixture in contracts/data-access/fixtures/index.json is checked against the schema of its version:
//      accepted ones are accepted, refused ones are refused, none is left out, and as many are checked as the index
//      lists; every call each version's schema names has an accepted fixture; every accepted fixture also passes the
//      same definition of each later minor version (a minor version only adds);
//   2. each refusal is tied to its reason (DL-124's mend-then-accept proof): the schema's own errors name the fault the
//      index states, and with that one fault put right and nothing else changed, the copy is accepted; where an
//      accepted fixture shows the same exchange, the copy put right is that fixture's;
//   3. the schema is not vacuous: removing any one field the schema requires, at any depth (the exchange, its given,
//      request and outcome, and every object inside them, read from the schema's own `required` lists along the
//      branches the fixture takes), from a copy of an accepted fixture makes the copy refused, and so does a field the
//      schema does not know; the check is shown firing on a schema that stops requiring a field;
//   4. what the schema leaves to the fixtures and the README states, each also run on a damaged copy to show that it
//      fires: every `given` names fixtures and seeds that exist (accepted, of its own version or an earlier one, with no
//      loop in a chain); the ids fixed by rule (a part's key and the next one, a saved time's clock row, the "all set"
//      row, a claim's entry); the cast's phone numbers (555-01xx) and email addresses (example.com; rule 9).
//   5. v1.5's rowReader (README item 44, a mapping, not a database call): the three accepted rows read as the README
//      says (Sam with no role on S1-02 as the owner, by the sign-up line; Tomás's section 5 row noReader; a held role
//      first), and three cases built from an accepted twin, each refused by the one rule its fault breaks and accepted
//      once its outcome is put right: a row with no person, a line to no one (lineTo null) and a cust line, each read as
//      the owner.
//   6. v1.7's openChatOnText (README item 46, "The entry"): each answer names the request's handle, and each
//      phone.chat_opened entry is the request's text's, its id '<event id>/chat-opened', its row the request's handle
//      and its why the request's event, which the schema leaves to code (as a claim entry's id, item 33).
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: each fixture's request run against local
//   PostgreSQL giving its outcome (v1.3's, v1.4's, v1.6's, v1.7's and v1.8's in data-access.v1.db-side.test.ts), 1,000
//   parallel reserves, a repeated commit, parallel claims, and each consumer accepting every valid fixture and refusing
//   every invalid one.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
const DB_SCHEMA_DIR = path.join(CONTRACTS_ROOT, "db-schema");
const ID_BASE = "https://rosie.invalid/contracts/";

/** The versions this file writes part 2's proofs and the side list for; a later minor version's QA task adds its own. */
const WRITTEN_FOR = ["v1", "v1.1", "v1.2", "v1.3", "v1.4", "v1.5", "v1.6", "v1.7", "v1.8"];
/** The fixture parts the README plans as tasks of their own that this file covers (DL-124). */
const COVERED_HERE = ["T-128"];

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
const versions = [...new Set(entries.map((entry) => entry.version))];
const ofVersion = (version: string, expectation: "accept" | "refuse"): FixtureEntry[] =>
  entries.filter((entry) => entry.version === version && entry.expect === expectation);
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const refusedEntries = entries.filter((entry) => entry.expect === "refuse");
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

/** A version's major and minor number: v1 is [1, 0], v1.2 is [1, 2]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`the index names a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/** Whether `earlier` is `later` or an earlier minor version of the same major version. */
function atOrBefore(earlier: string, later: string): boolean {
  const [major, minor] = placeOf(earlier);
  const [laterMajor, laterMinor] = placeOf(later);
  return major === laterMajor && minor <= laterMinor;
}

// ---------------------------------------------------------------------------------------------------------------
// The schemas: every schema under contracts/, loaded as contracts:check loads them, so each $ref of K-05's files
// resolves; one strict validator (the harness's Ajv 2020-12 setup) for the fixtures

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
// Part 3 asks whether a value fits one branch or one `if` of a definition, taken out of the definition that holds it.
// Taken out, such a part has lost its parent's `type`, which Ajv's strict types would ask it to state again, though it
// is no schema of its own; every other strict rule stays on, and whole definitions are judged by `ajv` above and by the
// harness, never by this one.
const branchAjv = new Ajv2020({ strict: true, strictRequired: false, strictTypes: false });
for (const schema of schemaById.values()) {
  ajv.addSchema(schema);
  branchAjv.addSchema(structuredClone(schema));
}

const schemaFileOf = (version: string): string => `data-access.${version}.schema.json`;
const idOf = (version: string): string =>
  (readJson(path.join(DATA_ACCESS_DIR, schemaFileOf(version))) as { $id: string }).$id;

/** The strict validator of one definition (or the root) of a version's schema. */
function validatorOf(version: string, def: string | undefined): ValidateFunction {
  const key = def === undefined ? idOf(version) : `${idOf(version)}#/$defs/${def}`;
  return must(ajv.getSchema(key), `the schema ${key}`);
}
const validatorFor = (entry: FixtureEntry): ValidateFunction => validatorOf(entry.version, entry.def);

/** Every $ref in a schema. */
function refsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refsIn);
  if (!isRecord(node)) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    key === "$ref" && typeof child === "string" ? [child] : refsIn(child),
  );
}

/** The contract folders whose schemas K-05's schema files refer to, directly or through another schema. */
function referredFolders(): string[] {
  const queue = [...schemaById.keys()].filter((id) => id.startsWith(`${ID_BASE}data-access/`));
  const seen = new Set<string>();
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const ref of refsIn(must(schemaById.get(id), `the schema ${id}`))) {
      const target = new URL(ref, id);
      target.hash = "";
      queue.push(target.href);
    }
  }
  const folders = [...seen].map((id) => path.posix.dirname(id.slice(ID_BASE.length)));
  return [...new Set(folders)].filter((folder) => folder !== "data-access").sort();
}

// Compiled while the file loads, so no test pays for a first compile: each entry's definition, and the same definition
// of each later minor version, which part 1 checks every accepted fixture against.
for (const entry of entries) {
  validatorFor(entry);
  if (entry.expect !== "accept") continue;
  for (const later of versions.filter((version) => atOrBefore(entry.version, version))) {
    validatorOf(later, entry.def);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked by the T-003 harness against the schema of its version

const report = checkContractFixtures("data-access", { sharedFolders: referredFolders() });

describe("data-access fixtures: the index, the count and each fixture against the schema of its version", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(report.problems).toEqual([]);
    expect(report.entries.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(report.seedRows).toBe(0);
    expect(report.passes + report.refusals).toBe(entries.length);
    const onDisk = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => file.endsWith(".json") && file !== "index.json");
    expect([...onDisk].sort()).toEqual(entries.map((entry) => entry.file).sort());
  });

  it("accepts every entry marked accept and refuses every entry marked refuse, each by its schema", () => {
    expect(report.passes).toBe(acceptedEntries.length);
    expect(report.refusals).toBe(refusedEntries.length);
    expect(
      entries.filter((entry) => "rule" in entry).map((entry) => entry.file),
      "no entry names a rule: the README refuses each fixture by its schema",
    ).toEqual([]);
    for (const result of report.entries) {
      expect(result.problems, result.file).toEqual([]);
      expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
    }
  });

  for (const entry of entries) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} (${entry.version}, ${entry.def ?? "root"})`, () => {
      const result = must(report.entries.find((candidate) => candidate.file === entry.file));
      expect(result.schema).toBe(schemaFileOf(entry.version));
      expect(result.def).toBe(entry.def ?? null);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      // This file's own validator agrees, so parts 2 and 3 judge with the same schema.
      expect(validatorFor(entry)(fixture(entry.file))).toBe(entry.expect === "accept");
    });
  }

  it("selects each entry's schema by its version, with accepted and refused fixtures of each version this file was written for", () => {
    for (const version of WRITTEN_FOR) {
      expect(versions, version).toContain(version);
      expect(ofVersion(version, "accept").length, `${version}: accepted`).toBeGreaterThan(0);
      expect(ofVersion(version, "refuse").length, `${version}: refused`).toBeGreaterThan(0);
    }
    for (const version of versions) {
      expect(existsSync(path.join(DATA_ACCESS_DIR, schemaFileOf(version))), version).toBe(true);
    }
    for (const result of report.entries)
      expect(result.schema, result.file).toBe(schemaFileOf(result.version));
  });

  it("has an accepted fixture of every call each version's schema names, at that version or an earlier one", () => {
    for (const version of versions) {
      const root = must(schemaById.get(idOf(version))) as { anyOf?: { $ref?: string }[] };
      const exchanges = (root.anyOf ?? []).map((branch) => must(branch.$ref).replace("#/$defs/", ""));
      expect(exchanges.length, version).toBeGreaterThan(0);
      for (const def of exchanges) {
        expect(
          acceptedEntries.some((entry) => entry.def === def && atOrBefore(entry.version, version)),
          `${version}: ${def}`,
        ).toBe(true);
      }
    }
  });

  it("has every accepted fixture pass the same definition of each later minor version (a minor version only adds)", () => {
    let checked = 0;
    for (const entry of acceptedEntries) {
      for (const later of versions.filter((v) => v !== entry.version && atOrBefore(entry.version, v))) {
        const validate = validatorOf(later, entry.def);
        expect(
          validate(fixture(entry.file)),
          `${entry.file} under ${later}: ${formatErrors(validate.errors).join("; ")}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Each refusal tied to its reason

/** One change a mend makes, at a dotted path (array items by number): a field set to a value, or taken out. */
type Change = { at: string; to: unknown } | { at: string; remove: true };

/** README "Fixtures": each refused fixture is refused for one reason and accepted once that one fault is fixed. */
interface Mend {
  /** Why the schema refuses it, as the index's `shows` says. */
  reason: string;
  /** What putting it right is. */
  putRight: string;
  changes: Change[];
  /** An accepted fixture that shows the same exchange: the copy put right (or its `part`) is that fixture's `at`. */
  same?: { file: string; at: string; part?: string };
}

const stepsOf = (at: string): string[] => (at === "" ? [] : at.split("."));

/** The value at a dotted path; a missing step is a broken test. */
function valueAt(value: unknown, at: string): unknown {
  let node = value;
  for (const step of stepsOf(at)) {
    if (Array.isArray(node) && /^\d+$/.test(step) && Number(step) < node.length) node = node[Number(step)];
    else if (isRecord(node) && Object.hasOwn(node, step)) node = node[step];
    else throw new Error(`no ${step} on the way to ${at}`);
  }
  return node;
}

/** A copy of `value` with the changes made. */
function changed(value: unknown, changes: readonly Change[]): unknown {
  const copy = structuredClone(value);
  for (const change of changes) {
    const steps = stepsOf(change.at);
    const last = must(steps.pop(), `the last step of ${change.at}`);
    const parent = valueAt(copy, steps.join("."));
    if (!isRecord(parent) && !Array.isArray(parent)) throw new Error(`${change.at} is inside no object`);
    if ("remove" in change) Reflect.deleteProperty(parent, last);
    else Reflect.set(parent, last, change.to);
  }
  return copy;
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

const fromFixture = (file: string, at: string): unknown => valueAt(fixture(file), at);

// Every error the schema gives a refused fixture, not only its first, so part 2 can ask whether one names the fault.
const errorsAjv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const schema of schemaById.values()) errorsAjv.addSchema(structuredClone(schema));
const errorsValidatorFor = (entry: FixtureEntry): ValidateFunction => {
  const key = entry.def === undefined ? idOf(entry.version) : `${idOf(entry.version)}#/$defs/${entry.def}`;
  return must(errorsAjv.getSchema(key), `the schema ${key}`);
};
for (const entry of refusedEntries) errorsValidatorFor(entry);

/** The places the schema's errors name in a value: each error's path, with the field a required error misses. */
function errorPlaces(entry: FixtureEntry, value: unknown): string[] {
  const validate = errorsValidatorFor(entry);
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

/** Whether a place is the field at `at`, inside it, or an object that holds it (never the whole value). */
const near = (place: string, at: string): boolean =>
  place === at || place.startsWith(`${at}.`) || (place !== "" && at.startsWith(`${place}.`));

/**
 * Each way a mend fails to tie a refusal to its reason, none when the proof holds: the fixture is refused as it stands,
 * the schema's errors name one of the fault's fields (`faults`, every field the file's mends change), the copy put right
 * is accepted, each change the mend names is a change, and the copy put right is the accepted fixture it names.
 */
export function mendProblems(entry: FixtureEntry, mend: Mend, faults: readonly string[]): string[] {
  const problems: string[] = [];
  const validate = validatorFor(entry);
  const refused = fixture(entry.file);
  if (validate(refused)) problems.push(`${entry.file} is accepted as it stands`);
  const named = errorPlaces(entry, refused);
  if (!named.some((place) => faults.some((at) => near(place, at)))) {
    problems.push(`the schema's errors name none of ${faults.join(", ")}: ${named.join("; ")}`);
  }
  const right = changed(refused, mend.changes);
  if (!validate(right))
    problems.push(`put right, it is still refused: ${formatErrors(validate.errors).join("; ")}`);
  const differ = differences(refused, right);
  for (const change of mend.changes) {
    if (!differ.some((place) => near(place, change.at))) problems.push(`${change.at} is no change`);
  }
  if (mend.same !== undefined) {
    const { file, at, part } = mend.same;
    if (entryOf(file).expect !== "accept") problems.push(`${file} is not an accepted fixture`);
    else if (!isDeepStrictEqual(valueAt(right, part ?? ""), fromFixture(file, at))) {
      problems.push(`put right, it is not ${file}'s ${at}`);
    }
  }
  return problems;
}

const MENDS: Record<string, Mend[]> = {
  // v1
  "invalid/refuse-commit-outbox-with-plan.json": [
    {
      reason:
        "its outbox row carries a plan, and a commit writes rows with no plan (outboxRowNew has no plan field)",
      putRight: "with the plan left for writePlan, after the commit",
      changes: [{ at: "writes.outboxRows.0.plan", remove: true }],
    },
  ],
  "invalid/refuse-commit-state-write-to-reservations.json": [
    {
      reason:
        "a state write names reservations, which change only through confirm, release and reserve (stateTable)",
      putRight: "with the saved time confirmed with its booking, the commit's own way, and no state write",
      changes: [
        { at: "writes.state", to: [] },
        {
          at: "writes.reservations.confirm",
          to: [{ id: "rsv-alex-riley-nov14", expectVersion: 1, bookingId: "booking-alex-riley-nov14" }],
        },
      ],
      same: {
        file: "commit-first.json",
        at: "request.writes.reservations.confirm",
        part: "writes.reservations.confirm",
      },
    },
    {
      reason: "the state write's table is reservations (stateTable)",
      putRight: "with only that table changed to one a state write may name (bookings)",
      changes: [{ at: "writes.state.0.table", to: "bookings" }],
    },
  ],
  "invalid/refuse-turn-fourth-try.json": [
    {
      reason: "its turn is on a fourth try, and a third crash before the commit parks it (tries 1 to 3)",
      putRight: "on its third try",
      changes: [{ at: "turn.tries", to: 3 }],
    },
  ],
  "invalid/refuse-reserve-document-over-24-hours.json": [
    {
      reason: "a document's saved time of 1,500 minutes is past 24 hours (holdMinutes at most 1,440)",
      putRight: "with 24 hours, 1,440 minutes",
      changes: [{ at: "holdMinutes", to: 1440 }],
    },
  ],
  "invalid/refuse-reserve-ai-door-with-minutes.json": [
    {
      reason:
        "the customer's own AI's door asks for 30 minutes, and its 15 are set by the door (holdMinutes null)",
      putRight: "with no minutes asked for",
      changes: [{ at: "holdMinutes", to: null }],
      same: { file: "reserve-ai-door-15-min.json", at: "request" },
    },
  ],
  "invalid/refuse-fire-without-turn-writes-outbox.json": [
    {
      reason:
        "a firing with no turn writes an outbox row, which needs its turn (K-04 outbox_rows.turn_id is not null)",
      putRight: "with the turnless firing writing no outbox row",
      changes: [{ at: "writes.outboxRows", to: [] }],
    },
  ],
  "invalid/refuse-mark-held-without-time.json": [
    {
      reason: "a row marked held has no time to hold it until",
      putRight: "held until 8am in New York",
      changes: [{ at: "heldUntil", to: "2026-11-08T13:00:00Z" }],
      same: { file: "mark-held-for-text-hours.json", at: "request" },
    },
  ],
  // v1.1
  "invalid/refuse-mark-waiting-chat-with-time.json": [
    {
      reason:
        "a row waiting for its chat carries a held time, and a waiting row has no clock and no held_until",
      putRight: "with no held time",
      changes: [{ at: "heldUntil", to: null }],
      same: { file: "mark-waiting-chat.json", at: "request" },
    },
  ],
  "invalid/refuse-reconciliation-not-refund.json": [
    {
      reason:
        "the reconciliation writes a charge, and it writes only the refund of a charge with no agreed booking",
      putRight: "with the effect a stripe_refund",
      changes: [{ at: "effect.kind", to: "stripe_refund" }],
    },
  ],
  "invalid/refuse-effect-calendar-without-visit.json": [
    {
      reason: "a calendar write names no visit, and a calendar effect is keyed by booking, visit and person",
      putRight: "with its visit",
      changes: [{ at: "visitId", to: "visit-alex-riley-nov14" }],
      same: { file: "commit-writes-effect.json", at: "request.writes.effects.write.0" },
    },
  ],
  "invalid/refuse-effect-result-ok-with-error.json": [
    {
      reason: "an ok try carries an error code",
      putRight: "with no error code",
      changes: [{ at: "errorCode", to: null }],
      same: { file: "effect-result.json", at: "request" },
    },
  ],
  "invalid/refuse-failed-no-retry-with-not-before.json": [
    {
      reason: "a failure with no next try carries a Retry-After time, which holds only a next try",
      putRight: "with no Retry-After time",
      changes: [{ at: "nextTryNotBefore", to: null }],
    },
    {
      reason: "a failure with no next try carries a Retry-After time, which holds only a next try",
      putRight: "with a next try, which the time then holds",
      changes: [{ at: "retry", to: true }],
      same: { file: "mark-failed-retry-after.json", at: "request" },
    },
  ],
  "invalid/refuse-claim-effects-sms-port.json": [
    {
      reason:
        "it claims an SMS port's effects, and effects run only through the stripe, calendar and linq ports",
      putRight: "with the calendar port's",
      changes: [{ at: "ports", to: ["calendar"] }],
    },
  ],
  "invalid/refuse-provider-event-linq.json": [
    {
      reason:
        "a Linq event is recorded as a provider event, and provider events are Stripe's and the calendars'",
      putRight: "with only its provider changed to one the table takes (stripe)",
      changes: [{ at: "provider", to: "stripe" }],
    },
  ],
  "invalid/refuse-effect-result-without-events.json": [
    {
      reason: "an effect result has no event-log entry, and every write appends one",
      putRight: "with its effect.result entry",
      changes: [{ at: "events", to: fromFixture("effect-result.json", "request.events") }],
      same: { file: "effect-result.json", at: "request" },
    },
  ],
  "invalid/refuse-safety-other-way-without-events.json": [
    {
      reason:
        "a safety line's other-way row has no event-log entry, which is the row's link to the failed one",
      putRight: "with its outbox_row.created entry naming the failed row",
      changes: [{ at: "events", to: fromFixture("mark-safety-failed-other-way.json", "request.events") }],
      same: { file: "mark-safety-failed-other-way.json", at: "request" },
    },
  ],
  "invalid/refuse-all-set-by-email.json": [
    {
      reason: "the 'all set' goes by email, and it goes once texts work, as a text",
      putRight: "with only its channel changed to iMessage",
      changes: [{ at: "row.channel", to: "imessage" }],
    },
    {
      reason: "the 'all set' goes by email, and it goes once texts work, as a text",
      putRight: "sent to Alex's mobile as a text, with its entry saying so",
      changes: [
        { at: "row.channel", to: "imessage" },
        { at: "row.recipientHandleId", to: "handle-alex" },
        { at: "events.0.newValues.channel", to: "imessage" },
      ],
      same: { file: "write-all-set.json", at: "request" },
    },
  ],
  // v1.2
  "invalid/refuse-handle-key-with-key-value.json": [
    {
      reason: "it carries the wrapping secret's value, and a key is named, never shown",
      putRight: "with the secret's name alone",
      changes: [{ at: "wrappingKey", remove: true }],
      same: { file: "handle-key-first-sight.json", at: "request" },
    },
  ],
  "invalid/refuse-claimed-row-sms-port.json": [
    {
      reason: "an sms row names an SMS port, and there is none: an sms row goes by linq",
      putRight: "with the port linq",
      changes: [{ at: "port", to: "linq" }],
    },
  ],
  "invalid/refuse-mark-delivered-key-only.json": [
    {
      reason:
        "a delivery receipt has a key and no message id, and a receipt always carries the provider's message id",
      putRight: "with the receipt's message id",
      changes: [{ at: "providerMessageId", to: "linq-msg-demo-0101" }],
      same: { file: "mark-delivered-by-key.json", at: "request" },
    },
  ],
  "invalid/refuse-claim-event-not-claim-kind.json": [
    {
      reason: "a claimed effect's entry is an effect.result, and a claim appends its own kind",
      putRight: "with the entry an effect.claimed",
      changes: [{ at: "event.kind", to: "effect.claimed" }],
      same: { file: "claim-effects-logged.json", at: "outcome.claimed.0" },
    },
  ],
  "invalid/refuse-send-state-caller-versions.json": [
    {
      reason: "a send-state request hands in versions to compare, and the call reads the row's own",
      putRight: "with the row's id alone",
      changes: [{ at: "versionsRead", remove: true }],
      same: { file: "send-state-customer.json", at: "request" },
    },
  ],
  "invalid/refuse-read-turn-state-fact-without-row.json": [
    {
      reason: "a fact is named with no home row, and each fact is read from its one home row",
      putRight: "with its home row, the barbershop's",
      changes: [{ at: "facts.0.rowId", to: "biz-lees-barbershop" }],
      same: { file: "read-turn-state-alex.json", at: "request.facts.0", part: "facts.0" },
    },
  ],
  "invalid/refuse-read-turn-state-sealing-key-fact.json": [
    {
      reason: "a fact names a sealing key's column, and no column of sealing_keys is ever a fact (factTable)",
      putRight: "with that fact taken out",
      changes: [{ at: "facts", to: [] }],
    },
    {
      reason: "the fact's home table is sealing_keys (factTable)",
      putRight: "with only that table changed to one a fact may read (persons)",
      changes: [{ at: "facts.0.table", to: "persons" }],
    },
  ],
  "invalid/refuse-read-turn-state-returns-sealing-key.json": [
    {
      reason:
        "a turn state returns Alex's wrapped key as a fact, and no column of sealing_keys is ever one (factTable)",
      putRight: "with that fact taken out",
      changes: [{ at: "facts", to: [] }],
    },
    {
      reason: "the fact's home table is sealing_keys (factTable)",
      putRight: "with only that table changed to one a fact may read (persons)",
      changes: [{ at: "facts.0.table", to: "persons" }],
    },
  ],
  "invalid/refuse-read-turn-state-session-token-fact.json": [
    {
      reason: "a fact names a session token's hash, and a secret's hash is never a fact (secretColumn)",
      putRight: "with that fact taken out",
      changes: [{ at: "facts", to: [] }],
    },
    {
      reason: "the fact's home column is sessions.token_sha256 (secretColumn)",
      putRight: "with only that column changed to one that holds no secret (expires_at)",
      changes: [{ at: "facts.0.column", to: "expires_at" }],
    },
  ],
  "invalid/refuse-read-turn-state-returns-harm-report.json": [
    {
      reason:
        "a turn state returns a harm report's column, and a table only Rosie's team reads is never a fact",
      putRight: "with that fact taken out",
      changes: [{ at: "facts", to: [] }],
    },
    {
      reason: "the fact's home table is harm_reports (factTable)",
      putRight: "with only that table changed to one a fact may read (persons)",
      changes: [{ at: "facts.0.table", to: "persons" }],
    },
  ],
  // v1.3
  "invalid/refuse-open-holds-hold-with-words.json": [
    {
      reason:
        "an open hold carries its outcome's sealed words, and a hold says what it holds back, never what the person wrote",
      putRight: "with the sealed words taken out",
      changes: [{ at: "holds.0.sealedWords", remove: true }],
      same: { file: "read-open-holds-alex.json", at: "outcome.holds.0", part: "holds.0" },
    },
  ],
  "invalid/refuse-open-holds-no-scope.json": [
    {
      reason: "a hold read states no business, and the scope is always named, a business or null",
      putRight: "with the barbershop named",
      changes: [{ at: "businessId", to: "biz-lees-barbershop" }],
      same: { file: "read-open-holds-alex.json", at: "request.businessId", part: "businessId" },
    },
    {
      reason: "a hold read states no business, and the scope is always named, a business or null",
      putRight: "with null named, the runtime side before there is a business",
      changes: [{ at: "businessId", to: null }],
    },
  ],
  "invalid/refuse-outbox-row-returns-inbound-words.json": [
    {
      reason:
        "a row read returns the words of the text it answers, which the runtime caller hands in and no exchange carries",
      putRight: "with the words taken out",
      changes: [{ at: "answers.texts.0.words", remove: true }],
      same: { file: "read-outbox-row-s1-02.json", at: "outcome" },
    },
  ],
  "invalid/refuse-outbox-row-returns-address.json": [
    {
      reason: "a row read returns the recipient's number, which compose input and finalize never need",
      putRight: "with the address taken out",
      changes: [{ at: "recipient.address", remove: true }],
      same: { file: "read-outbox-row-s1-02.json", at: "outcome" },
    },
  ],
  "invalid/refuse-fixed-line-facts-caller-handle.json": [
    {
      reason: "a fixed-line facts request names a handle, and the read takes the handle from the row itself",
      putRight: "with the row and its business alone",
      changes: [{ at: "handleId", remove: true }],
      same: { file: "fixed-line-facts-texted-before.json", at: "request" },
    },
  ],
  "invalid/refuse-fixed-line-facts-returns-number.json": [
    {
      reason:
        "fixed-line facts carry the phone's number, and the inserter needs only when the opt-out line was delivered",
      putRight: "with the number taken out",
      changes: [{ at: "phoneNumber", remove: true }],
      same: { file: "fixed-line-facts-s1-02.json", at: "outcome" },
    },
  ],
  // v1.4
  "invalid/refuse-safety-outcome-with-sealed-words.json": [
    {
      reason: "a safety record carries its sealed words, and the read gives the port's fields alone",
      putRight: "with the sealed words taken out",
      changes: [{ at: "safetyOutcome.sealedWords", remove: true }],
      same: { file: "read-safety-outcome-of-event-alex.json", at: "outcome" },
    },
  ],
  "invalid/refuse-safety-outcome-no-scope.json": [
    {
      reason: "a safety outcome read states no business, and the scope is always named, a business or null",
      putRight: "with the barbershop named",
      changes: [{ at: "businessId", to: "biz-lees-barbershop" }],
      same: { file: "read-safety-outcome-alex-safe.json", at: "request" },
    },
  ],
  "invalid/refuse-safety-hold-released-without-why.json": [
    {
      reason:
        "a hold is answered released with no reason, and a release time and its reason come together or not at all",
      putRight: "with its reason, a clear 'we're safe' read back",
      changes: [{ at: "hold.releasedWhy", to: "safe_readback" }],
      same: { file: "read-safety-hold-alex-released.json", at: "outcome" },
    },
  ],
  "invalid/refuse-safety-hold-of-outcome-two-holds.json": [
    {
      reason: "two holds are answered for one outcome, and K-34 holds one per outcome",
      putRight: "with the first of them alone, the one its outcome set",
      changes: [
        {
          at: "hold",
          to: fromFixture("invalid/refuse-safety-hold-of-outcome-two-holds.json", "hold.0"),
        },
      ],
      same: { file: "read-safety-hold-of-outcome-alex-threat.json", at: "outcome" },
    },
  ],
  "invalid/refuse-outbox-row-written-returns-words.json": [
    {
      reason:
        "a written answer carries the row's final parts, and the read says only whether the row is written",
      putRight: "with the final parts taken out",
      changes: [{ at: "finalParts", remove: true }],
      same: { file: "outbox-row-written-alex-safety.json", at: "outcome" },
    },
  ],
  "invalid/refuse-business-owner-returns-number.json": [
    {
      reason: "an owner answer carries the owner's number, and the line takes the handle by id",
      putRight: "with the address taken out",
      changes: [{ at: "owner.address", remove: true }],
      same: { file: "business-owner-barbershop.json", at: "outcome" },
    },
  ],
  "invalid/refuse-business-owner-no-business.json": [
    {
      reason: "an owner read names no business, and an owner is a business's: the read names the call's own",
      putRight: "with the barbershop named",
      changes: [{ at: "businessId", to: "biz-lees-barbershop" }],
      same: { file: "business-owner-barbershop.json", at: "request" },
    },
  ],
  "invalid/refuse-business-zone-null.json": [
    {
      reason:
        "a zone is answered null, and K-04 keeps every business's zone (one the scope hides is notFound)",
      putRight: "with the barbershop's zone",
      changes: [{ at: "timeZone", to: "America/New_York" }],
      same: { file: "business-zone-barbershop.json", at: "outcome" },
    },
  ],
  // v1.5
  "invalid/refuse-row-reader-no-role-outside-section-1.json": [
    {
      reason:
        "Tomás, who holds no role, is read as the customer by the line on a section 5 step, and the sign-up reading holds on section 1 alone",
      putRight: "refused, noReader (noRole)",
      changes: [
        { at: "outcome", to: { error: "noReader", outboxRowId: "outbox-a5-05-tomas-1", why: "noRole" } },
      ],
      same: { file: "row-reader-a5-05-tomas-no-role.json", at: "" },
    },
  ],
  "invalid/refuse-row-reader-role-read-by-line.json": [
    {
      reason: "Sam, who holds his owner role, is read by the sign-up line, and a held role always wins",
      putRight: "read by his role, role-sam-barber",
      changes: [
        { at: "outcome.from", to: "roles" },
        { at: "outcome.roleId", to: "role-sam-barber" },
      ],
      same: { file: "row-reader-s1-02-owner.json", at: "" },
    },
  ],
  // v1.6
  "invalid/refuse-outbox-row-switch-left-out.json": [
    {
      reason:
        "the practice's answer leaves its sensitive switch out, and a v1.6 answer always states it, true, false or null, so no consumer reads a missing switch as off (readOutboxRow.v1dot6Response)",
      putRight: "with the switch stated, true, as the practice's one kind of work lists it in flow A",
      changes: [{ at: "businessSensitive", to: true }],
      same: { file: "read-outbox-row-practice-sensitive.json", at: "outcome" },
    },
  ],
  "invalid/refuse-outbox-row-switch-per-flow.json": [
    {
      reason:
        "the practice's switch is answered per flow (on in flow A, off in flow B), and the read answers the business's one value, true when any kind of work lists it in either flow (businessSensitive)",
      putRight: "with that one value, true, the stricter of its two flows",
      changes: [{ at: "businessSensitive", to: true }],
      same: { file: "read-outbox-row-practice-sensitive.json", at: "outcome" },
    },
  ],
  // v1.7: each refused fixture's twin as README "Consumers of v1.7" names it
  "invalid/refuse-open-chat-stopped-number.json": [
    {
      reason:
        "a text opens Ben T.'s stopped number's chat by clearing his stop, and only START clears a stop: the call never touches a stopped row",
      putRight: "with nothing written, Ben's row as it stands (stopped)",
      changes: [{ at: "outcome", to: fromFixture("open-chat-ben-stopped.json", "outcome") }],
      same: { file: "open-chat-ben-stopped.json", at: "outcome", part: "outcome" },
    },
    {
      reason:
        "its entry names stopped, and a chat-opened entry names only chat_open, chat_open_at and chat_way (chatClosedValues, chatOpenValues)",
      putRight:
        "with only stopped taken out of the entry's old and new values (the schema cannot see that Ben's row is stopped: the database side answers his text stopped, writing nothing)",
      changes: [
        { at: "outcome.event.oldValues.stopped", remove: true },
        { at: "outcome.event.newValues.stopped", remove: true },
      ],
    },
  ],
  "invalid/refuse-open-chat-no-event.json": [
    {
      reason:
        "the call names no event, and the text's event id is the key a repeat is known by and its entry's why (openChatOnText.request)",
      putRight: "with turn 1's text named, evt-sam-s1-01",
      changes: [{ at: "eventId", to: "evt-sam-s1-01" }],
      same: { file: "open-chat-first-text-sam.json", at: "request" },
    },
  ],
  "invalid/refuse-open-chat-with-number.json": [
    {
      reason:
        "the call carries the number beside the handle, and the request names the handle by its K-04 id alone: the call reads the number from K-04 handles (openChatOnText.request)",
      putRight: "with the number taken out",
      changes: [{ at: "phoneNumber", remove: true }],
      same: { file: "open-chat-first-text-sam.json", at: "request" },
    },
  ],
  // v1.8: each refused answer's twin as README "Consumers of v1.8" names it, its outcome
  "invalid/refuse-send-state-yes-source-left-out.json": [
    {
      reason:
        "Sam's business-entered yes is answered with who gave it left out, and a v1.8 answer always states fromContact, so no consumer meets a yes it cannot place (sendState.v1dot8Response, textsConsentV1dot8)",
      putRight:
        "with fromContact stated, false: the yes was given by text in Sam's turn, on Sam's handle, the business's word, never Alex's own (README item 47, default 78)",
      changes: [{ at: "textsConsent.fromContact", to: false }],
      same: { file: "send-state-business-yes.json", at: "outcome" },
    },
  ],
  "invalid/refuse-send-state-booking-left-out.json": [
    {
      reason:
        "Alex's own fresh yes is answered with its booking left out, and a v1.8 answer always states bookingId, null for a yes that names none, so no consumer meets a yes whose booking it cannot tell (sendState.v1dot8Response, textsConsentV1dot8)",
      putRight:
        "with bookingId stated as consents.booking_id holds it, the new Nov 21 booking the yes was given for (README item 47, default 81)",
      changes: [{ at: "textsConsent.bookingId", to: "booking-alex-riley-nov21" }],
      same: { file: "send-state-own-yes-one-booking.json", at: "outcome" },
    },
  ],
  "invalid/refuse-send-state-stop-read-as-own-yes.json": [
    {
      reason:
        "Alex's STOP row is answered as his own yes (fromContact true), and a row that withdraws is no yes, so never the person's own (textsConsentRead: revoked true, fromContact false)",
      putRight: "with fromContact false, as a row that withdraws always reads (README default 82)",
      changes: [{ at: "textsConsent.fromContact", to: false }],
      same: { file: "send-state-stop-row.json", at: "outcome" },
    },
  ],
};

describe("data-access fixtures: each refusal tied to its reason (put right, the copy is accepted)", () => {
  const written = refusedEntries.filter((entry) => WRITTEN_FOR.includes(entry.version));

  it("has a mend for every refused fixture of each version this file was written for, and for no other file", () => {
    expect(written.length).toBeGreaterThan(0);
    expect(Object.keys(MENDS).sort()).toEqual(written.map((entry) => entry.file).sort());
    for (const mends of Object.values(MENDS)) expect(mends.length).toBeGreaterThan(0);
  });

  for (const entry of written) {
    const mends = MENDS[entry.file] ?? [];
    const faults = [...new Set(mends.flatMap((mend) => mend.changes.map((change) => change.at)))];
    for (const mend of mends) {
      it(`refuses ${entry.file} because ${mend.reason}; ${mend.putRight}, it is accepted`, () => {
        expect(mendProblems(entry, mend, faults)).toEqual([]);
        expect(
          differences(fixture(entry.file), changed(fixture(entry.file), mend.changes)).length,
          "the mend changes something",
        ).toBeGreaterThan(0);
      });
    }
  }

  it("has the proof fire on a damaged mend: the fault left, a change that changes nothing, errors elsewhere, the wrong twin", () => {
    const entry = entryOf("invalid/refuse-turn-fourth-try.json");
    const right = must(MENDS[entry.file]?.[0]);
    expect(mendProblems(entry, right, ["turn.tries"])).toEqual([]);
    const leftAlone: Mend = { ...right, changes: [{ at: "turn.traceId", to: "trace-maya-0005" }] };
    expect(mendProblems(entry, leftAlone, ["turn.tries"])).toEqual([
      "put right, it is still refused: /turn/tries must be <= 3",
    ]);
    const noChange: Mend = {
      ...right,
      changes: [...right.changes, { at: "turn.handleId", to: "handle-maya" }],
    };
    expect(mendProblems(entry, noChange, ["turn.tries"])).toEqual(["turn.handleId is no change"]);
    expect(mendProblems(entry, right, ["turn.traceId"])).toEqual([
      "the schema's errors name none of turn.traceId: turn.tries",
    ]);
    const wrongTwin: Mend = { ...right, same: { file: "commit-first.json", at: "request" } };
    expect(mendProblems(entry, wrongTwin, ["turn.tries"])).toEqual([
      "put right, it is not commit-first.json's request",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The schema is not vacuous

/** A place in a schema: its file's $id and a JSON pointer inside it. */
interface Place {
  id: string;
  pointer: string;
}

type Step = string | number;

/** The keywords the walker reads. */
interface Keywords {
  $ref?: string;
  allOf?: unknown[];
  anyOf?: unknown[];
  oneOf?: unknown[];
  if?: unknown;
  then?: unknown;
  else?: unknown;
  required?: string[];
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  prefixItems?: unknown[];
  items?: unknown;
}

/** Keywords that apply a schema to the value which the walker does not read: meeting one, it fails loudly. */
const UNREAD = [
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "$dynamicRef",
  "$recursiveRef",
];

const escapeStep = (step: Step): string => String(step).replaceAll("~", "~0").replaceAll("/", "~1");
const below = (place: Place, ...steps: Step[]): Place => ({
  id: place.id,
  pointer: `${place.pointer}${steps.map((step) => `/${escapeStep(step)}`).join("")}`,
});

function schemaAt(place: Place): unknown {
  let node: unknown = must(schemaById.get(place.id), `the schema ${place.id}`);
  for (const step of place.pointer.split("/").slice(1)) {
    const key = step.replaceAll("~1", "/").replaceAll("~0", "~");
    node = Array.isArray(node) ? node[Number(key)] : isRecord(node) ? node[key] : undefined;
    if (node === undefined) throw new Error(`no ${place.pointer} in ${place.id}`);
  }
  return node;
}

function referred(place: Place, ref: string): Place {
  const url = new URL(ref, place.id);
  const pointer = decodeURIComponent(url.hash.slice(1));
  url.hash = "";
  return { id: url.href, pointer };
}

/** Whether `value` fits the schema at `place`, taken on its own. */
function fits(place: Place, value: unknown): boolean {
  const key = place.pointer === "" ? place.id : `${place.id}#${place.pointer}`;
  const validate: ValidateFunction = must(branchAjv.getSchema(key), `the schema ${key}`);
  return validate(value);
}

/**
 * Adds to `found` each field `value` holds that the schema at `place` requires of it: each object's `required` and
 * dependentRequired fields, along the branches the value takes: every allOf entry, the anyOf or oneOf branches it fits
 * (a field counts only when every branch it fits requires it), then or else as it fits if, the dependentSchemas its
 * fields call in, and every property and array item it holds. A field inside a free object (one with no `required`) is
 * never counted.
 */
function walk(place: Place, value: unknown, where: Step[], found: Map<string, Step[]>): void {
  const schema = schemaAt(place);
  if (!isRecord(schema)) return;
  const unread = UNREAD.filter((keyword) => keyword in schema);
  if (unread.length > 0) {
    throw new Error(`${place.id}#${place.pointer} uses ${unread.join(", ")}, which the walker does not read`);
  }
  const keywords = schema as Keywords;
  const add = (field: string): void => {
    const path_ = [...where, field];
    found.set(JSON.stringify(path_), path_);
  };
  if (keywords.$ref !== undefined) walk(referred(place, keywords.$ref), value, where, found);
  keywords.allOf?.forEach((_, at) => {
    walk(below(place, "allOf", at), value, where, found);
  });
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = keywords[keyword];
    if (branches === undefined) continue;
    const fitting = branches
      .map((_, at) => below(place, keyword, at))
      .filter((branch) => fits(branch, value));
    if (fitting.length === 0) {
      throw new Error(`no ${keyword} branch of ${place.id}#${place.pointer} fits ${where.join(".")}`);
    }
    const each = fitting.map((branch) => {
      const own = new Map<string, Step[]>();
      walk(branch, value, where, own);
      return own;
    });
    for (const [key, field] of must(each[0])) if (each.every((own) => own.has(key))) found.set(key, field);
  }
  if (keywords.if !== undefined) {
    const branch = fits(below(place, "if"), value) ? "then" : "else";
    if (keywords[branch] !== undefined) walk(below(place, branch), value, where, found);
  }
  if (isRecord(value)) {
    for (const field of keywords.required ?? []) if (Object.hasOwn(value, field)) add(field);
    for (const [field, needs] of Object.entries(keywords.dependentRequired ?? {})) {
      if (Object.hasOwn(value, field)) for (const need of needs) if (Object.hasOwn(value, need)) add(need);
    }
    for (const field of Object.keys(keywords.dependentSchemas ?? {})) {
      if (Object.hasOwn(value, field)) walk(below(place, "dependentSchemas", field), value, where, found);
    }
    const named = keywords.properties ?? {};
    for (const [field, child] of Object.entries(value)) {
      if (Object.hasOwn(named, field))
        walk(below(place, "properties", field), child, [...where, field], found);
      else if (isRecord(keywords.additionalProperties)) {
        walk(below(place, "additionalProperties"), child, [...where, field], found);
      }
    }
  }
  if (Array.isArray(value)) {
    const prefix = keywords.prefixItems?.length ?? 0;
    value.forEach((item: unknown, at) => {
      if (at < prefix) walk(below(place, "prefixItems", at), item, [...where, at], found);
      else if (isRecord(keywords.items)) walk(below(place, "items"), item, [...where, at], found);
    });
  }
}

/** The paths of the fields `value` holds that the schema at `place` requires, at any depth (walk). */
function requiredPaths(place: Place, value: unknown): Step[][] {
  const found = new Map<string, Step[]>();
  walk(place, value, [], found);
  return [...found.values()];
}

/** A copy of `value` without the field at `where`. */
function without(value: unknown, where: readonly Step[]): unknown {
  const copy = structuredClone(value);
  let node: unknown = copy;
  for (const step of where.slice(0, -1)) {
    node = Array.isArray(node) ? node[Number(step)] : (node as Record<string, unknown>)[String(step)];
  }
  Reflect.deleteProperty(node as object, String(must(where.at(-1))));
  return copy;
}

/** The required fields whose removal the validator still accepts: none, for a schema that is not vacuous. */
function vacuousPaths(validate: ValidateFunction, value: unknown, paths: readonly Step[][]): string[] {
  return paths.filter((where) => validate(without(value, where))).map((where) => where.join("."));
}

const exchangePlace = (entry: FixtureEntry): Place => ({
  id: idOf(entry.version),
  pointer: entry.def === undefined ? "" : `/$defs/${escapeStep(entry.def)}`,
});

// Read while the file loads, so the branch validators are compiled before any test runs.
const REQUIRED = new Map(
  acceptedEntries.map((entry) => [entry.file, requiredPaths(exchangePlace(entry), fixture(entry.file))]),
);
const requiredNames = (file: string): string[] =>
  must(REQUIRED.get(file), `the required fields of ${file}`).map((where) => where.join("."));

/**
 * A damaged copy of v1's commitTurn.exchange whose turn no longer requires `tries`, compiled while the file loads: v1
 * under an $id of its own beside the real files, so its $refs resolve, with one field fewer in turn's `required`.
 */
function damagedWithoutTries(): ValidateFunction {
  const damaged = structuredClone(must(schemaById.get(idOf("v1"))));
  const turn = must((damaged.$defs as Record<string, { required: string[] } | undefined>).turn);
  turn.required = turn.required.filter((field) => field !== "tries");
  const damagedId = `${ID_BASE}data-access/damaged-for-test.schema.json`;
  damaged.$id = damagedId;
  const loose = new Ajv2020({ strict: true, strictRequired: false });
  for (const schema of schemaById.values()) loose.addSchema(structuredClone(schema));
  loose.addSchema(damaged);
  return must(loose.getSchema(`${damagedId}#/$defs/commitTurn.exchange`), "the damaged commitTurn.exchange");
}
const withoutTries = damagedWithoutTries();

describe("data-access fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${entry.version})`, () => {
      const validate = validatorFor(entry);
      const original = fixture(entry.file) as Record<string, unknown>;
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const required = must(REQUIRED.get(entry.file));
      const names = required.map((where) => where.join("."));
      expect(names, "the exchange's own fields and its given's").toEqual(
        expect.arrayContaining([
          "call",
          "given",
          "request",
          "outcome",
          "given.k04Seeds",
          "given.after",
          "given.now",
        ]),
      );
      expect(required.length, "fields below the exchange's own").toBeGreaterThan(7);
      expect(
        names.some((name) => name.startsWith("outcome.")),
        "the outcome's own fields",
      ).toBe(true);
      if (isRecord(original.request) && Object.keys(original.request).length > 0) {
        expect(
          names.some((name) => name.startsWith("request.")),
          "the request's own fields",
        ).toBe(true);
      }
      expect(vacuousPaths(validate, original, required), "each removed, the copy must be refused").toEqual(
        [],
      );
      expect(validate({ ...original, notInTheSchema: 1 }), "a field the exchange does not know").toBe(false);
      for (const part of ["given", "request", "outcome"]) {
        const inner = original[part];
        if (!isRecord(inner)) continue;
        expect(
          validate({ ...original, [part]: { ...inner, notInTheSchema: 1 } }),
          `an unknown ${part} field`,
        ).toBe(false);
      }
    });
  }

  it("takes the required fields from the schema's own lists, through $ref, allOf, anyOf, oneOf, if and dependentRequired", () => {
    const commit = requiredNames("commit-first.json");
    expect(commit).toEqual(
      expect.arrayContaining([
        "request.turn.tries",
        "request.writes.outboxRows.1.sendClass",
        "request.writes.events.0.actorPersonId",
        "request.writes.reservations.confirm.0.bookingId",
        "outcome.committed.promoted",
        "outcome.committed.written.2.version",
      ]),
    );
    expect(commit, "an optional field").not.toContain("given.note");
    expect(commit, "a field inside a free object").not.toContain("request.writes.state.0.values.id");
    const safety = requiredNames("mark-safety-failed-other-way.json");
    expect(safety).toEqual(
      expect.arrayContaining([
        "request.followUps",
        "request.events",
        "request.followUps.0.why",
        "request.followUps.0.row.channel",
        "request.events.0.proofs",
        "outcome.followUpRows.0.commitSeq",
      ]),
    );
    expect(safety, "optional in a failed mark").not.toContain("request.providerMessageId");
    expect(requiredNames("arm-clock.json"), "oneOf: a clock row named by its question").toContain(
      "request.openQuestionId",
    );
    const claim = requiredNames("claim-in-order-with-port.json");
    expect(claim).toEqual(expect.arrayContaining(["outcome.claimed.0.parts.0.idempotencyKey"]));
    expect(claim, "v1.2's port, which a v1 or v1.1 answer leaves out").not.toContain(
      "outcome.claimed.0.port",
    );
  });

  it("has the check fire on a schema that requires nothing, and on one that stops requiring a single field", () => {
    const entry = entryOf("commit-first.json");
    const original = fixture(entry.file);
    const required = must(REQUIRED.get(entry.file));
    expect(vacuousPaths(validatorFor(entry), original, required)).toEqual([]);
    expect(vacuousPaths(branchAjv.compile({}), original, required)).toEqual(
      required.map((where) => where.join(".")),
    );
    expect(vacuousPaths(withoutTries, original, required)).toEqual(["request.turn.tries"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What the schema leaves to the fixtures, read from them

// What the checks read. Every accepted fixture is checked against its schema first (part 1), so a cast to this shape
// reads only fields the schema requires.
interface Given {
  k04Seeds: string[];
  partSeeds?: string[];
  after: string[];
  now: string;
  note?: string;
}
interface Exchange {
  call: string;
  given: Given;
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}
const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;

/** The accepted seed files of a database part's fixtures/index.json (none for a part with no index). */
function acceptedSeeds(part: string): Set<string> {
  const file = path.join(DB_SCHEMA_DIR, part, "fixtures", "index.json");
  if (!existsSync(file)) return new Set();
  const listed = readJson(file) as { fixtures: FixtureEntry[] };
  return new Set(listed.fixtures.filter((entry) => entry.expect === "accept").map((entry) => entry.file));
}
const coreSeeds = acceptedSeeds("core");

/**
 * README "Fixtures": `given` names K-04's seed fixtures, other parts' seeds as <part>/<file>, and this folder's
 * exchanges that run first, in order, each with its own given. Each must exist and be accepted, and an exchange run
 * first is of the same version or an earlier one, so a version's fixtures never wait on a later version's.
 */
export function givenProblems(file: string, given: Given): string[] {
  const problems: string[] = [];
  const version = entryOf(file).version;
  for (const name of given.after) {
    const before = entries.find((candidate) => candidate.file === name);
    if (name === file) problems.push(`after names ${name}, the fixture itself`);
    else if (before === undefined) problems.push(`after names ${name}, which the index does not list`);
    else if (before.expect !== "accept") problems.push(`after names ${name}, a refused fixture`);
    else if (!atOrBefore(before.version, version)) {
      problems.push(`after names ${name}, of ${before.version}, later than ${version}`);
    }
  }
  for (const seed of given.k04Seeds) {
    if (!coreSeeds.has(seed)) problems.push(`k04Seeds names ${seed}, which is no accepted K-04 seed`);
  }
  for (const seed of given.partSeeds ?? []) {
    const [part, name] = seed.split("/");
    if (part === undefined || name === undefined || !acceptedSeeds(part).has(name)) {
      problems.push(`partSeeds names ${seed}, which is no accepted seed of that part`);
    }
  }
  return problems;
}

/** Each loop in the chains of exchanges run first, from each of `files`. */
export function loopsIn(afterOf: (name: string) => readonly string[], files: readonly string[]): string[] {
  const done = new Set<string>();
  const problems: string[] = [];
  const visit = (name: string, trail: readonly string[]): void => {
    if (trail.includes(name)) {
      problems.push(`the chain loops: ${[...trail, name].join(" -> ")}`);
      return;
    }
    if (done.has(name)) return;
    for (const before of afterOf(name)) visit(before, [...trail, name]);
    done.add(name);
  };
  for (const file of files) visit(file, []);
  return problems;
}

interface Promotion {
  reservationId: string;
  savedTimeClockId: string;
}
interface ClaimedRow {
  outboxRowId: string;
  parts: { partNo: number; tryNo: number; idempotencyKey: string }[];
}
interface ClaimedEffect {
  effect: { effectId: string };
  version: number;
  event?: { id: string; rowId: string | null };
}
interface Marked {
  result: string;
  outboxRowId: string;
  partNo: number;
  tryNo: number;
  nextKey: string | null;
}

/**
 * README items 3, 4, 8, 9, 25 and 33: the ids a call makes are fixed by rule. A part's key is <row>/<part>/<try> and a
 * failure's next key the try after it; a held or promoted saved time's clock row is <reservation id>/saved-time; the
 * "all set" row is <first failed row id>/all-set; a claim's entry is <effect id>/claimed/<version after the claim>.
 */
export function idProblems(exchange: Exchange): string[] {
  const problems: string[] = [];
  const { call, request, outcome } = exchange;
  const savedTime = (promotion: Promotion, where: string): void => {
    const rule = `${promotion.reservationId}/saved-time`;
    if (promotion.savedTimeClockId !== rule) {
      problems.push(`${where}: the saved-time clock row is ${promotion.savedTimeClockId}, not ${rule}`);
    }
  };
  if (call === "reserve" && outcome.result === "held")
    savedTime(outcome as unknown as Promotion, "the held time");
  if (call === "release" && isRecord(outcome.promoted)) {
    savedTime(outcome.promoted as unknown as Promotion, "the next in line");
  }
  if ((call === "commitTurn" || call === "fireClock") && isRecord(outcome.committed)) {
    (outcome.committed.promoted as Promotion[]).forEach((promotion, at) => {
      savedTime(promotion, `promoted ${String(at)}`);
    });
  }
  if (call === "claimOutbox" && Array.isArray(outcome.claimed)) {
    for (const row of outcome.claimed as ClaimedRow[]) {
      for (const part of row.parts) {
        const rule = `${row.outboxRowId}/${String(part.partNo)}/${String(part.tryNo)}`;
        if (part.idempotencyKey !== rule)
          problems.push(`a claimed part's key is ${part.idempotencyKey}, not ${rule}`);
      }
    }
  }
  if (call === "markPart" && outcome.result === "marked") {
    const marked = outcome as unknown as Marked;
    const rule = `${marked.outboxRowId}/${String(marked.partNo)}/${String(marked.tryNo + 1)}`;
    if (marked.nextKey !== null && marked.nextKey !== rule)
      problems.push(`the next key is ${marked.nextKey}, not ${rule}`);
  }
  if (call === "writeAllSet") {
    const rule = `${must((request.failedRowIds as string[])[0])}/all-set`;
    const row = request.row as { id: string };
    if (row.id !== rule) problems.push(`the all-set row is ${row.id}, not ${rule}`);
    if (outcome.result === "written" && (outcome.outboxRow as { id: string }).id !== row.id) {
      problems.push(`the row written is not the all-set row ${row.id}`);
    }
  }
  if ((call === "claimEffects" || call === "serviceBack") && Array.isArray(outcome.claimed)) {
    for (const claimed of outcome.claimed as ClaimedEffect[]) {
      if (claimed.event === undefined) continue;
      const rule = `${claimed.effect.effectId}/claimed/${String(claimed.version)}`;
      if (claimed.event.id !== rule) problems.push(`the claim's entry is ${claimed.event.id}, not ${rule}`);
      if (claimed.event.rowId !== claimed.effect.effectId) {
        problems.push(
          `the claim's entry names the row ${String(claimed.event.rowId)}, not ${claimed.effect.effectId}`,
        );
      }
    }
  }
  return problems;
}

const PHONE = /(?<![A-Za-z0-9])\+\d{8,15}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** README "Fixtures" (BP rule 9): phone numbers are in the 555-01xx range; the email domain is example.com. */
export function castProblems(value: unknown, where = ""): string[] {
  const below = (step: string | number): string => (where === "" ? String(step) : `${where}.${String(step)}`);
  if (Array.isArray(value)) return value.flatMap((item: unknown, at) => castProblems(item, below(at)));
  if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => castProblems(item, below(key)));
  if (typeof value !== "string") return [];
  const problems: string[] = [];
  for (const [phone] of value.matchAll(PHONE)) {
    if (!/^\+1\d{3}55501\d{2}$/.test(phone)) problems.push(`${where}: ${phone} is not in the 555-01xx range`);
  }
  for (const [email] of value.matchAll(EMAIL)) {
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    if (domain !== "example.com" && !domain.endsWith(".example.com")) {
      problems.push(`${where}: ${email} is not at example.com`);
    }
  }
  return problems;
}

describe("data-access fixtures: what the schema leaves to the fixtures, each check also shown firing", () => {
  it("has every given name fixtures and seeds that exist: accepted fixtures of its own version or an earlier one, accepted seeds", () => {
    for (const entry of acceptedEntries) {
      expect(givenProblems(entry.file, exchangeOf(entry.file).given), entry.file).toEqual([]);
    }
    expect(
      acceptedEntries.filter((entry) => exchangeOf(entry.file).given.after.length > 0).length,
    ).toBeGreaterThan(0);
    expect(
      acceptedEntries.filter((entry) => (exchangeOf(entry.file).given.partSeeds ?? []).length > 0).length,
    ).toBeGreaterThan(0);
  });

  it("has no loop in any chain of exchanges run first", () => {
    const afterOf = (name: string): string[] => exchangeOf(name).given.after;
    expect(
      loopsIn(
        afterOf,
        acceptedEntries.map((entry) => entry.file),
      ),
    ).toEqual([]);
  });

  it("has the given checks fire on a damaged copy", () => {
    const file = "commit-first.json";
    const given = exchangeOf(file).given;
    expect(givenProblems(file, { ...given, after: ["no-such-exchange.json"] })).toEqual([
      "after names no-such-exchange.json, which the index does not list",
    ]);
    expect(givenProblems(file, { ...given, after: [file] })).toEqual([
      `after names ${file}, the fixture itself`,
    ]);
    expect(givenProblems(file, { ...given, after: ["invalid/refuse-turn-fourth-try.json"] })).toEqual([
      "after names invalid/refuse-turn-fourth-try.json, a refused fixture",
    ]);
    expect(givenProblems(file, { ...given, after: ["claim-dee.json"] })).toEqual([
      "after names claim-dee.json, of v1.1, later than v1",
    ]);
    expect(givenProblems(file, { ...given, k04Seeds: ["seed-no-such-row.json"] })).toEqual([
      "k04Seeds names seed-no-such-row.json, which is no accepted K-04 seed",
    ]);
    expect(
      givenProblems(file, { ...given, partSeeds: ["conversations-consent/seed-no-such-row.json"] }),
    ).toEqual([
      "partSeeds names conversations-consent/seed-no-such-row.json, which is no accepted seed of that part",
    ]);
    const chains: Record<string, string[]> = {
      "a.json": ["b.json"],
      "b.json": ["a.json"],
      "c.json": ["b.json"],
    };
    expect(loopsIn((name) => chains[name] ?? [], ["a.json", "c.json"])).toEqual([
      "the chain loops: a.json -> b.json -> a.json",
    ]);
  });

  it("has every id a call makes by rule as the README fixes it: a part's key and the next, a saved time's clock row, the all set row, a claim's entry", () => {
    for (const entry of acceptedEntries) expect(idProblems(exchangeOf(entry.file)), entry.file).toEqual([]);
    const calls = new Set(acceptedEntries.map((entry) => exchangeOf(entry.file).call));
    for (const call of [
      "reserve",
      "release",
      "claimOutbox",
      "markPart",
      "writeAllSet",
      "claimEffects",
      "serviceBack",
    ]) {
      expect(calls, call).toContain(call);
    }
  });

  it("has the id checks fire on a damaged copy", () => {
    const held = exchangeOf("reserve-10-min.json");
    held.outcome.savedTimeClockId = "clock-rsv-alex-riley-nov14";
    expect(idProblems(held)).toEqual([
      "the held time: the saved-time clock row is clock-rsv-alex-riley-nov14, not rsv-alex-riley-nov14/saved-time",
    ]);
    const promoted = exchangeOf("release-expired-promotes.json");
    (promoted.outcome.promoted as Promotion).savedTimeClockId = "rsv-alex-saved-avery/saved-time";
    expect(idProblems(promoted)).toEqual([
      "the next in line: the saved-time clock row is rsv-alex-saved-avery/saved-time, not rsv-agent-waiting-avery/saved-time",
    ]);
    const claimed = exchangeOf("claim-lapsed-reclaimed.json");
    must((claimed.outcome.claimed as ClaimedRow[])[0]?.parts[0]).idempotencyKey = "out-alex-booked-riley/1/1";
    expect(idProblems(claimed)).toEqual([
      "a claimed part's key is out-alex-booked-riley/1/1, not out-alex-booked-riley/1/2",
    ]);
    const marked = exchangeOf("mark-failed-retry-after.json");
    marked.outcome.nextKey = "out-alex-booked-riley/1/1";
    expect(idProblems(marked)).toEqual([
      "the next key is out-alex-booked-riley/1/1, not out-alex-booked-riley/1/2",
    ]);
    const allSet = exchangeOf("write-all-set.json");
    (allSet.request.row as { id: string }).id = "out-alex-all-set";
    expect(idProblems(allSet)).toEqual([
      "the all-set row is out-alex-all-set, not out-alex-booked-riley/all-set",
      "the row written is not the all-set row out-alex-all-set",
    ]);
    const logged = exchangeOf("claim-effects-logged.json");
    const event = must(must((logged.outcome.claimed as ClaimedEffect[])[0]).event);
    event.id = "eff-cal-riley-alex-nov14-write/claimed/1";
    event.rowId = "eff-other";
    expect(idProblems(logged)).toEqual([
      "the claim's entry is eff-cal-riley-alex-nov14-write/claimed/1, not eff-cal-riley-alex-nov14-write/claimed/2",
      "the claim's entry names the row eff-other, not eff-cal-riley-alex-nov14-write",
    ]);
  });

  it("has every phone number in the 555-01xx range and every email address at example.com (rule 9)", () => {
    for (const entry of entries) expect(castProblems(fixture(entry.file)), entry.file).toEqual([]);
    const text = entries.map((entry) => JSON.stringify(fixture(entry.file))).join("\n");
    expect([...text.matchAll(PHONE)].length, "the fixtures hold phone numbers").toBeGreaterThan(0);
  });

  it("has the cast check fire on a damaged copy", () => {
    expect(castProblems({ for: { phoneNumber: "+15555550200" } })).toEqual([
      "for.phoneNumber: +15555550200 is not in the 555-01xx range",
    ]);
    expect(castProblems({ note: "her mobile is +12025550143, not +12025551234." })).toEqual([
      "note: +12025551234 is not in the 555-01xx range",
    ]);
    expect(castProblems({ handle: { address: "alex@example.org" } })).toEqual([
      "handle.address: alex@example.org is not at example.com",
    ]);
    expect(castProblems({ address: "alex@reply.example.com", base64: "bm90+12345678901x" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. v1.5's rowReader: README item 44 (T-1188, folded into T-1169 by DL-373)

const ROW_READER = "rowReader.exchange";
const rowReaderErrors = must(
  errorsAjv.getSchema(`${idOf("v1.5")}#/$defs/${ROW_READER}`),
  "v1.5's rowReader.exchange",
);
const RULE_PATH = /\/dependentSchemas\/outcome\/allOf\/(\d+)\//;

/** The rules of rowReader.exchange (its dependentSchemas on outcome, allOf by number) a value breaks, none when valid. */
export function rulesBroken(value: unknown): number[] {
  if (rowReaderErrors(value)) return [];
  const rules = (rowReaderErrors.errors ?? []).flatMap((error) => {
    const match = RULE_PATH.exec(error.schemaPath);
    return match === null ? [] : [Number(match[1])];
  });
  return [...new Set(rules)].sort((a, b) => a - b);
}

/**
 * T-1184's security note b, three rules no fixture shows (DL-370): each case is row-reader-s1-02-no-role.json, Sam with
 * no role on S1-02's section 1 line to the owner, read as the owner by the sign-up line, with one fault in its request.
 * Each is refused by the one rule its fault breaks (rowReader.exchange's allOf, by number) and accepted once its outcome
 * is put right: the fault is in the reading, not in the row.
 */
const SIGN_UP_CASES: readonly { name: string; fault: Change[]; rule: number; putRight: Change[] }[] = [
  {
    name: "a row with no person read as the owner (README default 64: no person is no one's own sign-up)",
    fault: [{ at: "request.recipient.personId", to: null }],
    rule: 1,
    putRight: [
      { at: "outcome", to: { error: "noReader", outboxRowId: "outbox-s1-02-sam-1", why: "noRole" } },
    ],
  },
  {
    name: "lineTo null read as the owner (README default 62: a line that cannot be told without a role has no reader)",
    fault: [{ at: "request.lineTo", to: null }],
    rule: 6,
    putRight: [
      {
        at: "outcome",
        to: { error: "noReader", outboxRowId: "outbox-s1-02-sam-1", why: "lineHasNoReader" },
      },
    ],
  },
  {
    name: "a cust line read as the owner (README item 44: the line's lane names the reader, cust the customer)",
    fault: [{ at: "request.lineTo", to: "cust" }],
    rule: 5,
    putRight: [{ at: "outcome.reader", to: "customer" }],
  },
];

describe("data-access v1.5: rowReader reads each row as README item 44 says, and refuses three faults no fixture shows", () => {
  const exchange = validatorOf("v1.5", ROW_READER);
  const noRole = "row-reader-s1-02-no-role.json";
  const owner = "row-reader-s1-02-owner.json";
  const tomas = "row-reader-a5-05-tomas-no-role.json";

  it("reads the three accepted rows as the README says: S1-02 with no role as the owner, the section 5 row noReader, a held role first", () => {
    for (const file of [noRole, owner, tomas]) {
      const entry = entryOf(file);
      expect([entry.version, entry.def, entry.expect], file).toEqual(["v1.5", ROW_READER, "accept"]);
      expect(exchange(fixture(file)), `${file}: ${formatErrors(exchange.errors).join("; ")}`).toBe(true);
      expect(rulesBroken(fixture(file)), file).toEqual([]);
    }
    // Sam holds no role, S1-02 is on section 1 of flow A and its line goes to the owner: the owner, by the sign-up line.
    expect(fromFixture(noRole, "request.recipient")).toEqual({ personId: "person-sam", roles: [] });
    expect([fromFixture(noRole, "request.section"), fromFixture(noRole, "request.lineTo")]).toEqual([
      1,
      "owner",
    ]);
    expect(fromFixture(noRole, "outcome")).toEqual({
      result: "reader",
      outboxRowId: "outbox-s1-02-sam-1",
      reader: "owner",
      from: "signUpLine",
      roleId: null,
    });
    // Tomás holds no role at the barbershop and A5-05 is on section 5: refused, never read as the customer by the line.
    expect(fromFixture(tomas, "request.recipient")).toEqual({ personId: "person-tomas", roles: [] });
    expect([fromFixture(tomas, "request.section"), fromFixture(tomas, "request.lineTo")]).toEqual([
      5,
      "cust",
    ]);
    expect(fromFixture(tomas, "outcome")).toEqual({
      error: "noReader",
      outboxRowId: "outbox-a5-05-tomas-1",
      why: "noRole",
    });
    // The same row with Sam's owner role: read by the role, though the line would read him as the owner too.
    expect(fromFixture(owner, "outcome")).toEqual({
      result: "reader",
      outboxRowId: "outbox-s1-02-sam-1",
      reader: "owner",
      from: "roles",
      roleId: "role-sam-barber",
    });
    expect(differences(fromFixture(noRole, "request"), fromFixture(owner, "request"))).toEqual([
      "recipient.roles",
    ]);
    expect(differences(fromFixture(noRole, "outcome"), fromFixture(owner, "outcome"))).toEqual([
      "from",
      "roleId",
    ]);
  });

  for (const { name, fault, rule, putRight } of SIGN_UP_CASES) {
    it(`refuses ${name} by rule ${String(rule)} alone; with its outcome put right, it is accepted`, () => {
      const twin = fixture(noRole);
      const faulty = changed(twin, fault);
      expect(differences(twin, faulty), "the case is its accepted twin with one fault").toEqual(
        fault.map((change) => change.at),
      );
      expect(exchange(faulty), "the case as it stands").toBe(false);
      expect(rulesBroken(faulty), "the one rule its fault breaks").toEqual([rule]);
      expect(fromFixture(noRole, "outcome"), "still read as the owner by the line").toEqual(
        valueAt(faulty, "outcome"),
      );
      const right = changed(faulty, putRight);
      expect(exchange(right), `put right: ${formatErrors(exchange.errors).join("; ")}`).toBe(true);
      expect(rulesBroken(right)).toEqual([]);
    });
  }

  it("has the rule check fire: the accepted twin breaks none, and the two refused fixtures each break their own", () => {
    expect(rulesBroken(fixture(noRole))).toEqual([]);
    expect(rulesBroken(fixture("invalid/refuse-row-reader-role-read-by-line.json"))).toEqual([0]);
    expect(rulesBroken(fixture("invalid/refuse-row-reader-no-role-outside-section-1.json"))).toEqual([2]);
    // A case put right by a wrong reader is still refused, by the same rule.
    const cust = must(SIGN_UP_CASES[2]);
    const wrong = changed(changed(fixture(noRole), cust.fault), [{ at: "outcome.reader", to: "staff" }]);
    expect(rulesBroken(wrong)).toEqual([cust.rule]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. v1.7's openChatOnText: each answer and its entry named by the request's text (README item 46; T-1214)

/** The fields of a phone.chat_opened entry that name its text (chatOpenedEvent; K-08 v1 why.provider_event). */
interface ChatOpenedEntry {
  id: string;
  rowId: string;
  why: { provider_event: { provider: string; event_id: string } };
}

/**
 * README item 46 ("The transaction" step 4, "The entry"): each answer names the request's handle, and the
 * phone.chat_opened entry an answer appends is the request's text's: its id '<event id>/chat-opened', its row the
 * request's handle (K-08 v1 default 3) and its why Linq's event, the request's. The schema leaves these to code, as it
 * leaves a claim entry's id (item 33; chatOpenedEvent's description).
 */
export function chatEntryProblems(exchange: Exchange): string[] {
  if (exchange.call !== "openChatOnText") return [];
  const { request, outcome } = exchange;
  const problems: string[] = [];
  const handleId = String(request.handleId);
  if (typeof outcome.handleId === "string" && outcome.handleId !== handleId) {
    problems.push(`the answer names the handle ${outcome.handleId}, not ${handleId}`);
  }
  if (!isRecord(outcome.event)) return problems;
  const event = outcome.event as unknown as ChatOpenedEntry;
  const eventId = String(request.eventId);
  const rule = `${eventId}/chat-opened`;
  if (event.id !== rule) problems.push(`the chat-opened entry is ${event.id}, not ${rule}`);
  if (event.rowId !== handleId)
    problems.push(`the chat-opened entry names the row ${event.rowId}, not ${handleId}`);
  if (event.why.provider_event.event_id !== eventId) {
    problems.push(`the chat-opened entry's why is ${event.why.provider_event.event_id}, not ${eventId}`);
  }
  return problems;
}

describe("data-access v1.7: openChatOnText's answer and its entry are the request's text's, as README item 46 says", () => {
  const opens = acceptedEntries.filter((entry) => exchangeOf(entry.file).call === "openChatOnText");

  it("names each answer's handle, and each chat-opened entry by the request's event and handle: its id, row and why", () => {
    expect(opens.length).toBeGreaterThan(0);
    for (const entry of opens) expect(chatEntryProblems(exchangeOf(entry.file)), entry.file).toEqual([]);
    const appending = opens
      .map((entry) => exchangeOf(entry.file).outcome)
      .filter((outcome) => isRecord(outcome.event))
      .map((outcome) => String(outcome.result));
    expect(
      [...new Set(appending)].sort(),
      "the answers that append an entry, each shown: an insert and an opening",
    ).toEqual(["inserted", "opened"]);
    // The refused opening of Ben T.'s stopped chat names its entry by rule: it is refused for its stopped alone (part 2).
    expect(chatEntryProblems(exchangeOf("invalid/refuse-open-chat-stopped-number.json"))).toEqual([]);
  });

  it("has the check fire on a damaged copy: another handle, another entry id, another row, another event", () => {
    const first = exchangeOf("open-chat-first-text-sam.json");
    expect(chatEntryProblems(first)).toEqual([]);
    first.outcome.handleId = "handle-alex";
    const event = first.outcome.event as ChatOpenedEntry;
    event.id = "evt-sam-s1-02/chat-opened";
    event.rowId = "handle-alex";
    event.why.provider_event.event_id = "evt-sam-s1-02";
    expect(chatEntryProblems(first)).toEqual([
      "the answer names the handle handle-alex, not handle-sam",
      "the chat-opened entry is evt-sam-s1-02/chat-opened, not evt-sam-s1-01/chat-opened",
      "the chat-opened entry names the row handle-alex, not handle-sam",
      "the chat-opened entry's why is evt-sam-s1-02, not evt-sam-s1-01",
    ]);
    const email = exchangeOf("open-chat-apple-id-email.json");
    email.outcome.handleId = "handle-sam";
    expect(chatEntryProblems(email)).toEqual([
      "the answer names the handle handle-sam, not handle-sam-email",
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
 * contracts/data-access/README.md "Producers and consumers" (02-contracts K-05), every version's lines: one side per
 * owner, each component under the owner the README names for it. Each side is added later by a QA side task that
 * depends on this task and on that side's build task: it fills `check` (and moves its own test beside this one). Until
 * then the side is held here with what it must show, so none is forgotten.
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-database",
    side: "producer",
    owner: "database engineer",
    components: [
      "C-152 data-access calls",
      "C-135 double-booking guard",
      "C-151 migrating K-07's schema addition",
    ],
    needs:
      "02-contracts K-05 \"Contract test\" and section 2 item 12, against local PostgreSQL with K-04 v1 migrated (K-07 v1's schema addition with it for v1.1, migrated by C-151; K-29 v1 and the other parts' seeds for v1.2's reads): each accepted fixture's request, run after its given (its k04Seeds and partSeeds loaded, each with its own after chain; its after exchanges run first, in order; the database's now() at given.now), gives its outcome, commitSeq values compared by their order, not their numbers; each refused fixture is refused and nothing is written; 1,000 parallel reserve calls on one slot give exactly one success (BP section 10, card T-041); a repeated commit writes nothing twice; parallel claims never hand one row to two senders. The README plans v1.1's database side as T-116 and v1.2's as T-478, on the database engineer's builds of C-152 (T-219 readTurnState; T-220 handleTargets, sendState and handleSealingKey; T-667 the setup-part facts readTurnState reads; and the tasks that build claimOutbox's port, markPart by key, renewClaim's phone read and the claim entries): 50 parallel first sights of one number give one handle, one person and one key (T-220); readTurnState with businessId null returns no row that has a business, a booking, a role, a pause, an open question or a consent row of a business included (T-219, T-478); and T-478 seeds a private booking, a deceased booking and a paused row, which no fixture sets, so sendState's record flags are tested. v1.3's three turn-face reads (T-1138, db/repo/turn-face-reads.ts: readOpenHolds as rosie_app, readOutboxRow and readFixedLineFacts as rosie_job after requireBusinessScope()) and v1.4's seven safety reads (T-1161, db/repo/safety-reads.ts: the record reads and the zone as rosie_app, readBusinessOwner as rosie_job) run in data-access.v1.db-side.test.ts (T-1169): every v1.3 and v1.4 fixture, selected by its version, through db/repo in its role against local PostgreSQL, each accepted request giving its outcome, valid at its own version; each refused request refused before any statement reaches the database; each refused answer answered put right in its twin's state. v1.5 adds no database call. v1.6's businessSensitive on readOutboxRow (T-1197, db/repo/turn-face-reads.ts: company_kinds' two switch lists read in the call's own transaction as rosie_job under the row's business, true, false or null by README item 45) runs there too (T-1199): its three fixtures through db/repo, the practice's five rows written as its note lists them, since no frozen seed holds a sensitive kind of work; each earlier readOutboxRow answer is its fixture's outcome with businessSensitive null and nothing else changed (no seed of an earlier exchange holds a kind of work), valid at v1.6's readOutboxRow.v1dot6Response; and readOutboxRow.v1dot6Response is a refused answer's definition. v1.7's openChatOnText (T-1212, db/repo/chat-open.ts: item 46's one transaction as rosie_job with no business scope, a number's phone row and its one phone.chat_opened entry) runs there too (T-1214): every v1.7 fixture through db/repo after its given (Dee W.'s after v1.1's commit, plan, claim and waiting chat, each through db/repo, the claim answered as v1.2 answers it, each row's port added by its channel, never a field dropped), each accepted request giving its outcome, valid at v1.7, the row an answer gives and the one entry it appends being what the tables then hold, and nothing written where it appends none; each refused request refused before any statement reaches the database; and refuse-open-chat-stopped-number's text, in its own given, answered as its twin open-chat-ben-stopped answers it, nothing written. v1.8's sendState with item 47's fromContact and bookingId (T-1216, db/repo/send-state.ts: the covering texts consent row picked as v1.2 picks it, by default 35, then its channel, turn_id, handle_id and booking_id and its turn's handle_id, read in sendState's one read-only transaction as rosie_job with no business scope) runs there too (T-1218): every v1.8 fixture through db/repo after its given, the chains running v1's reserve, plan and claim steps as well as commitTurn, each answering its own fixture's outcome (the claim through K-05 v1's own claimOutbox, which answers v1's claimed rows, and after the held reserve the saved-time clock row item 8 gives it, which db/repo's reserve does not write yet); each accepted request giving its outcome, valid at v1.8, each sendState answer valid at sendState.v1dot8Response, fromContact and bookingId always stated; and each refused answer (who gave the yes left out, its booking left out, a STOP read as the person's own yes) answered put right in its twin's state.",
  },
  {
    id: "consumer-action-layer",
    side: "consumer",
    owner: "action-layer engineer",
    components: [
      "C-087 one commit per turn",
      "C-075 frontier builder",
      "C-100 reservations",
      "C-134 saved-time rules",
      "C-109 effects runner",
      "C-112 reconciliation job",
      "C-074 Tool API turn face",
      "C-090 compose input",
      "C-093 the finalize call",
      "C-089 the fixed-line inserter",
      "C-104 the safety and hand-offs service",
    ],
    needs:
      "Accepts every valid fixture and refuses every invalid one, each at the newest frozen minor version its task needs: the commit sends one commitTurn per turn, takes versionChanged and reservationLost as limits 4 and 5 and a repeat as the first commit, and from v1.1 writes its effects and the waiting rows it ends (C-087); reserve, release and extend as the reservation and saved-time rules use them: at most two saved times, a third refused with each one's end, the next in line promoted with its own saved-time clock row, one extension and never for the customer's own AI (C-100, C-134); the effects runner claims, records each try with its effect.result entry and runs an effect in outage once more after serviceBack on the same key, with the claim entries from v1.2 (C-109, at least v1.1); the reconciliation writes only a stripe_refund (C-112, at least v1.1); the frontier and the Tool API turn face read readTurnState under one business, unknownFact and notFound failing closed (C-075, C-074: T-315). From v1.3 the Tool API turn face (C-074) binds, in T-1141, readOpenHolds behind the commit's openHolds, naming the turn's unread texts and cutting each hold to K-09 safetyHold's three fields (C-087), readOutboxRow behind compose input's and finalize's readRow, refusing a row whose line is null and in finalize a question with no clock row, the flow read by item 35's rule (default 53), the words of answered texts only those the runtime hands in (C-090, C-093: T-313's port), and readFixedLineFacts behind the fixed-line inserter's readFixedLines (C-089: T-314's port), mapping fixedLineRow to the call's fixed-line refusal. From v1.4 the safety and hand-offs service (C-104, T-318) reads the seven safety reads as its SafetyReader through runCore (C-087, T-1140), bound by T-1141 on the call's own transaction and business, each answer handed on in the port's own shape, notFound, moreThanOneOwner and transient mapped to a thrown error that fails closed, never to null or false, and arrivedAt answering null until T-1155. From v1.5 compose input's ComposeRow.role and finalize's FinalizeRow.reader map the reader by item 44 exactly as the rowReader fixtures read (T-1141's round 2): a held role first; with none, the line's audience only for a person on a section 1 step whose line goes to owner, staff or cust; noReader otherwise, never written, cached or passed on as a role. From v1.6 the same row ports fill SlotSource.sensitive from readOutboxRow's businessSensitive for a row about no booking (C-074, C-090, C-093: T-1190): null and a missing field read as on, only false is off, a row about a booking stays on, and a read that fails fails the call, never read as off (README item 45, default 67).",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components: [
      "C-050 bundle pin",
      "C-054 clock rows, alarm and sweep",
      "C-055 clock arming",
      "C-124 outbox dispatcher",
      "C-125 limit 8",
      "C-126 channel fallback",
      "C-127 two-part send",
      "C-180 crash in the middle of a turn",
      "C-044 gateway",
      "C-174 to C-176 outage paths",
      "C-051 guard",
      "C-046 actor",
    ],
    needs:
      "Accepts every valid fixture and refuses every invalid one: the bundle pin reads the active bundle and a value on a KV miss, with the actor and the frontier from the Tool API (C-050, C-046: T-557); clock rows arm at the first delivery receipt, the alarm and the sweep read the due rows, and each fires once, with a firing's effects (C-054, C-055); the dispatcher claims each recipient's rows in commit order, renews before each part, marks parts and rows, gives up after 15 minutes with the next way or the owner's number and writes the one all set, reading the claimed row's port and renewClaim's recipient, and treats a renewal with no recipient as unreadable and sends nothing, never as not stopped (C-124, C-125, C-126, C-127: T-562); a third crash before the commit parks the turn (C-180); the gateway records a provider event once and takes a handle's key from handleSealingKey as a key object that cannot be exported, never as bytes, as the actor does to open the sealed texts, with newHandleId and newPersonId new on every call, never built from the address (C-044, C-046: T-553); the outage paths call serviceBack (C-174 to C-176); the guard maps handleTargets to its targets (C-051: T-556). From v1.7 the gateway calls openChatOnText at receipt, once for each text or photo from a phone handle, after handleSealingKey and before the actor's accept, with the key call's handle id and the event's id, service, receivedAt and trace, never the number and never for an email handle, a reaction, a vote, an edit or a receipt; it answers 503 on transient, nothing stored, and stores the text on notFound or notAPhone (C-044: T-1213); the dispatcher's chat check and limit 8 then find that number's chat open, with nothing of theirs to change (C-124, C-125). From v1.8 the dispatcher's send-state port (runtime/src/wiring/real.ts sendStateOf, T-562) maps textsConsent's fromContact and bookingId across unchanged when the answer holds them and leaves them out when it does not, never deriving stopped, or its end, from textsConsent (STATE note 10); limit 8 reads them as its yesAfterStop does: a yes lifts a stop for a row only when fromContact is true and the yes is newer than the stop, for every row when it names no business (START), else only for a row about the booking it names, and a missing field is not known and lifts nothing; through the port and limit 8, send-state-stop-row and send-state-own-yes-one-booking drop their row, and send-state-business-yes and send-state-own-start let it on to the other checks (C-124, C-125: T-1217).",
  },
  {
    id: "consumer-release",
    side: "consumer",
    owner: "release engineer",
    components: ["C-020 deploy script"],
    needs:
      "Accepts every valid fixture and refuses every invalid one: the deploy script writes the bundle's copy with publishBundleCopy, then at step 3 switches with setActiveBundle, compared against the active id it read, and rolls back with setActiveBundle and the earlier id (BP 5.4; NQ-PB-5).",
  },
  {
    id: "consumer-frontend",
    side: "consumer",
    owner: "frontend engineer",
    components: ['C-203 fake clock "Fire now"'],
    needs:
      'Accepts every valid fixture and refuses every invalid one: staging\'s "Fire now" reaches fireClock with by fireNow through K-21 and the Tool API, firing a row before its due time on staging alone (BP 9.4).',
  },
];

const readme = readFileSync(path.join(DATA_ACCESS_DIR, "README.md"), "utf8");
const sectionStart = readme.indexOf("## Producers and consumers");
const sectionEnd = readme.indexOf("\n## ", sectionStart + 1);
const section = readme.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);
const sectionLines = section.split("\n");

/**
 * A version's own list of consumers, the README's "### Consumers of <version>" (v1.3 on), up to the next heading, or ""
 * for a version with none. The section's line for that version points to it: "Section "v1.3", "Consumers of v1.3",
 * lists every consumer port with what each must hold to; that list joins this section with QA's v1.3 contract test task".
 * Until the architect moves it there, this file reads it where it stands, as part of the section.
 */
function consumersListOf(version: string): string {
  const heading = `\n### Consumers of ${version}\n`;
  const start = readme.indexOf(heading);
  if (start < 0) return "";
  const rest = readme.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}
/** The section with each written-for version's own list of consumers: every producer and consumer the README names. */
const producersAndConsumers = [section, ...WRITTEN_FOR.map(consumersListOf)].join("\n");

/** The index of the parenthesis that closes the one opened at `open`. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  throw new Error(`no closing parenthesis in ${text}`);
}

/** Splits `text` at each `separator` outside parentheses. */
function splitOutside(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")") depth -= 1;
    else if (depth === 0 && text.startsWith(separator, at)) {
      parts.push(text.slice(from, at));
      from = at + separator.length;
      at = from - 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** The end of the clause that starts at `from`: the first ";" or sentence-ending "." outside parentheses. */
function clauseEnd(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (
      depth === 0 &&
      (char === ";" || (char === "." && (at + 1 === text.length || text[at + 1] === " ")))
    ) {
      return at;
    }
  }
  return text.length;
}

interface OwnerGroup {
  owner: string;
  text: string;
}

/**
 * A version's consumers line, "- **Consumers** (...): <owner>: <components>; <owner>: ..." for v1 and
 * "- **v1.1's consumers** (...): ..." for a minor version, as owner groups, up to the line's own **Producer:** note.
 */
function consumerGroups(version: string): OwnerGroup[] {
  const lead = version === "v1" ? "- **Consumers**" : `- **${version}'s consumers**`;
  const line = must(
    sectionLines.find((text) => text.startsWith(lead)),
    `the README's ${lead} line`,
  );
  let rest = line.slice(lead.length);
  if (rest.startsWith(" (")) rest = rest.slice(closingParen(rest, 1) + 1);
  if (!rest.startsWith(": ")) throw new Error(`the README's ${lead} line lists no owner`);
  rest = rest.slice(2);
  const producer = rest.indexOf(" **Producer:**");
  const list = (producer < 0 ? rest : rest.slice(0, producer)).replace(/[.]$/, "");
  return splitOutside(list, "; ").map((group) => {
    const at = group.indexOf(": ");
    if (at < 0) throw new Error(`an owner group with no owner: ${group}`);
    return { owner: group.slice(0, at), text: group.slice(at + 2) };
  });
}

const LIST_BULLET = /^- \*\*([^*]+)\*\*(.*)$/;

/**
 * A version's own list of consumers (consumersListOf) as owner groups: each bullet whose bold name is an owner, such as
 * "- **Action-layer engineer:** C-087 ..." or "- **Database engineer**, the producer: C-152 ...", the owner in lower
 * case; a bullet that names a task ("- **T-1141** names ...", what a consumer must hold to) is not a group.
 */
function listGroups(version: string): OwnerGroup[] {
  return consumersListOf(version)
    .split("\n")
    .flatMap((line) => {
      const match = LIST_BULLET.exec(line);
      if (match === null) return [];
      const owner = must(match[1]).replace(/:$/, "").toLowerCase();
      return /^T-\d+$/i.test(owner) ? [] : [{ owner, text: must(match[2]) }];
    });
}

/** A version's owner groups: its own list of consumers when it has one (v1.3 on), else its line of the section. */
const groupsOf = (version: string): OwnerGroup[] =>
  consumersListOf(version) === "" ? consumerGroups(version) : listGroups(version);

/** "the <owner>'s C-xxx" in a version's line of the section: each component the line ties to an owner by name. */
function ownedMentions(version: string): { owner: string; id: string }[] {
  const lead = `- **${version}'s consumers**`;
  const line = must(
    sectionLines.find((text) => text.startsWith(lead)),
    `the README's ${lead} line`,
  );
  return [...line.matchAll(/\bthe ([a-z][a-z-]*(?: [a-z][a-z-]*)*)'s (C-\d{3})/g)].map((match) => ({
    owner: must(match[1]),
    id: must(match[2]),
  }));
}

/** Each "**Producer:** <owner>: <components>" or "<owner>, <components>" note of the section, to its clause's end. */
function producerNotes(): OwnerGroup[] {
  const mark = "**Producer:** ";
  const notes: OwnerGroup[] = [];
  for (const line of sectionLines) {
    for (let at = line.indexOf(mark); at >= 0; at = line.indexOf(mark, at + 1)) {
      const start = at + mark.length;
      const clause = line.slice(start, clauseEnd(line, start));
      const split = /[:,] /.exec(clause);
      if (split === null) throw new Error(`a producer note with no owner: ${clause}`);
      notes.push({ owner: clause.slice(0, split.index), text: clause.slice(split.index + 2) });
    }
  }
  return notes;
}

/** The component ids a text names, a range such as "C-174 to C-176" counted as each id in it. */
function componentIds(text: string): string[] {
  return [...text.matchAll(/C-(\d{3})(?: to C-(\d{3}))?/g)].flatMap((match) => {
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    return Array.from({ length: to - from + 1 }, (_, step) => `C-${String(from + step).padStart(3, "0")}`);
  });
}
const taskIds = (text: string): string[] => [...text.matchAll(/T-\d{3,4}/g)].map((match) => match[0]);

describe("data-access sides: the list where each producer and consumer side is added", () => {
  const held = (side: SideCheck): string[] => componentIds(side.components.join(" "));
  const sideOf = (kind: SideCheck["side"], owner: string): SideCheck | undefined =>
    SIDE_CHECKS.find((side) => side.side === kind && side.owner === owner);
  const producer = must(SIDE_CHECKS.find((side) => side.side === "producer"));

  it("names each side once, with the producer and consumers of the README", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(1);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(4);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components.length, side.id).toBeGreaterThan(0);
      expect(side.needs, side.id).not.toBe("");
      if (side.side === "consumer") expect(side.needs, side.id).toMatch(/refuses every invalid/i);
    }
  });

  it("carries the README's contract test in the producer's needs", () => {
    const plain = readme.replaceAll("`", "");
    for (const clause of [
      "gives its outcome",
      "1,000 parallel reserve calls on one slot give exactly one success",
      "a repeated commit writes nothing twice",
      "parallel claims never hand one row to two senders",
    ]) {
      expect(plain, clause).toContain(clause);
      expect(producer.needs, clause).toContain(clause);
    }
  });

  it("reads each version's own list of consumers that the section points to, with the section", () => {
    for (const version of WRITTEN_FOR) {
      const line = must(
        sectionLines.find((text) =>
          text.startsWith(version === "v1" ? "- **Consumers**" : `- **${version}'s consumers**`),
        ),
        `the README's consumers line of ${version}`,
      );
      const pointed = line.includes(`"Consumers of ${version}"`);
      expect(consumersListOf(version) !== "", `${version}: its line points to its own list`).toBe(pointed);
    }
    expect(
      WRITTEN_FOR.filter((version) => consumersListOf(version) !== "").length,
      "the versions with a list of their own",
    ).toBeGreaterThan(0);
  });

  it("names every component the README's producers and consumers name, and no other", () => {
    expect(sectionStart).toBeGreaterThan(-1);
    const named = new Set(componentIds(producersAndConsumers));
    expect(named.size).toBeGreaterThan(20);
    expect([...new Set(SIDE_CHECKS.flatMap(held))].sort()).toEqual([...named].sort());
    for (const id of ["C-089", "C-090", "C-093", "C-104"]) expect([...named], id).toContain(id);
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) {
      expect(section, side.id).toContain(side.owner);
      for (const component of side.components) expect(producersAndConsumers, side.id).toContain(component);
    }
  });

  it("puts each component under its own owner, in each version's consumers line or list and each producer note", () => {
    const allHeld = SIDE_CHECKS.flatMap(held);
    for (const version of WRITTEN_FOR) {
      const groups = groupsOf(version);
      expect(groups.length, version).toBeGreaterThan(0);
      for (const group of groups) {
        const ids = componentIds(group.text);
        // v1.2's line lists the database engineer's own builds of C-152, the producer's component.
        const side = sideOf("consumer", group.owner) ?? sideOf("producer", group.owner);
        if (side !== undefined) {
          for (const id of ids) expect(held(side), `${version}: ${group.owner}`).toContain(id);
        } else if (group.owner.toLowerCase() === "qa") {
          // QA's own list line names the components its contract test adds to this side list.
          for (const id of ids) expect(allHeld, `${version}: QA adds ${id} to the side list`).toContain(id);
        } else {
          expect(ids, `${version}: ${group.owner} names tasks only`).toEqual([]);
        }
      }
      if (consumersListOf(version) === "") continue;
      // From v1.3 the section's line names each owner's component in prose: "the action-layer engineer's C-087".
      const mentions = ownedMentions(version);
      expect(mentions.length, `${version}: the section's line ties components to owners`).toBeGreaterThan(0);
      for (const { owner, id } of mentions) {
        const side = must(
          sideOf("consumer", owner) ?? sideOf("producer", owner),
          `${version}: the side of ${owner}`,
        );
        expect(held(side), `${version}: the ${owner}'s ${id}`).toContain(id);
      }
    }
    const owners = WRITTEN_FOR.flatMap((version) => groupsOf(version).map((group) => group.owner));
    for (const side of SIDE_CHECKS.filter((each) => each.side === "consumer")) {
      expect(owners, `${side.id}'s owner is a consumer the README names`).toContain(side.owner);
    }
    const notes = producerNotes();
    const listedProducer = WRITTEN_FOR.filter(
      (version) =>
        consumersListOf(version) !== "" &&
        listGroups(version).some((group) => group.owner === producer.owner),
    );
    expect(notes.length + listedProducer.length).toBeGreaterThanOrEqual(WRITTEN_FOR.length);
    for (const note of notes) {
      expect(note.owner).toBe(producer.owner);
      for (const id of componentIds(note.text)) expect(held(producer), note.text).toContain(id);
    }
  });

  it("carries in each side's needs every task the README names for it, and covers here the fixture parts it says", () => {
    const allNeeds = SIDE_CHECKS.map((side) => side.needs).join(" ");
    for (const version of WRITTEN_FOR) {
      for (const group of groupsOf(version)) {
        const side = sideOf("consumer", group.owner) ?? sideOf("producer", group.owner);
        for (const task of taskIds(group.text)) {
          if (COVERED_HERE.includes(task)) continue;
          expect(side?.needs ?? allNeeds, `${version}: ${group.owner}: ${task}`).toContain(task);
        }
      }
    }
    for (const note of producerNotes()) {
      for (const task of taskIds(note.text)) expect(producer.needs, task).toContain(task);
    }
    const named = WRITTEN_FOR.flatMap((version) => groupsOf(version).flatMap((group) => taskIds(group.text)));
    for (const task of COVERED_HERE) expect(named, task).toContain(task);
    // The producer's database side of v1.3, v1.4, v1.6, v1.7 and v1.8 names the builds it runs, beside this file.
    for (const task of ["T-1138", "T-1161", "T-1197", "T-1212", "T-1216"]) {
      expect(producer.needs, task).toContain(task);
    }
    expect(producer.needs).toContain("data-access.v1.db-side.test.ts");
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
