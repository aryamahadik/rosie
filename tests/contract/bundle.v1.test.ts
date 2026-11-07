// Contract test for K-01 v1, the step-graph bundle format (T-080; ops/plan/02-contracts.md K-01 "Contract test" and
// section 2 item 12; contracts/bundle/README.md "Producers and consumers").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed fixtures, and
// one part per producer or consumer side, added later by a QA side task that depends on this task and on that side's
// build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// What this part proves:
//   1. every fixture in contracts/bundle/fixtures/index.json is checked against its schema or $defs entry (the T-003
//      harness): accepted ones are accepted, refused ones are refused, none is left out;
//   2. the schema is not vacuous: removing any one required field from a copy of an accepted fixture makes the copy
//      refused;
//   3. what the schema cannot check and the fixtures can show (the README's list): each judgment rule 1 to 67 once
//      and every step's judgmentRules number resolving to one; each any-time row once; each fixed-line id once;
//      the group 11 markers; every input listed; the bundle id's hash and each stored value's size and hash
//      recomputed; every journey step a step of a flow of the same bundle, and every failingSteps id one of its
//      journey's steps; the lint marks agreeing with the manifest's lint summary; the shared lists agreeing across
//      fixtures. Each check is also run on a damaged copy to show that it fires.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here (a lookup's field sourced on every
//   path and a loop across steps are the compiler's own lint: C-065 to C-070).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, describeContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The fixtures

const BUNDLE_DIR = path.join(CONTRACTS_ROOT, "bundle");
const FIXTURES_DIR = path.join(BUNDLE_DIR, "fixtures");
const SCHEMA_FILE = "bundle.v1.schema.json";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));

/** A value a fixture must hold; the fixtures are checked against the schema first, so a miss is a broken test. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("a fixture lacks a value this test reads");
  return value;
}
const acceptedBundles = ["bundle-v0-skeleton.json", "bundle-mini-a.json", "bundle-mini-b.json"] as const;

// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes
// reads only fields the schema requires.
interface Journey {
  journey: number;
  steps: string[];
  ships: boolean;
  failingSteps: string[];
}
interface LintFailure {
  rule: string;
  flow: string | null;
  step: string | null;
  trade: string | null;
}
interface LintReport {
  rules: { rule: string; failures: number }[];
  failures: LintFailure[];
}
interface StoredValue {
  key: string;
  kind: string;
  flow?: string;
  trade?: string;
  bytes: number;
  sha256: string;
}
interface Input {
  kind: string;
  path: string;
  sha256: string;
  trade?: string;
}
interface Lists {
  keywords: unknown;
  fixedLines: { lines: { id: string }[] };
  keyMap: unknown;
  outOfScope: { markers: { component: string }[] };
}
interface Manifest {
  bundleId: { hash: string; build: number };
  inputs: Input[];
  lint: LintReport;
  journeys: Journey[];
  storage: { manifestKey: string; values: StoredValue[] };
  lists: Lists;
  partial?: boolean;
}
interface Step {
  id: string;
  lint: string[];
  judgmentRules?: number[];
}
interface Flow {
  flow: string;
  sections: { n: number; steps: string[] }[];
  steps: Record<string, Step>;
  routing: {
    judgmentRules: { rules: { number: number; text: string; step: string }[] };
    anytime: { rows: { row: string; order: number; handler: string | null }[] };
  };
}
interface Trade {
  trade: { id: string };
}
interface Bundle {
  manifest: Manifest;
  flows: Record<string, Flow>;
  trades: Record<string, Trade>;
}

const bundleFixture = (file: string): Bundle => fixture(file) as Bundle;
const miniA = bundleFixture("bundle-mini-a.json");
const miniB = bundleFixture("bundle-mini-b.json");
/** manifest.json is the manifest of a bundle holding the two sample flow graphs and the barber overlay (its `shows`). */
const manifestFixture = fixture("manifest.json") as Manifest;
const manifestHolds = { flows: { ...miniA.flows, ...miniB.flows }, trades: { ...miniA.trades } };

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** A value as the compiler stores it: minified JSON in UTF-8 (contracts/bundle/README.md, Storage). */
const stored = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------------------------------------------
// Checks that read only fixtures. Each returns one line per problem; an empty list means the check holds.

/** The steps a journey may name: the steps the flows hold, and for a partial bundle the master's ids its sections list. */
function stepsOfFlows(flows: Record<string, Flow>, partial: boolean): Set<string> {
  const known = new Set<string>();
  for (const flow of Object.values(flows)) {
    for (const id of Object.keys(flow.steps)) known.add(id);
    if (partial) for (const section of flow.sections) for (const id of section.steps) known.add(id);
  }
  return known;
}

const STEP_ID = /^[A-Z]\d+-[A-Za-z0-9]+$/;

/** README: every journey step is a step of a flow of the same bundle; every failingSteps id is one of its journey's steps. */
export function checkJourneys(manifest: Manifest, flows: Record<string, Flow>): string[] {
  const problems: string[] = [];
  const known = stepsOfFlows(flows, manifest.partial === true);
  const failed = new Set(
    manifest.lint.failures.flatMap((failure) => (failure.step === null ? [] : [failure.step])),
  );
  const numbers = new Set<number>();
  for (const journey of manifest.journeys) {
    const label = `journey ${String(journey.journey)}`;
    if (numbers.has(journey.journey)) problems.push(`${label} is listed twice`);
    numbers.add(journey.journey);
    for (const id of journey.steps) {
      if (known.has(id)) continue;
      // A partial bundle holds a few steps and lists only the master's top-level ids in its sections: a step that the
      // master nests inside a branch (such as S1-03, S1-23) cannot be resolved from the fixture alone. For those the
      // check holds the id to a step id's shape; the whole check (every id a step of a flow) is for a full bundle, which
      // holds every step: the producer side (SIDE_CHECKS, producer-compiler) runs it on the compiler's output.
      if (manifest.partial === true && STEP_ID.test(id)) continue;
      problems.push(`${label} lists ${id}, which is a step of no flow in the bundle`);
    }
    const own = new Set(journey.steps);
    for (const id of journey.failingSteps) {
      if (!own.has(id)) problems.push(`${label} lists failing step ${id}, which is not one of its steps`);
    }
    // The compiler fills failingSteps from the journey's steps and the lint (README, Journey membership).
    const expected = journey.steps.filter((id) => failed.has(id)).sort();
    const actual = [...journey.failingSteps].sort();
    if (!isDeepStrictEqual(expected, actual)) {
      problems.push(
        `${label} lists failing steps [${actual.join(", ")}], but the lint fails [${expected.join(", ")}] among its steps`,
      );
    }
  }
  return problems;
}

/** MC R6: the 67 judgment rules, each number once and in order, and every step's pointers resolving to one. */
export function checkJudgmentRules(flow: Flow): string[] {
  const problems: string[] = [];
  const numbers = flow.routing.judgmentRules.rules.map((rule) => rule.number);
  const wanted = Array.from({ length: 67 }, (_, i) => i + 1);
  if (!isDeepStrictEqual(numbers, wanted)) {
    problems.push(
      `flow ${flow.flow}: the judgment rules are not 1 to 67 once each, in order (${numbers.join(",")})`,
    );
  }
  const known = new Set(numbers);
  for (const rule of flow.routing.judgmentRules.rules) {
    if (rule.text.trim() === "" || rule.step === "")
      problems.push(`flow ${flow.flow}: rule ${String(rule.number)} has no text or step`);
  }
  for (const [id, step] of Object.entries(flow.steps)) {
    if (step.id !== id)
      problems.push(`flow ${flow.flow}: step ${id} is stored under another id (${step.id})`);
    for (const number of step.judgmentRules ?? []) {
      if (!known.has(number))
        problems.push(
          `flow ${flow.flow}: ${id} points to judgment rule ${String(number)}, which resolves to none`,
        );
    }
  }
  return problems;
}

/** Q-40: the 21 any-time rows, each once, in turn order 1 to 21. */
export function checkAnytime(flow: Flow): string[] {
  const problems: string[] = [];
  const rows = flow.routing.anytime.rows;
  if (rows.length !== 21) problems.push(`flow ${flow.flow}: ${String(rows.length)} any-time rows, not 21`);
  const names = rows.map((row) => row.row);
  if (new Set(names).size !== names.length)
    problems.push(`flow ${flow.flow}: an any-time row is listed twice`);
  const orders = rows.map((row) => row.order);
  if (
    !isDeepStrictEqual(
      orders,
      Array.from({ length: rows.length }, (_, i) => i + 1),
    )
  ) {
    problems.push(
      `flow ${flow.flow}: the any-time rows are not in turn order 1 to ${String(rows.length)} once each`,
    );
  }
  return problems;
}

/** Each fixed-line id once. */
export function checkFixedLines(lists: Lists): string[] {
  const ids = lists.fixedLines.lines.map((line) => line.id);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  return twice.map((id) => `fixed line ${id} is listed twice`);
}

/** Group 11 (01-inventory.md): markers C-222 to C-254, each once; a full bundle has all 33. */
export function checkOutOfScope(manifest: Manifest): string[] {
  const problems: string[] = [];
  const components = manifest.lists.outOfScope.markers.map((marker) => marker.component);
  const seen = new Set<string>();
  for (const component of components) {
    const n = /^C-(\d{3})$/.exec(component)?.[1];
    if (n === undefined || Number(n) < 222 || Number(n) > 254) {
      problems.push(`marker ${component} is not a group 11 component (C-222 to C-254)`);
    }
    if (seen.has(component)) problems.push(`marker ${component} is listed twice`);
    seen.add(component);
  }
  if (manifest.partial !== true) {
    for (let n = 222; n <= 254; n += 1) {
      if (!seen.has(`C-${String(n)}`)) problems.push(`a full bundle has no marker for C-${String(n)}`);
    }
  }
  return problems;
}

/** Every input listed: the flows and trades the bundle holds (a full bundle: 2 flows and 243 trades), MC, LINES.md, fixture set v1's manifest. */
export function checkInputs(
  manifest: Manifest,
  flows: Record<string, Flow>,
  trades: Record<string, Trade>,
): string[] {
  const problems: string[] = [];
  const count = (kind: string): number => manifest.inputs.filter((input) => input.kind === kind).length;
  for (const kind of ["masterCorrections", "lines", "fixtureSetManifest"]) {
    if (count(kind) !== 1) problems.push(`the inputs list ${kind} ${String(count(kind))} times, not once`);
  }
  for (const input of manifest.inputs) {
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) problems.push(`input ${input.path} has no sha256`);
  }
  const flowInputs = manifest.inputs
    .filter((input) => input.kind === "masterFlow")
    .map((input) => /master-([AB])\.json$/.exec(input.path)?.[1] ?? input.path)
    .sort();
  const tradeInputs = manifest.inputs
    .filter((input) => input.kind === "trade")
    .map((input) => input.trade ?? input.path);
  const heldFlows = Object.keys(flows).sort();
  const heldTrades = Object.keys(trades).sort();
  if (!isDeepStrictEqual(flowInputs, heldFlows)) {
    problems.push(
      `the flow inputs [${flowInputs.join(", ")}] are not the flows held [${heldFlows.join(", ")}]`,
    );
  }
  if (!isDeepStrictEqual([...tradeInputs].sort(), heldTrades)) {
    problems.push(`the trade inputs are not the trades the bundle holds [${heldTrades.join(", ")}]`);
  }
  if (manifest.partial !== true) {
    if (!isDeepStrictEqual(heldFlows, ["A", "B"])) problems.push("a full bundle holds both flows, A and B");
    if (heldTrades.length !== 243) {
      problems.push(`a full bundle holds 243 trades, not ${String(heldTrades.length)}`);
    }
  }
  return problems;
}

/** README, Storage: the keys, each value's size and hash, and the bundle id's hash recomputed from `storage.values`. */
export function checkStorage(
  manifest: Manifest,
  flows: Record<string, Flow>,
  trades: Record<string, Trade>,
): string[] {
  const problems: string[] = [];
  const { hash, build } = manifest.bundleId;
  const prefix = `bundle/${hash}/${String(build)}/`;
  if (manifest.storage.manifestKey !== `${prefix}manifest`) {
    problems.push(`the manifest key is ${manifest.storage.manifestKey}, not ${prefix}manifest`);
  }
  const held = new Map<string, unknown>();
  for (const [id, flow] of Object.entries(flows)) held.set(`flow/${id}`, flow);
  for (const [id, trade] of Object.entries(trades)) held.set(`trade/${id}`, trade);
  const seen = new Set<string>();
  const lines: { part: string; sha: string }[] = [];
  for (const value of manifest.storage.values) {
    if (!value.key.startsWith(prefix)) {
      problems.push(`${value.key} is not under ${prefix}`);
      continue;
    }
    const part = value.key.slice(prefix.length);
    if (seen.has(part)) problems.push(`${part} is stored twice`);
    seen.add(part);
    lines.push({ part, sha: value.sha256 });
    const named =
      value.kind === "flow"
        ? `flow/${value.flow ?? ""}`
        : value.kind === "trade"
          ? `trade/${value.trade ?? ""}`
          : "";
    if (part !== named) problems.push(`${value.key} does not match its kind ${value.kind} and id`);
    if (!held.has(part)) {
      problems.push(`${part} is stored but the bundle holds no such value`);
      continue;
    }
    const text = stored(held.get(part));
    const bytes = new TextEncoder().encode(text).length;
    if (value.bytes !== bytes) {
      problems.push(`${part}: stored as ${String(value.bytes)} bytes, the value is ${String(bytes)}`);
    }
    if (value.sha256 !== sha256Hex(text)) problems.push(`${part}: its sha256 is not the value's`);
  }
  for (const part of held.keys()) {
    if (!seen.has(part)) problems.push(`${part} is in the bundle but not in storage.values`);
  }
  const text = lines
    .sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0))
    .map((line) => `${line.sha}  ${line.part}\n`)
    .join("");
  if (sha256Hex(text) !== hash)
    problems.push("the bundle id's hash is not the sha256 of the sorted value lines");
  return problems;
}

/** The manifest's lint summary and the steps' own `lint` marks tell the same story. */
export function checkLintMarks(report: LintReport, flows: Record<string, Flow> = {}): string[] {
  const problems: string[] = [];
  const names = report.rules.map((rule) => rule.rule);
  if (new Set(names).size !== names.length) problems.push("a lint rule is summarised twice");
  for (const rule of report.rules) {
    const listed = report.failures.filter((failure) => failure.rule === rule.rule).length;
    if (rule.failures !== listed)
      problems.push(`rule ${rule.rule} counts ${String(rule.failures)} failures but lists ${String(listed)}`);
  }
  for (const failure of report.failures) {
    if (!names.includes(failure.rule))
      problems.push(`a failure names rule ${failure.rule}, which the summary lacks`);
    const step =
      failure.trade === null && failure.flow !== null && failure.step !== null
        ? flows[failure.flow]?.steps[failure.step]
        : undefined;
    if (step !== undefined && !step.lint.includes(failure.rule)) {
      problems.push(
        `${String(failure.step)} is reported failing ${failure.rule}, but its own lint does not list it`,
      );
    }
  }
  for (const [flowId, flow] of Object.entries(flows)) {
    for (const [id, step] of Object.entries(flow.steps)) {
      for (const rule of step.lint) {
        const reported = report.failures.some(
          (failure) =>
            failure.rule === rule && failure.flow === flowId && failure.step === id && failure.trade === null,
        );
        if (!reported)
          problems.push(`${id} of flow ${flowId} lists ${rule}, which the summary does not report`);
      }
    }
  }
  return problems;
}

/** The shared lists, and the parts of the flow and trade, are the same value in the bundle and in their own fixture. */
export function checkSharedFixtures(manifest: Manifest): string[] {
  const problems: string[] = [];
  const same: [string, unknown, string][] = [
    ["keywords", manifest.lists.keywords, "keywords.json"],
    ["fixedLines", manifest.lists.fixedLines, "fixed-lines.json"],
    ["keyMap", manifest.lists.keyMap, "key-map.json"],
    ["outOfScope", manifest.lists.outOfScope, "out-of-scope-c9-first-texts.json"],
  ];
  for (const [name, inBundle, file] of same) {
    if (!isDeepStrictEqual(inBundle, fixture(file)))
      problems.push(`lists.${name} differs from fixtures/${file}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The schema, one validator for everything (the harness's strict Ajv 2020-12 setup)

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const folder of [path.join(CONTRACTS_ROOT, "common"), BUNDLE_DIR]) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".schema.json"))
      ajv.addSchema(readJson(path.join(folder, entry.name)) as object);
  }
}
const schema = readJson(path.join(BUNDLE_DIR, SCHEMA_FILE)) as {
  $id: string;
  required: string[];
  $defs: Record<string, { required?: string[] }>;
};

function validatorFor(entry: FixtureEntry): ValidateFunction {
  const validate = ajv.getSchema(`${schema.$id}${entry.def === undefined ? "" : `#/$defs/${entry.def}`}`);
  if (validate === undefined) throw new Error(`no schema for ${entry.file}`);
  return validate;
}

function requiredOf(entry: FixtureEntry): string[] {
  const node = entry.def === undefined ? schema : schema.$defs[entry.def];
  return node?.required ?? [];
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked by the T-003 harness

const report = describeContractFixtures("bundle");

describe("bundle.v1 fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(index.fixtures.length).toBeGreaterThan(0);
    expect(report.entries).toHaveLength(index.fixtures.length);
    expect(report.seedRows).toBe(0);
    expect(report.passes + report.refusals).toBe(index.fixtures.length);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse", () => {
    expect(report.passes).toBe(index.fixtures.filter((entry) => entry.expect === "accept").length);
    expect(report.refusals).toBe(index.fixtures.filter((entry) => entry.expect === "refuse").length);
    for (const result of report.entries) {
      expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
    }
  });

  it("holds the accepted bundles, manifest and shared lists, and refused steps and a refused journey gate", () => {
    const files = index.fixtures.map((entry) => entry.file);
    for (const file of [...acceptedBundles, "manifest.json", "lint-report.json"])
      expect(files).toContain(file);
    expect(index.fixtures.some((entry) => entry.expect === "refuse")).toBe(true);
    expect(index.fixtures.every((entry) => entry.version === "v1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The schema is not vacuous

describe("bundle.v1 fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of index.fixtures.filter((candidate) => candidate.expect === "accept")) {
    it(`${entry.file}${entry.def === undefined ? " (the whole bundle)" : ` (${entry.def})`}`, () => {
      const validate = validatorFor(entry);
      const original = fixture(entry.file) as Record<string, unknown>;
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const required = requiredOf(entry);
      expect(required.length, "the schema requires at least one field here").toBeGreaterThan(0);
      for (const field of required) {
        expect(field in original, `${entry.file} has the required field ${field}`).toBe(true);
        const copy = Object.fromEntries(
          Object.entries(structuredClone(original)).filter(([key]) => key !== field),
        );
        expect(validate(copy), `${entry.file} without ${field} must be refused`).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. What the schema cannot check, read from the fixtures

describe("bundle.v1 fixtures: the sample bundles", () => {
  for (const file of acceptedBundles) {
    const bundle = bundleFixture(file);
    describe(file, () => {
      it("is a partial bundle that holds the flows and trades under their own ids", () => {
        expect(bundle.manifest.partial).toBe(true);
        for (const [id, flow] of Object.entries(bundle.flows)) expect(flow.flow).toBe(id);
        for (const [id, trade] of Object.entries(bundle.trades)) expect(trade.trade.id).toBe(id);
      });
      it("has each judgment rule 1 to 67 once and every step's pointers resolving", () => {
        for (const flow of Object.values(bundle.flows)) expect(checkJudgmentRules(flow)).toEqual([]);
      });
      it("has each of the 21 any-time rows once", () => {
        for (const flow of Object.values(bundle.flows)) expect(checkAnytime(flow)).toEqual([]);
      });
      it("has each fixed-line id once", () => {
        expect(checkFixedLines(bundle.manifest.lists)).toEqual([]);
      });
      it("has only group 11 markers, each once", () => {
        expect(checkOutOfScope(bundle.manifest)).toEqual([]);
      });
      it("lists every input it was built from", () => {
        expect(checkInputs(bundle.manifest, bundle.flows, bundle.trades)).toEqual([]);
      });
      it("has a bundle id, value sizes and hashes that recompute from the values", () => {
        expect(checkStorage(bundle.manifest, bundle.flows, bundle.trades)).toEqual([]);
      });
      it("has a journey step in a flow of the bundle and a failing step in its journey", () => {
        expect(checkJourneys(bundle.manifest, bundle.flows)).toEqual([]);
      });
      it("has lint marks that agree with the manifest's lint summary", () => {
        expect(checkLintMarks(bundle.manifest.lint, bundle.flows)).toEqual([]);
      });
      it("has shared lists equal to the shared-list fixtures", () => {
        expect(checkSharedFixtures(bundle.manifest)).toEqual([]);
      });
    });
  }

  it("holds the same 67 judgment rules in both flows", () => {
    const a = must(miniA.flows.A).routing.judgmentRules;
    const b = must(miniB.flows.B).routing.judgmentRules;
    expect(b).toEqual(a);
    expect(a).toEqual(fixture("judgment-rules.json"));
  });

  it("holds the any-time table, the barber overlay and the shared lists of the stand-alone fixtures", () => {
    expect(must(miniA.flows.A).routing.anytime).toEqual(fixture("anytime-table.json"));
    expect(miniA.trades.barber).toEqual(fixture("trade-overlay.json"));
    expect(miniB.trades.barber).toEqual(fixture("trade-overlay.json"));
  });
});

describe("bundle.v1 fixtures: manifest.json, the manifest of the two sample flows and the barber overlay", () => {
  const { flows, trades } = manifestHolds;
  it("holds the shared-list fixtures", () => {
    expect(checkSharedFixtures(manifestFixture)).toEqual([]);
    expect(checkFixedLines(manifestFixture.lists)).toEqual([]);
    expect(checkOutOfScope(manifestFixture)).toEqual([]);
  });
  it("lists every input", () => {
    expect(checkInputs(manifestFixture, flows, trades)).toEqual([]);
  });
  it("has a bundle id, value sizes and hashes that recompute from the two flows and the overlay", () => {
    expect(checkStorage(manifestFixture, flows, trades)).toEqual([]);
  });
  it("lists journey steps that are steps of those flows, and failing steps that are its journey's", () => {
    expect(manifestFixture.journeys.length).toBeGreaterThan(0);
    expect(checkJourneys(manifestFixture, flows)).toEqual([]);
  });
  it("has lint marks that agree with the held steps", () => {
    expect(checkLintMarks(manifestFixture.lint, flows)).toEqual([]);
  });
});

describe("bundle.v1 fixtures: lint-report.json", () => {
  it("counts the failures it lists, rule by rule", () => {
    expect(checkLintMarks(fixture("lint-report.json") as LintReport)).toEqual([]);
  });
});

// Each check above, run on a damaged copy of a sample: a check that never fires proves nothing.
describe("bundle.v1 fixtures: each check fires on a damaged copy", () => {
  const damaged = (): Bundle => structuredClone(miniA);
  const flowA = (bundle: Bundle): Flow => must(bundle.flows.A);
  const journey1 = (bundle: Bundle): Journey => must(bundle.manifest.journeys[0]);
  const stepS137 = (bundle: Bundle): Step => must(flowA(bundle).steps["S1-37"]);

  it("journeys: a step of no flow, a failing step outside its journey, a failing step left out", () => {
    const unknown = damaged();
    journey1(unknown).steps.push("not a step");
    expect(checkJourneys(unknown.manifest, unknown.flows)).toEqual([
      "journey 1 lists not a step, which is a step of no flow in the bundle",
    ]);

    // A full bundle holds every step: an id no flow holds is refused, and a partial bundle's tolerance ends.
    const absent = damaged();
    delete absent.manifest.partial;
    journey1(absent).steps.push("S9-99");
    const absentLines = checkJourneys(absent.manifest, absent.flows);
    expect(absentLines).toContain("journey 1 lists S9-99, which is a step of no flow in the bundle");
    expect(absentLines).toContain("journey 1 lists S1-03, which is a step of no flow in the bundle");

    const outside = damaged();
    journey1(outside).failingSteps.push("S2-02");
    expect(checkJourneys(outside.manifest, outside.flows).join("\n")).toContain(
      "failing step S2-02, which is not one of its steps",
    );

    const left = damaged();
    journey1(left).failingSteps = [];
    expect(checkJourneys(left.manifest, left.flows).join("\n")).toContain("but the lint fails [S1-37]");
  });

  it("judgment rules: a missing rule, a repeated rule, a pointer that resolves to none", () => {
    const missing = damaged();
    flowA(missing).routing.judgmentRules.rules.pop();
    expect(checkJudgmentRules(flowA(missing))).not.toEqual([]);

    const twice = damaged();
    const rules = flowA(twice).routing.judgmentRules.rules;
    rules[5] = { ...must(rules[4]) };
    expect(checkJudgmentRules(flowA(twice))).not.toEqual([]);

    const pointer = damaged();
    stepS137(pointer).judgmentRules = [68];
    expect(checkJudgmentRules(flowA(pointer)).join("\n")).toContain(
      "points to judgment rule 68, which resolves to none",
    );
  });

  it("any-time rows: a missing row, a repeated row, a repeated turn order", () => {
    const missing = damaged();
    flowA(missing).routing.anytime.rows.pop();
    expect(checkAnytime(flowA(missing)).join("\n")).toContain("20 any-time rows, not 21");

    const twice = damaged();
    const rows = flowA(twice).routing.anytime.rows;
    rows[3] = { ...must(rows[2]), order: 4 };
    expect(checkAnytime(flowA(twice)).join("\n")).toContain("an any-time row is listed twice");

    const order = damaged();
    must(flowA(order).routing.anytime.rows[3]).order = 3;
    expect(checkAnytime(flowA(order)).join("\n")).toContain("not in turn order");
  });

  it("fixed lines: a repeated id", () => {
    const bundle = damaged();
    const lines = bundle.manifest.lists.fixedLines.lines;
    lines[1] = { ...must(lines[1]), id: must(lines[0]).id };
    expect(checkFixedLines(bundle.manifest.lists)).toEqual(["fixed line opener is listed twice"]);
  });

  it("group 11 markers: one outside C-222 to C-254, a repeat, and a full bundle with markers missing", () => {
    const bundle = damaged();
    const markers = bundle.manifest.lists.outOfScope.markers;
    markers.push({ ...must(markers[0]), component: "C-999" });
    markers.push({ ...must(markers[0]) });
    const lines = checkOutOfScope(bundle.manifest);
    expect(lines).toContain("marker C-999 is not a group 11 component (C-222 to C-254)");
    expect(lines).toContain("marker C-252 is listed twice");

    const full = damaged();
    delete full.manifest.partial;
    expect(checkOutOfScope(full.manifest)).toContain("a full bundle has no marker for C-222");
  });

  it("inputs: a missing flow input, a missing trade input, no Master Corrections, a bad hash", () => {
    const bundle = damaged();
    bundle.manifest.inputs = bundle.manifest.inputs.filter(
      (input) => !["masterFlow", "trade", "masterCorrections"].includes(input.kind),
    );
    const lines = checkInputs(bundle.manifest, bundle.flows, bundle.trades).join("\n");
    expect(lines).toContain("masterCorrections 0 times");
    expect(lines).toContain("flow inputs [] are not the flows held [A]");
    expect(lines).toContain("trade inputs are not the trades the bundle holds [barber]");

    const hash = damaged();
    must(hash.manifest.inputs[0]).sha256 = "abc";
    expect(checkInputs(hash.manifest, hash.flows, hash.trades).join("\n")).toContain("has no sha256");

    const full = damaged();
    delete full.manifest.partial;
    expect(checkInputs(full.manifest, full.flows, full.trades).join("\n")).toContain(
      "a full bundle holds both flows",
    );
  });

  it("storage: a changed value, a changed size, a changed bundle id, a value left out, a stray key", () => {
    const changed = damaged();
    Object.assign(stepS137(changed), { title: "changed" });
    const lines = checkStorage(changed.manifest, changed.flows, changed.trades).join("\n");
    expect(lines).toContain("flow/A: stored as");
    expect(lines).toContain("flow/A: its sha256 is not the value's");

    const hash = damaged();
    hash.manifest.bundleId.hash = "0".repeat(64);
    expect(checkStorage(hash.manifest, hash.flows, hash.trades).join("\n")).toContain(
      "not the sha256 of the sorted value lines",
    );

    const left = damaged();
    left.manifest.storage.values.pop();
    expect(checkStorage(left.manifest, left.flows, left.trades).join("\n")).toContain(
      "trade/barber is in the bundle but not in storage.values",
    );

    const stray = damaged();
    must(stray.manifest.storage.values[0]).key = "bundle/other/1/flow/A";
    expect(checkStorage(stray.manifest, stray.flows, stray.trades).join("\n")).toContain(
      "is not under bundle/",
    );
  });

  it("lint marks: a count that is not the list, a failure the step does not carry, a mark the summary lacks", () => {
    const count = damaged();
    must(count.manifest.lint.rules.find((rule) => rule.rule === "guard-keyword-button")).failures = 2;
    expect(checkLintMarks(count.manifest.lint, count.flows)).toEqual([
      "rule guard-keyword-button counts 2 failures but lists 1",
    ]);

    const carried = damaged();
    stepS137(carried).lint = [];
    expect(checkLintMarks(carried.manifest.lint, carried.flows).join("\n")).toContain(
      "S1-37 is reported failing guard-keyword-button, but its own lint does not list it",
    );

    const lacks = damaged();
    lacks.manifest.lint.failures = [];
    lacks.manifest.lint.rules = lacks.manifest.lint.rules.map((rule) => ({ ...rule, failures: 0 }));
    expect(checkLintMarks(lacks.manifest.lint, lacks.flows)).toEqual([
      "S1-37 of flow A lists guard-keyword-button, which the summary does not report",
    ]);
  });

  it("shared lists: a list that differs from its fixture", () => {
    const bundle = damaged();
    bundle.manifest.lists.fixedLines.lines.pop();
    expect(checkSharedFixtures(bundle.manifest)).toEqual([
      "lists.fixedLines differs from fixtures/fixed-lines.json",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The side list. Part two of the contract test: each producer and consumer side of K-01 v1 (02-contracts K-01
// "Contract test"; contracts/bundle/README.md "Producers and consumers"). A side is added by its own QA side task,
// which depends on this task and on that side's build task and is planned by the lane that builds the side: the task
// sets `check` on its entry (a function that returns one line per problem, empty when the side holds) and nothing
// else here changes. An entry without `check` is a side whose task has not run yet; it is listed, never skipped.

export interface SideCheck {
  /** A short id for the side. */
  id: string;
  side: "producer" | "consumer";
  /** The role that builds the side. */
  owner: string;
  /** The components, spelled as the README's freeze record spells them. */
  components: string;
  /** What the side's check does, so the QA side task knows what to build. */
  needs: string;
  /** Set by the side's QA task. */
  check?: () => string[];
}

export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-compiler",
    side: "producer",
    owner: "playbook engineer",
    components: "C-058 to C-073, C-255",
    needs:
      "The compiler's output for a master flow and a trade file is accepted by bundle.v1.schema.json, and the checks above hold on it as a full bundle (partial left out: 2 flows, 243 trades, all group 11 markers, every input listed, hashes recomputed, each journey step a step of a flow); a lookup's field is sourced on every path and no loop runs across steps (the compiler's own lint, C-065 to C-070); the overlay applier and the plug-in key map give the compiled overlay that overlay-core.js apply() gives (parity, C-073).",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components: "C-050, C-051, C-053, C-055",
    needs:
      "The turn reads the manifest, one flow graph and one trade overlay by the bundle pin, applies the guard's keywords and the Clock lines from the fixtures, and reads a branch with no end as merge.",
  },
  {
    id: "consumer-action-layer",
    side: "consumer",
    owner: "action-layer engineer",
    components: "C-075 to C-089, C-092, C-093",
    needs:
      "The frontier, hubs, doors, any-time rows, cards, effects and fixed lines are read from the fixture bundles as the schema writes them, and a step marked failing is never taken for a good one.",
  },
  {
    id: "consumer-ai",
    side: "consumer",
    owner: "AI engineer",
    components: "C-114, C-118, C-119, C-121, C-122",
    needs:
      "The cards, prompts, model ids and routing by stakes are read from the manifest fixtures, and the judgment rules are cited by number.",
  },
  {
    id: "consumer-qa",
    side: "consumer",
    owner: "QA and eval engineer",
    components: "C-139, C-142, C-147, C-149",
    needs:
      "The gold-set generator walks the sample bundles journey by journey from the journey steps, and the out-of-scope markers keep their steps unreachable.",
  },
  {
    id: "consumer-release",
    side: "consumer",
    owner: "release engineer",
    components: "C-020",
    needs:
      "The publish-then-switch order writes the KV keys of the manifest's storage once per bundle id, never overwrites one, and switches the active id last.",
  },
  {
    id: "consumer-database",
    side: "consumer",
    owner: "database engineer",
    components: "C-151",
    needs:
      "The bundle registry and the PostgreSQL copy hold each stored value under the same key, size and hash, and are read on a KV miss.",
  },
];

describe("bundle.v1 sides: the list where each producer and consumer side is added", () => {
  const readme = readFileSync(path.join(BUNDLE_DIR, "README.md"), "utf8");

  it("names each side once, with one producer and the consumers of the README", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(1);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(6);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.needs, side.id).not.toBe("");
    }
  });

  it("spells each side's components as the README's freeze record does", () => {
    for (const side of SIDE_CHECKS) expect(readme, side.id).toContain(side.owner);
    for (const side of SIDE_CHECKS) expect(readme, side.id).toContain(side.components);
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
