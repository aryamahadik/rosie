// Contract test for K-01 v1.1, the bundle's stop field (T-1571; ruling T-1543 card B12,
// ops/reviews/signup-remainder/rule-rest.json; contracts/bundle/README.md section "v1.1": what the schema cannot check
// (line 237), the fixtures and what was also checked (line 239), and the contract-test paragraph (line 257); T-1544's
// Lead note 2, DL-1209: the rule reads a step's ask, its line 0).
//
// It reads only committed files; no database. What it proves:
//   a. every v1.1 entry of the shared fixtures index, selected by its `version` and never by a pinned list or count
//      (DL-124, DL-125), against bundle.v1.1.schema.json with v1's schema and the shared formats beside it, in the
//      contract check's strict Ajv: accepted ones accepted, refused ones refused;
//   b. each refused fixture put right exactly as its index `shows` says is accepted, and where `shows` names an accepted
//      file the put-right copy equals it as parsed JSON; nothing else in the copy changes;
//   c. the stop field is not vacuous: removing `answerFields` or `keys`, an empty `keys`, a repeated key or an empty stop
//      refuses a copy of an accepted fixture;
//   d. the line-0 rule the schema cannot make (README line 237): every accepted asksByWords step has its line 0 from
//      Rosie with no reply button, in its say and in each variant's own say; the read-back on a later line keeps the
//      stop; refuse-ask-line-zero-button fails it; a step whose line 0 carries buttons while a later line from Rosie
//      carries none is accepted by the schema (the documented limit) and fails it; so does one whose line 0 is the owner's;
//   e. each answer field's name once per step;
//   f. every accepted v1 entry is accepted by v1.1 (v1.1 restates every v1 def under its own name, README line 209), and
//      v1.1's root accepts bundle v0's skeleton holding flow-a-v3-with-stops.json, which v1 refuses;
//   g. the fixtures made from bundle v3 are bundle v3's own step or graph but for `stop`; the read-back's more and say
//      are barber's flow B words op's; the graph's contract value stays "bundle.v1" (R34); frozen.json holds v1 and v1.1;
//   h. each custom check above also run on a damaged copy, to show that it fires.
// Not here: the field on exactly the listed steps in a full bundle and the compiler's line-0 refusal of a words op
// (card B2's proofs), default 27's S1-38 and S2-27 (the lead's open gap), S1-84 (B1b, inside B2).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, REPO_ROOT, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The files

const BUNDLE_DIR = path.join(CONTRACTS_ROOT, "bundle");
const FIXTURES_DIR = path.join(BUNDLE_DIR, "fixtures");
const VERSION = "v1.1";
const V1 = "v1";
const BUNDLE_V3 = path.join(REPO_ROOT, "bundles", "v3", "bundle");
/** The source every fixture made from bundle v3's flow A names first (fixtures/index.json `source`). */
const V3_FLOW_A_SOURCE = "bundles/v3/bundle/flow/A.json";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
/** v1.1's entries of the shared index, in its order (v1 and v1.1 list their fixtures in it: DL-125). */
const entries = index.fixtures.filter((entry) => entry.version === VERSION);
const accepted = entries.filter((entry) => entry.expect === "accept");
const refused = entries.filter((entry) => entry.expect === "refuse");
const v1Accepted = index.fixtures.filter((entry) => entry.version === V1 && entry.expect === "accept");
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const entryOf = (file: string): FixtureEntry =>
  must(
    index.fixtures.find((entry) => entry.file === file),
    `${file} in fixtures/index.json`,
  );

// What the checks read. Each fixture is checked against the schema first, so a cast reads only what it requires.
interface Elements {
  buttons?: string[];
  [key: string]: unknown;
}
interface Message {
  from: string;
  to: string;
  text: string;
  elements?: Elements;
  plainText: string;
}
interface Variant {
  say?: Message[];
  addSay?: Message[];
  [key: string]: unknown;
}
interface AnswerField {
  name: string;
  type: string;
}
interface Stop {
  asksByWords?: { answerFields: AnswerField[] };
  waitsOnEvent?: { keys: string[] };
}
interface Step {
  id: string;
  say?: Message[];
  vary?: Record<string, Variant>;
  gives?: string[];
  stop?: Stop;
  [key: string]: unknown;
}
interface FlowGraph {
  contract: string;
  flow: string;
  steps: Record<string, Step>;
  [key: string]: unknown;
}
interface Op {
  op: string;
  at: string;
  more?: string[];
  say?: Message[];
  steps?: Step[];
}
interface TradeOverlay {
  contract: string;
  flows: Record<string, { ops: Op[] }>;
}

const stepFixture = (file: string): Step => fixture(file) as Step;
const copyOf = <T>(value: T): T => structuredClone(value);

/** The steps a value of `def` holds: a step itself, a flow graph's steps, an overlay's added steps, a bundle's all. */
function stepsIn(def: string | undefined, value: unknown): Step[] {
  if (def === "step") return [value as Step];
  if (def === "flowGraph") return Object.values((value as FlowGraph).steps);
  if (def === "tradeOverlay")
    return Object.values((value as TradeOverlay).flows).flatMap((flow) =>
      flow.ops.flatMap((op) => op.steps ?? []),
    );
  if (def === undefined) {
    const bundle = value as { flows: Record<string, FlowGraph>; trades: Record<string, TradeOverlay> };
    return [
      ...Object.values(bundle.flows).flatMap((flow) => stepsIn("flowGraph", flow)),
      ...Object.values(bundle.trades).flatMap((trade) => stepsIn("tradeOverlay", trade)),
    ];
  }
  return [];
}

/** Every step an accepted v1.1 fixture holds, with the file it is in. */
const acceptedSteps = accepted.flatMap((entry) =>
  stepsIn(entry.def, fixture(entry.file)).map((step) => ({ file: entry.file, step })),
);
const askingSteps = acceptedSteps.filter(({ step }) => step.stop?.asksByWords !== undefined);
const waitingSteps = acceptedSteps.filter(({ step }) => step.stop?.waitsOnEvent !== undefined);

// ---------------------------------------------------------------------------------------------------------------
// The schema: the contract check's strict Ajv 2020-12 setup, with common/ and both bundle schemas loaded

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const folder of [path.join(CONTRACTS_ROOT, "common"), BUNDLE_DIR]) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".schema.json"))
      ajv.addSchema(readJson(path.join(folder, entry.name)) as object);
  }
}
const idOf = (file: string): string => must((readJson(path.join(BUNDLE_DIR, file)) as { $id?: string }).$id);
const V1_1_ID = idOf("bundle.v1.1.schema.json");
const V1_ID = idOf("bundle.v1.schema.json");

function validator(schemaId: string, def: string | undefined): ValidateFunction {
  const validate = ajv.getSchema(`${schemaId}${def === undefined ? "" : `#/$defs/${def}`}`);
  if (validate === undefined) throw new Error(`no definition ${def ?? "(root)"} in ${schemaId}`);
  return validate;
}
const v1_1 = (def: string | undefined): ValidateFunction => validator(V1_1_ID, def);
const v1 = (def: string | undefined): ValidateFunction => validator(V1_ID, def);
const validStep = v1_1("step");

/** True when `validate` accepts `value`; the errors go into the failure line of a test that expects acceptance. */
function accepts(validate: ValidateFunction, value: unknown): { ok: boolean; why: string } {
  const ok = validate(value);
  return { ok, why: formatErrors(validate.errors).join("; ") };
}

// ---------------------------------------------------------------------------------------------------------------
// The custom checks, each returning one line per problem (empty when it holds)

/** The paths at which two JSON values differ (`a.b.0.c`); a key one side lacks is a path of its own. */
function diffPaths(a: unknown, b: unknown, at = ""): string[] {
  const join = (key: string): string => (at === "" ? key : `${at}.${key}`);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [at];
    return a.flatMap((item, n) => diffPaths(item, b[n], join(String(n))));
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) => (key in a && key in b ? diffPaths(a[key], b[key], join(key)) : [join(key)]));
  }
  return isDeepStrictEqual(a, b) ? [] : [at];
}

/**
 * README line 237, the line-0 rule: a step that asks by words asks by its line 0, Rosie's (`from` san) with no reply
 * button (`elements.buttons` absent or empty; a card's own button is not one), in its say and in each variant's own say.
 * A later line from Rosie with buttons is a read-back and is not read (Lead note 2 on T-1544, DL-1209).
 */
function lineZeroProblems(step: Step): string[] {
  if (step.stop?.asksByWords === undefined) return [];
  const problems: string[] = [];
  const read = (where: string, say: readonly Message[] | undefined): void => {
    const first = say?.[0];
    if (first === undefined) {
      problems.push(`${step.id}: ${where} has no line 0 to ask by`);
      return;
    }
    if (first.from !== "san") problems.push(`${step.id}: ${where}'s line 0 is ${first.from}'s, not Rosie's`);
    if ((first.elements?.buttons ?? []).length > 0)
      problems.push(`${step.id}: ${where}'s line 0 carries a reply button`);
  };
  read("its say", step.say);
  for (const [key, variant] of Object.entries(step.vary ?? {})) {
    if (variant.say !== undefined) read(`variant ${key}'s own say`, variant.say);
  }
  return problems;
}

/** README line 237: each answer field's name once in a step. */
function answerFieldProblems(step: Step): string[] {
  const names = (step.stop?.asksByWords?.answerFields ?? []).map((field) => field.name);
  return [...new Set(names.filter((name, n) => names.indexOf(name) !== n))].map(
    (name) => `${step.id}: the answer field ${name} is named twice`,
  );
}

/** A value made from bundle v3 is bundle v3's own but for `stop`: every path at which they differ is a stop. */
function v3Problems(made: unknown, v3: unknown): string[] {
  return diffPaths(made, v3)
    .filter((at) => !/^(steps\.[^.]+\.)?stop$/.test(at))
    .map((at) => `differs from bundle v3 at ${at === "" ? "(root)" : at}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Each refused fixture's one way to be put right, as its index `shows` says (README line 239)

interface PutRight {
  /** How its `shows` puts it right. */
  putRight: string;
  /** The paths the put-right copy changes, and no other. */
  changes: readonly string[];
  /** The accepted file its `shows` says the put-right copy is, if it names one. */
  equals?: string;
  mend: (step: Step) => void;
}

const lineZeroOf = (step: Step): Message => must(step.say?.[0], `${step.id}'s line 0`);

const PUT_RIGHT: Readonly<Record<string, PutRight>> = {
  "invalid/refuse-stop-on-buttons-step.json": {
    putRight: "its buttons taken off",
    changes: ["say.0.elements.buttons"],
    mend: (step) => {
      delete must(lineZeroOf(step).elements, "line 0's elements").buttons;
    },
  },
  "invalid/refuse-stop-both-kinds.json": {
    putRight: "waitsOnEvent dropped",
    changes: ["stop.waitsOnEvent"],
    equals: "stop-ask-s1-77.json",
    mend: (step) => {
      delete must(step.stop, "its stop").waitsOnEvent;
    },
  },
  "invalid/refuse-wait-unknown-key.json": {
    putRight: "id_checked in place of mobile",
    changes: ["stop.waitsOnEvent.keys.0"],
    equals: "stop-wait-s1-10.json",
    mend: (step) => {
      must(step.stop?.waitsOnEvent, "its waitsOnEvent").keys = ["id_checked"];
    },
  },
  "invalid/refuse-stop-on-split.json": {
    putRight: "the stop left out",
    changes: ["stop"],
    mend: (step) => {
      delete step.stop;
    },
  },
  "invalid/refuse-wait-key-not-given.json": {
    putRight: "id_checked given",
    changes: ["gives"],
    mend: (step) => {
      step.gives = ["id_checked"];
    },
  },
  "invalid/refuse-ask-at-event-step.json": {
    putRight: "waitsOnEvent on id_checked in place of asksByWords",
    changes: ["stop.asksByWords", "stop.waitsOnEvent"],
    mend: (step) => {
      step.stop = { waitsOnEvent: { keys: ["id_checked"] } };
    },
  },
  "invalid/refuse-ask-choice-field.json": {
    putRight: "the type text",
    changes: ["stop.asksByWords.answerFields.0.type"],
    equals: "stop-ask-s1-23.json",
    mend: (step) => {
      must(step.stop?.asksByWords?.answerFields[0], "its first answer field").type = "text";
    },
  },
  "invalid/refuse-ask-line-zero-button.json": {
    putRight: "line 0's buttons taken off",
    changes: ["say.0.elements.buttons"],
    equals: "stop-ask-s1-12-read-back.json",
    mend: (step) => {
      delete must(lineZeroOf(step).elements, "line 0's elements").buttons;
    },
  },
};

const putRightOf = (entry: FixtureEntry): PutRight =>
  must(PUT_RIGHT[entry.file], `a way to put ${entry.file} right`);
function twinOf(entry: FixtureEntry): Step {
  const twin = copyOf(stepFixture(entry.file));
  putRightOf(entry).mend(twin);
  return twin;
}
/** The accepted file a refused entry's `shows` says its put-right copy is ("... it is <file>.json, accepted"). */
const namedIn = (shows: string): string | undefined => /\bit is ([a-z0-9-]+\.json)\b/.exec(shows)?.[1];

// ---------------------------------------------------------------------------------------------------------------
// a. Every v1.1 entry, selected by version

describe("bundle.v1.1 fixtures: every v1.1 entry against bundle.v1.1.schema.json (strict Ajv)", () => {
  it("selects v1.1's entries by their version: accepted and refused ones, each checked against v1.1's schema", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.schema, entry.file).toBeUndefined();
  });

  for (const entry of entries) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} (${entry.def ?? "the root"})`, () => {
      const { ok, why } = accepts(v1_1(entry.def), fixture(entry.file));
      if (entry.expect === "accept") expect(ok, why).toBe(true);
      else expect(ok, `${entry.file} must be refused: ${entry.shows}`).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// b. Refused twins

describe("bundle.v1.1 fixtures: each refused fixture, put right as its shows says, is accepted", () => {
  it("has one way to put right each refused v1.1 entry and no other, each a step", () => {
    expect(Object.keys(PUT_RIGHT).sort()).toEqual(refused.map((entry) => entry.file).sort());
    for (const entry of refused) expect(entry.def, entry.file).toBe("step");
  });

  for (const entry of refused) {
    const fix = PUT_RIGHT[entry.file];
    it(`${entry.file}: put right (${fix?.putRight ?? "no way given"}), it is accepted${fix?.equals === undefined ? "" : ` and equals ${fix.equals}`}; nothing else changes`, () => {
      const put = putRightOf(entry);
      const twin = twinOf(entry);
      expect(diffPaths(stepFixture(entry.file), twin)).toEqual([...put.changes].sort());
      const { ok, why } = accepts(validStep, twin);
      expect(ok, why).toBe(true);
      expect(namedIn(entry.shows), "the accepted file its shows names").toBe(put.equals);
      if (put.equals !== undefined) {
        expect(entryOf(put.equals).version).toBe(VERSION);
        expect(entryOf(put.equals).expect).toBe("accept");
        expect(diffPaths(twin, fixture(put.equals))).toEqual([]);
        expect(isDeepStrictEqual(twin, fixture(put.equals))).toBe(true);
      }
    });
  }

  it("the twin check fires on a damaged copy: a second change, or a put-right copy that differs from its named file", () => {
    const entry = entryOf("invalid/refuse-ask-choice-field.json");
    const twin = twinOf(entry);
    twin.title = "changed";
    expect(diffPaths(stepFixture(entry.file), twin)).toEqual([
      "stop.asksByWords.answerFields.0.type",
      "title",
    ]);
    expect(diffPaths(twin, fixture("stop-ask-s1-23.json"))).toEqual(["title"]);
    const short = twinOf(entry);
    must(short.say).pop();
    expect(diffPaths(short, fixture("stop-ask-s1-23.json"))).toEqual(["say"]);
    expect(namedIn("with the buttons taken off it is accepted")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// c. The stop field is not vacuous

describe("bundle.v1.1 fixtures: the stop field is not vacuous (README line 239)", () => {
  it("has accepted steps of both kinds to damage", () => {
    expect(askingSteps.length).toBeGreaterThan(0);
    expect(waitingSteps.length).toBeGreaterThan(0);
  });

  for (const { file, step } of acceptedSteps.filter((one) => one.step.stop !== undefined)) {
    it(`${file} ${step.id}: an empty stop, and a stop of either kind with its list left out, are refused`, () => {
      expect(accepts(validStep, step).ok, accepts(validStep, step).why).toBe(true);
      const empty = copyOf(step);
      empty.stop = {};
      expect(validStep(empty), "an empty stop").toBe(false);
      if (step.stop?.asksByWords !== undefined) {
        const noFields = copyOf(step);
        delete (must(noFields.stop?.asksByWords) as { answerFields?: unknown }).answerFields;
        expect(validStep(noFields), "asksByWords without answerFields").toBe(false);
      }
      if (step.stop?.waitsOnEvent !== undefined) {
        const keys = step.stop.waitsOnEvent.keys;
        const noKeys = copyOf(step);
        delete (must(noKeys.stop?.waitsOnEvent) as { keys?: unknown }).keys;
        expect(validStep(noKeys), "waitsOnEvent without keys").toBe(false);
        const emptyKeys = copyOf(step);
        must(emptyKeys.stop?.waitsOnEvent).keys = [];
        expect(validStep(emptyKeys), "an empty keys").toBe(false);
        const repeated = copyOf(step);
        must(repeated.stop?.waitsOnEvent).keys = [...keys, must(keys[0])];
        expect(validStep(repeated), "a repeated key").toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// d. The line-0 rule the schema cannot make

describe("bundle.v1.1 fixtures: an asksByWords step asks by its line 0, Rosie's with no reply button (README line 237)", () => {
  it("reads every accepted asksByWords step, the card's among them (S1-77 inside flow-a-v3-with-stops too)", () => {
    expect(askingSteps.map(({ file, step }) => `${file} ${step.id}`)).toEqual(
      expect.arrayContaining([
        "stop-ask-s1-77.json S1-77",
        "stop-ask-s1-23.json S1-23",
        "stop-ask-s1-12-read-back.json S1-12",
        "flow-a-v3-with-stops.json S1-77",
      ]),
    );
  });

  for (const { file, step } of askingSteps) {
    it(`${file} ${step.id}: line 0 of its say, and of each variant's own say, is Rosie's with no reply button`, () => {
      expect(lineZeroProblems(step)).toEqual([]);
    });
  }

  it("stop-ask-s1-12-read-back passes it: its read-back on a later line, with buttons, keeps the stop (R32, R39)", () => {
    const readBack = stepFixture("stop-ask-s1-12-read-back.json");
    expect(entryOf("stop-ask-s1-12-read-back.json").expect).toBe("accept");
    const say = must(readBack.say);
    const later = say.slice(1).filter((line) => line.from === "san");
    expect(later.some((line) => (line.elements?.buttons ?? []).length > 0)).toBe(true);
    // Its line 0's card carries a button of its own, which is no reply button.
    expect(lineZeroOf(readBack).elements?.card).toBeDefined();
    expect(lineZeroProblems(readBack)).toEqual([]);
  });

  it("refuse-ask-line-zero-button fails it", () => {
    const step = stepFixture("invalid/refuse-ask-line-zero-button.json");
    expect(lineZeroProblems(step)).toEqual(["S1-12: its say's line 0 carries a reply button"]);
  });

  it("a step whose line 0 carries buttons while a later line from Rosie carries none is accepted by the schema (its documented limit, S1-24's shape) and fails it", () => {
    const step = copyOf(stepFixture("stop-ask-s1-12-read-back.json"));
    const say = must(step.say);
    const readBack = say.find((line, n) => n > 0 && (line.elements?.buttons ?? []).length > 0);
    const lineElements = must(must(readBack, "its read-back line").elements);
    must(lineZeroOf(step).elements).buttons = must(lineElements.buttons);
    delete lineElements.buttons;
    expect(say.slice(1).some((line) => line.from === "san" && line.elements?.buttons === undefined)).toBe(
      true,
    );
    const { ok, why } = accepts(validStep, step);
    expect(ok, why).toBe(true);
    expect(lineZeroProblems(step)).toEqual(["S1-12: its say's line 0 carries a reply button"]);

    const plain = copyOf(stepFixture("stop-ask-s1-23.json"));
    lineZeroOf(plain).elements = { buttons: ["That's right", "Change something"] };
    expect(accepts(validStep, plain).ok, accepts(validStep, plain).why).toBe(true);
    expect(lineZeroProblems(plain)).toEqual(["S1-23: its say's line 0 carries a reply button"]);
  });

  it("a step whose line 0 is the owner's is accepted by the schema and fails it", () => {
    const step = copyOf(stepFixture("stop-ask-s1-23.json"));
    const say = must(step.say);
    const ownerLine = must(say.find((line) => line.from !== "san"));
    step.say = [ownerLine, ...say];
    expect(accepts(validStep, step).ok, accepts(validStep, step).why).toBe(true);
    expect(lineZeroProblems(step)).toEqual(["S1-23: its say's line 0 is owner's, not Rosie's"]);
  });

  it("the check reads each variant's own say: a variant whose line 0 carries buttons fails it; one that asks on line 0, or adds a read-back by addSay, passes", () => {
    const step = copyOf(stepFixture("stop-ask-s1-23.json"));
    const say = must(step.say);
    const buttoned: Message = {
      ...copyOf(must(say[0])),
      elements: { buttons: ["That's right", "Change something"] },
    };
    step.vary = { "pf:sensitive": { say: [buttoned, ...say.slice(1)] } };
    expect(accepts(validStep, step).ok, accepts(validStep, step).why).toBe(true);
    expect(lineZeroProblems(step)).toEqual([
      "S1-23: variant pf:sensitive's own say's line 0 carries a reply button",
    ]);
    step.vary = { "pf:sensitive": { say: copyOf(say), addSay: [buttoned] } };
    expect(lineZeroProblems(step)).toEqual([]);
    step.vary = { "pf:sensitive": { say: [] } };
    expect(lineZeroProblems(step)).toEqual(["S1-23: variant pf:sensitive's own say has no line 0 to ask by"]);
  });

  it("an empty buttons list on line 0 is no reply button, and a step that does not ask by words is not read", () => {
    const step = copyOf(stepFixture("stop-ask-s1-23.json"));
    lineZeroOf(step).elements = { buttons: [] };
    expect(lineZeroProblems(step)).toEqual([]);
    const buttons = stepFixture("invalid/refuse-stop-on-buttons-step.json");
    const noStop = copyOf(buttons);
    delete noStop.stop;
    expect(lineZeroProblems(noStop)).toEqual([]);
    expect(lineZeroProblems(buttons)).toEqual(["S1-04: its say's line 0 carries a reply button"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// e. Each answer field's name once

describe("bundle.v1.1 fixtures: each answer field's name once per step (README line 237)", () => {
  for (const { file, step } of askingSteps) {
    it(`${file} ${step.id}`, () => {
      expect(answerFieldProblems(step)).toEqual([]);
    });
  }

  it("fires on a damaged copy that names a field twice, which the schema accepts", () => {
    const step = copyOf(stepFixture("stop-ask-s1-23.json"));
    const fields = must(step.stop?.asksByWords).answerFields;
    fields.push(copyOf(must(fields[0])));
    expect(accepts(validStep, step).ok, accepts(validStep, step).why).toBe(true);
    expect(answerFieldProblems(step)).toEqual(["S1-23: the answer field license is named twice"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// f. Every v1 document is a v1.1 document

describe("bundle.v1.1: every accepted v1 entry is accepted by v1.1 (README line 209)", () => {
  it("has accepted v1 entries to read", () => {
    expect(v1Accepted.length).toBeGreaterThan(0);
  });

  for (const entry of v1Accepted) {
    it(`${entry.file} (${entry.def ?? "the root"})`, () => {
      const value = fixture(entry.file);
      expect(accepts(v1(entry.def), value).ok).toBe(true);
      const { ok, why } = accepts(v1_1(entry.def), value);
      expect(ok, why).toBe(true);
    });
  }

  it("v1.1's root accepts bundle v0's skeleton holding flow-a-v3-with-stops.json in place of its flow A; v1's refuses it", () => {
    const bundle = copyOf(fixture("bundle-v0-skeleton.json")) as { flows: Record<string, unknown> };
    bundle.flows.A = fixture("flow-a-v3-with-stops.json");
    const { ok, why } = accepts(v1_1(undefined), bundle);
    expect(ok, why).toBe(true);
    expect(v1(undefined)(bundle)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// g. The fixtures made from bundle v3

const v3FlowA = readJson(path.join(BUNDLE_V3, "flow", "A.json")) as FlowGraph;
const barber = readJson(path.join(BUNDLE_V3, "trade", "barber.json")) as TradeOverlay;
const fromV3 = entries.filter((entry) => entry.source.startsWith(V3_FLOW_A_SOURCE));

describe("bundle.v1.1 fixtures: those made from bundle v3 are bundle v3's own but for stop (README lines 239 and 257)", () => {
  it("selects the v1.1 entries whose source is bundle v3's flow A, the card's list among them", () => {
    expect(fromV3.map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        "stop-wait-s1-10.json",
        "stop-ask-s1-77.json",
        "flow-a-v3-with-stops.json",
        "invalid/refuse-stop-on-buttons-step.json",
        "invalid/refuse-stop-on-split.json",
        "invalid/refuse-wait-unknown-key.json",
        "invalid/refuse-wait-key-not-given.json",
        "invalid/refuse-ask-at-event-step.json",
        "invalid/refuse-stop-both-kinds.json",
      ]),
    );
    for (const entry of fromV3) expect(["step", "flowGraph"], entry.file).toContain(entry.def);
  });

  for (const entry of fromV3) {
    it(`${entry.file} (${must(entry.def)}) equals bundle v3's flow A ${entry.def === "step" ? "step" : "graph"} as parsed JSON but for stop`, () => {
      const made = fixture(entry.file);
      if (entry.def === "step") {
        const step = made as Step;
        const own = must(v3FlowA.steps[step.id], `bundle v3's ${step.id}`);
        expect(own.stop, "bundle v3 carries no stop").toBeUndefined();
        expect(v3Problems(step, own)).toEqual([]);
      } else {
        expect(v3Problems(made, v3FlowA)).toEqual([]);
      }
    });
  }

  it("flow-a-v3-with-stops' stops are the accepted step fixtures' own, its contract value stays bundle.v1 (R34)", () => {
    const graph = fixture("flow-a-v3-with-stops.json") as FlowGraph;
    expect(graph.contract).toBe("bundle.v1");
    expect(v3FlowA.contract).toBe("bundle.v1");
    const withStop = Object.values(graph.steps).filter((step) => step.stop !== undefined);
    expect(withStop.length).toBeGreaterThan(0);
    for (const step of withStop) {
      const own = must(
        fromV3.find(
          (entry) =>
            entry.expect === "accept" && entry.def === "step" && stepFixture(entry.file).id === step.id,
        ),
        `an accepted step fixture of ${step.id}`,
      );
      expect(step.stop, step.id).toEqual(stepFixture(own.file).stop);
      expect(step, step.id).toEqual(stepFixture(own.file));
    }
  });

  it("stop-ask-s1-12-read-back's more and say are barber's flow B words op at S1-12 (flows.B.ops[0])", () => {
    const op = must(must(barber.flows.B, "barber's flow B").ops[0], "barber's flow B op 0");
    expect([op.op, op.at]).toEqual(["words", "S1-12"]);
    const readBack = stepFixture("stop-ask-s1-12-read-back.json");
    expect(readBack.id).toBe("S1-12");
    expect(readBack.more).toEqual(op.more);
    expect(readBack.say).toEqual(op.say);
    expect(barber.flows.B?.ops.filter((each) => each.at === "S1-12")).toHaveLength(1);
  });

  it("frozen.json freezes v1 and v1.1", () => {
    expect(readJson(path.join(BUNDLE_DIR, "frozen.json"))).toEqual({ frozen: ["v1", "v1.1"] });
  });

  it("the bundle v3 check fires on a damaged copy: a changed word, a dropped field, an added step", () => {
    const step = copyOf(stepFixture("stop-wait-s1-10.json"));
    const own = must(v3FlowA.steps[step.id]);
    must(step.say?.[0]).text = "changed";
    delete step.reads;
    expect(v3Problems(step, own)).toEqual([
      "differs from bundle v3 at reads",
      "differs from bundle v3 at say.0.text",
    ]);
    const graph = copyOf(fixture("flow-a-v3-with-stops.json")) as FlowGraph;
    graph.steps["S1-99"] = copyOf(step);
    expect(v3Problems(graph, v3FlowA)).toEqual(["differs from bundle v3 at steps.S1-99"]);
    expect(v3Problems({ ...copyOf(own), stop: { waitsOnEvent: { keys: ["id_checked"] } } }, own)).toEqual([]);
  });
});
