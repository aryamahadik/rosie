// Tests of the composer's call of the recorded-model double (T-1071, C-123), against K-03's fixtures: v1's, and v1.1's,
// whose composer inputs carry term facts (T-1175; contracts/message-plan/README.md "v1.1"), with the walking skeleton's
// JOIN run's input (T-1145; K-02 README "v1.1", recording 4), keyed on that run's own turn and row ids (round 2,
// DL-347; ./test-support.ts) and, since T-1175 (DL-355), on K-09 v1.6's compose input for that row: S1-02's four card
// lines as term facts, as bundle v0 publishes them. A v1 input with no term facts is still refused on plan-s1-02 by the
// composer's literal check (literalValue x2), which these tests run on the double's own plans. Deterministic and
// offline: outbound fetch is stubbed to throw for the whole file, and a test fails if anything calls it. The K-02 side of
// the double has its own tests (recorded-double.test.ts).

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ComposeAnswer, ComposeInput as ComposerInput } from "../composer";
import { composerOn, fakeComposerApi, loadPlanRules } from "../composer/test-support";
import {
  COMPOSER_RECORDINGS_FILE,
  COMPOSER_RECORDINGS_FILES,
  COMPOSER_RECORDINGS_V1_1_FILE,
  NoRecordingError,
  PLAN_VERSIONS,
  RecordingRefusedError,
  buildRecordedComposer,
  buildRecordedComposerFromFiles,
  canonicalJson,
  loadPlanContract,
  loadRecordedComposer,
  loadRecordedDouble,
  loadRecordedModel,
  requestKey,
  type JsonObject,
  type PlanVersion,
  type RecordedComposer,
} from "./index";
import {
  JOIN_EVENT_ID,
  JOIN_ROW_ID,
  JOIN_SENT_UTC,
  JOIN_TURN_ID,
  JOIN_WORDS,
  bundleV0,
  firstSayOf,
  rowIdOf,
  turnIdOf,
} from "./test-support";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTRACT_DIR = path.join(REPO_ROOT, "contracts");
const FIXTURES_DIR = path.join(CONTRACT_DIR, "message-plan", "fixtures");
const RECORDINGS_DIR = path.join(REPO_ROOT, "ai", "recordings");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}
const fixture = (file: string): JsonObject => readJson(path.join(FIXTURES_DIR, file)) as JsonObject;
const recordingFile = (file: string): JsonObject => readJson(path.join(RECORDINGS_DIR, file)) as JsonObject;
interface RawRecording {
  id: string;
  kind: string;
  request: { fixture?: string; file?: string };
  seed: { fixture: string };
}
interface ComposerFile {
  version: string;
  contract: string;
  recordings: RawRecording[];
}
const composerFile = (): ComposerFile =>
  readJson(path.join(RECORDINGS_DIR, "composer.v1.json")) as ComposerFile;
/** K-03 v1.1's composer recordings: inputs with term facts (T-1175). */
const v1dot1File = (): ComposerFile =>
  readJson(path.join(RECORDINGS_DIR, "composer.v1.1.json")) as ComposerFile;
/** Every composer recording, in the files' order, each with the K-03 version its file is checked against. */
const RECORDED: readonly (readonly [PlanVersion, RawRecording])[] = [
  ...composerFile().recordings.map((recording) => ["v1", recording] as const),
  ...v1dot1File().recordings.map((recording) => ["v1.1", recording] as const),
];

// An independent validator, as T-082's contract test builds it, so the double is not the judge of its own answers.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const folder of ["common", "bundle", "message-plan"]) {
  const dir = path.join(CONTRACT_DIR, folder);
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".schema.json")))
    ajv.addSchema(readJson(path.join(dir, name)) as object);
}
const schemaIdOf = (version: PlanVersion): string =>
  (
    readJson(path.join(CONTRACT_DIR, "message-plan", `message-plan.${version}.schema.json`)) as {
      $id: string;
    }
  ).$id;
const SCHEMA_ID = schemaIdOf("v1");
function accepts(def: string, value: unknown): boolean {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`no schema for ${def}`);
  return validate(value) as boolean;
}
/** Whether K-03 at `version` accepts `value` as `$defs/<def>`, by the independent validator. */
function acceptsAt(version: PlanVersion, def: string, value: unknown): boolean {
  const validate = ajv.getSchema(`${schemaIdOf(version)}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`no schema for ${def} at ${version}`);
  return validate(value) as boolean;
}

const index = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: IndexEntry[] }).fixtures;
interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}
const acceptedPlans = index
  .filter((entry) => entry.expect === "accept" && entry.def === "plan")
  .map((entry) => entry.file);
const slotNames = new Set(
  (fixture("slots.json") as { slots: { name: string }[] }).slots.map((slot) => slot.name),
);

/** The walking skeleton's JOIN run's input (T-1145; K-02 README "v1.1", recording 4), in ai/recordings. */
const JOIN_INPUT_FILE = "composer-inputs/join-s1-02.json";
/** A composer input's inbound text and its time (K-03 composeInput.inbound). */
interface Inbound {
  text: string;
  sentAt: { utc: string; zone: string };
}
/** One fact of a composer input: a slot fact (slot, value) or a term fact (value, source; K-03 v1.1). */
interface InputFactOf {
  value: string;
  slot?: string;
  source?: string;
}
/** A composer input, as far as these tests read it: its row, its turn, its master line, its facts and the text it replies to. */
type InputOf = JsonObject & {
  row: string;
  turn: string;
  masterText: { step: string; text: string };
  facts: InputFactOf[];
  inbound: Inbound;
};

/** K-09 v1.6's compose-input-s1-02-v1.6.json (T-1173): turn 1's row, whose input is K-03 v1.1's input-s1-02-v1.1.json. */
interface ToolApiCompose {
  request: { caller: { turnId: string }; outboxRowId: string };
  outcome: { input: InputOf };
}
const COMPOSE_V1_6 = readJson(
  path.join(CONTRACT_DIR, "tool-api", "fixtures", "compose-input-s1-02-v1.6.json"),
) as ToolApiCompose;

/**
 * The compose input for the JOIN run's row (K-02 README "v1.1" recording 4; DL-347 ruling 2; T-1175): K-09 v1.6's
 * compose input for turn 1's row (compose-input-s1-02-v1.6.json: K-03 v1.1's input-s1-02-v1.1.json, S1-02's four card
 * lines as term facts) for the run's own row and turn, replying to the run's one text. The turn is T-248's hash of the
 * JOIN's event id; the row is S1-02's question, ADR-013 default 131's `outbox-s1-02-<turn key>-1` with that turn id as
 * the turn key; the inbound is the JOIN of tests/e2e/skeleton at its send time, in the fixture's zone. Everything else,
 * its term facts included, is the fixture's.
 */
function joinRunInput(): InputOf {
  const row = structuredClone(COMPOSE_V1_6.outcome.input);
  return {
    ...row,
    row: rowIdOf("outbox", "S1-02", turnIdOf([JOIN_EVENT_ID]), 1),
    turn: turnIdOf([JOIN_EVENT_ID]),
    inbound: { text: JOIN_WORDS, sentAt: { utc: JOIN_SENT_UTC, zone: row.inbound.sentAt.zone } },
  };
}
const unique = (names: readonly string[]): string[] => [...new Set(names)];

/** The composer's input a recording names. */
function inputOf(recording: RawRecording): JsonObject {
  if (recording.request.fixture !== undefined) return fixture(recording.request.fixture);
  if (recording.request.file !== undefined) return recordingFile(recording.request.file);
  throw new Error("the test's setup lacks an input it reads");
}

/**
 * The literals K-03 v1.1's refuse-plan-s1-02-on-v1-input.json names, as the composer's literal check refuses them:
 * S1-02's plan types $2 (a price) and 15 (a number) in its fact line.
 */
const S1_02_LITERALS = [
  { check: "literalValue", at: "lines[1].text", kind: "price" },
  { check: "literalValue", at: "lines[1].text", kind: "number" },
];

const fetchStub = vi.fn(() => {
  throw new Error("no network in a double test: outbound fetch was called");
});
let composer: RecordedComposer;

beforeAll(() => {
  vi.stubGlobal("fetch", fetchStub);
  composer = loadRecordedComposer();
});
afterAll(() => {
  expect(fetchStub).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/**
 * The composer (C-118) on one row, its one call answered by the fake Messages API with the double's own plan for exactly
 * that row's input (as T-373's tests send it), so what leaves the composer is what it makes of the recording.
 */
async function composeOnDouble(input: JsonObject): Promise<{ answer: ComposeAnswer; calls: number }> {
  const plan = await composer.composer(input);
  const row = input as unknown as ComposerInput;
  const api = fakeComposerApi([{ input: row, plan }]);
  const answer = await composerOn(api.fetch).compose(row);
  return { answer, calls: api.calls.length };
}

describe("the plan fixtures: each input gets its plan", () => {
  it("holds a recording for every accepted K-03 plan fixture in the v1 file, and plan-s1-02's for S1-02's two inputs with term facts in the v1.1 file", () => {
    expect(acceptedPlans).toHaveLength(6);
    expect(COMPOSER_RECORDINGS_FILES).toEqual([COMPOSER_RECORDINGS_FILE, COMPOSER_RECORDINGS_V1_1_FILE]);
    expect([composerFile().contract, v1dot1File().contract]).toEqual([
      "message-plan.v1",
      "message-plan.v1.1",
    ]);
    // K-03 v1's file: one recording per accepted plan, plan-s1-02.json's on v1's input-s1-02.json (no term facts).
    const seeded = composerFile().recordings.map((entry) => entry.seed.fixture);
    expect([...seeded].sort()).toEqual([...acceptedPlans].sort());
    expect(unique(seeded)).toHaveLength(seeded.length);
    // K-03 v1.1's file: plan-s1-02.json for K-03 v1.1's input-s1-02-v1.1.json and for the JOIN run's input (T-1145;
    // K-02 README "v1.1", recording 4), each with S1-02's term facts (T-1175).
    expect(v1dot1File().recordings.map((entry) => [entry.id, entry.request, entry.seed.fixture])).toEqual([
      ["composer-s1-02-v1.1", { fixture: "input-s1-02-v1.1.json" }, "plan-s1-02.json"],
      ["composer-join-s1-02", { file: JOIN_INPUT_FILE }, "plan-s1-02.json"],
    ]);
    expect(RECORDED.filter(([, entry]) => entry.seed.fixture === "plan-s1-02.json")).toHaveLength(3);
    expect(RECORDED).toHaveLength(acceptedPlans.length + 2);
    expect(composer.size).toBe(acceptedPlans.length + 2);
  });

  it("answers input-s1-02 with plan-s1-02", async () => {
    const answer = await composer.composer(fixture("input-s1-02.json"));
    expect(answer).toEqual(fixture("plan-s1-02.json"));
    expect(accepts("plan", answer)).toBe(true);
  });

  it("answers K-03 v1.1's input-s1-02-v1.1.json with plan-s1-02, exactly the pair input-and-plan-s1-02.json holds (T-1175)", async () => {
    const twin = fixture("input-s1-02-v1.1.json") as InputOf;
    const v1 = fixture("input-s1-02.json") as InputOf;
    // input-s1-02.json's twin: the same input with S1-02's four card terms as term facts, which v1's schema refuses.
    expect({ ...twin, facts: [] }).toEqual(v1);
    expect(twin.facts).toHaveLength(4);
    expect(twin.facts.every((fact) => typeof fact.source === "string" && fact.slot === undefined)).toBe(true);
    expect(acceptsAt("v1.1", "composeInput", twin)).toBe(true);
    expect(acceptsAt("v1", "composeInput", twin)).toBe(false);
    const recorded = RECORDED.filter(([, entry]) => entry.request.fixture === "input-s1-02-v1.1.json");
    expect(recorded.map(([version, entry]) => [version, entry.id, entry.seed.fixture])).toEqual([
      ["v1.1", "composer-s1-02-v1.1", "plan-s1-02.json"],
    ]);
    const answer = await composer.composer(twin);
    expect(answer).toEqual(fixture("plan-s1-02.json"));
    expect(accepts("plan", answer)).toBe(true);
    expect(fixture("input-and-plan-s1-02.json")).toEqual({ input: twin, plan: answer });
    expect(acceptsAt("v1.1", "inputAndPlan", { input: twin, plan: answer })).toBe(true);
    // Exactly that input: with a term fact left out, or one of its words changed, it gets nothing.
    await expect(composer.composer({ ...twin, facts: twin.facts.slice(0, 3) })).rejects.toThrow(
      NoRecordingError,
    );
    const changed = twin.facts.map((fact, k) =>
      k === 0 ? { ...fact, value: fact.value.replace("15", "16") } : fact,
    );
    expect(changed).not.toEqual(twin.facts);
    await expect(composer.composer({ ...twin, facts: changed })).rejects.toThrow(/composerPlan/);
  });

  it("answers the JOIN run's input, K-09 v1.6's compose input for S1-02 for the run's own row and turn replying to JOIN at its time, with plan-s1-02 (recording 4, re-keyed on K-03 v1.1's input: T-1175)", async () => {
    const join = recordingFile(JOIN_INPUT_FILE) as InputOf;
    const twin = fixture("input-s1-02-v1.1.json") as InputOf;
    const chain = fixture("input-s1-02.json") as InputOf;
    // The file in ai/recordings pins exactly the input the run's row gets (DL-347 ruling 2; T-1175), never written by
    // hand.
    expect(join).toEqual(joinRunInput());
    // The run's ids: T-248's hash of the JOIN's one event id (64 lowercase hex digits), and default 131's row id with it as
    // the turn key; the fixture's row is the same rule with the fixture's stand-in turn key, sam (ADR-013 default 131).
    expect([join.turn, join.row]).toEqual([JOIN_TURN_ID, JOIN_ROW_ID]);
    expect(join.turn).toMatch(/^[0-9a-f]{64}$/u);
    expect(join.row).toBe(`outbox-s1-02-${join.turn}-1`);
    expect(rowIdOf("outbox", "S1-02", "sam", 1)).toBe(twin.row);
    expect([twin.row, twin.turn]).not.toContain(join.row);
    expect([twin.row, twin.turn]).not.toContain(join.turn);
    // K-09 v1.6's compose input for turn 1's row is K-03 v1.1's input-s1-02-v1.1.json word for word (T-1173's rule
    // inputIsK03Fixture): the Tool API writes the row and the turn from the request's row and its caller's turn, so those,
    // with the text replied to, are what the run's own request changes. K-09 v1's was v1's input-s1-02.json, no facts.
    expect(COMPOSE_V1_6.outcome.input).toEqual(twin);
    expect([twin.row, twin.turn]).toEqual([
      COMPOSE_V1_6.request.outboxRowId,
      COMPOSE_V1_6.request.caller.turnId,
    ]);
    expect({ ...join, row: twin.row, turn: twin.turn, inbound: twin.inbound }).toEqual(twin);
    expect({ ...join, row: chain.row, turn: chain.turn, inbound: chain.inbound, facts: [] }).toEqual(chain);
    expect(join.inbound).toEqual({
      text: JOIN_WORDS,
      sentAt: { utc: JOIN_SENT_UTC, zone: twin.inbound.sentAt.zone },
    });
    // Its master line and its four term facts are S1-02's, as bundle v0 publishes them under the id its manifest pins:
    // the bundle the JOIN run's decide context pins (recording 2). Each fact is a card line word for word, in card order,
    // with its source line and no slot.
    const v0 = bundleV0();
    const s102 = firstSayOf(v0, "S1-02");
    expect(join.masterText).toEqual({ step: "S1-02", text: s102.text });
    expect(join.facts.map((fact) => fact.value)).toEqual(s102.cardLines);
    expect(s102.cardLines).toHaveLength(4);
    expect(join.facts.every((fact) => typeof fact.source === "string" && fact.slot === undefined)).toBe(true);
    // The same turn, JOIN text and time, and bundle as the JOIN run's decide context (ai/recordings/recordings.v1.1.json).
    const context = recordingFile("contexts/join-s1-01.json") as {
      turnId: string;
      bundleId: unknown;
      texts: { words: string; sentAt: Inbound["sentAt"] }[];
    };
    expect(context.turnId).toBe(join.turn);
    expect(context.bundleId).toEqual(v0.bundleId);
    expect(context.texts.map((text) => ({ text: text.words, sentAt: text.sentAt }))).toEqual([join.inbound]);
    // A K-03 v1.1 input: v1's schema refuses its term facts, so its recording is in the v1.1 file.
    expect(acceptsAt("v1.1", "composeInput", join)).toBe(true);
    expect(acceptsAt("v1", "composeInput", join)).toBe(false);
    const recorded = RECORDED.filter(([, entry]) => entry.request.file === JOIN_INPUT_FILE);
    expect(recorded.map(([version, entry]) => [version, entry.id, entry.seed.fixture])).toEqual([
      ["v1.1", "composer-join-s1-02", "plan-s1-02.json"],
    ]);
    const answer = await composer.composer(join);
    expect(answer).toEqual(fixture("plan-s1-02.json"));
    expect(answer).toEqual(await composer.composer(twin));
    expect(accepts("plan", answer)).toBe(true);
    expect(acceptsAt("v1.1", "inputAndPlan", { input: join, plan: answer })).toBe(true);
  });

  for (const [version, recording] of RECORDED) {
    it(`${recording.id} (${recording.seed.fixture}): its input is valid and gets it, valid against $defs/plan`, async () => {
      const input = inputOf(recording);
      expect(acceptsAt(version, "composeInput", input)).toBe(true);
      const answer = await composer.composer(input);
      expect(answer).toEqual(fixture(recording.seed.fixture));
      expect(accepts("plan", answer)).toBe(true);
      // Every slot the plan opens is one of the vocabulary's 52, and none is hold.
      expect(slotNames.size).toBe(52);
      const words = JSON.stringify(answer);
      for (const [, name] of words.matchAll(/\{\{([^:{}|]*)/g)) expect(slotNames.has(name ?? "")).toBe(true);
      expect(words).not.toContain("{{hold");
    });

    it(`${recording.id} (${recording.seed.fixture}): the plan keeps to what its input allows`, async () => {
      const input = inputOf(recording) as {
        allowedFormats: string[];
        allowedLinks: string[];
        options: { id: string }[];
        pageTypes: string[];
        openQuestions: { id: string }[];
      };
      const plan = (await composer.composer(input)) as {
        formats: string[];
        lines: { text: string }[];
        question: { text: string; optionIds: string[] } | null;
        pageType: string | null;
        threadReplyTo: string | null;
      };
      for (const format of plan.formats) expect(input.allowedFormats).toContain(format);
      for (const id of plan.question?.optionIds ?? []) expect(input.options.map((o) => o.id)).toContain(id);
      const words = [...plan.lines.map((line) => line.text), plan.question?.text ?? ""].join("\n");
      for (const [, link] of words.matchAll(/\{\{(link\.[a-z]+)/g))
        expect(input.allowedLinks).toContain(link);
      if (plan.pageType !== null) expect(input.pageTypes).toContain(plan.pageType);
      if (plan.threadReplyTo !== null)
        expect(input.openQuestions.map((q) => q.id)).toContain(plan.threadReplyTo);
    });
  }
});

describe("a v1 input with no term facts is still refused on plan-s1-02 (literalValue x2); S1-02's v1.1 inputs get it", () => {
  it("the composer refuses the double's plan-s1-02 on v1's input-s1-02.json for its two literals, the pair K-03 v1.1 refuses (refuse-plan-s1-02-on-v1-input.json), and gives it on the twin and on the JOIN run's input", async () => {
    const rules = await loadPlanRules();
    const plan = fixture("plan-s1-02.json");
    const v1 = fixture("input-s1-02.json");
    // The double still holds plan-s1-02 for the v1 input (composer.v1.json), so the composer's literal check has it to
    // catch: the pair K-03 v1.1's named rule refuses for 15 and 2.
    expect(await composer.composer(v1)).toEqual(plan);
    expect(fixture("invalid/refuse-plan-s1-02-on-v1-input.json")).toEqual({ input: v1, plan });
    expect(rules.numbersHeldByFacts({ input: v1, plan })).toEqual([
      "plan.lines[1].text: states the number 15, which no fact of the input holds",
      "plan.lines[1].text: states the number 2, which no fact of the input holds",
    ]);
    const refused = await composeOnDouble(v1);
    expect(refused.calls).toBe(1);
    expect(refused.answer).toEqual({
      status: "refused",
      stage: "plan",
      problems: S1_02_LITERALS,
      modelCalls: expect.any(Array) as unknown,
    });
    expect(refused.answer).not.toHaveProperty("plan");
    // With S1-02's term facts the same plan is given, from the one call: K-03 v1.1's twin and the JOIN run's input.
    for (const input of [fixture("input-s1-02-v1.1.json"), recordingFile(JOIN_INPUT_FILE)]) {
      expect(await composer.composer(input)).toEqual(plan);
      expect(rules.numbersHeldByFacts({ input, plan })).toEqual([]);
      const given = await composeOnDouble(input);
      expect(given.calls).toBe(1);
      expect(given.answer).toMatchObject({ status: "ok", plan, attempt: 1, fallback: false });
    }
  });

  it("the JOIN run's input with no term facts (round 2's key: a v1 input) gets no plan from the double; recording 4 answers its K-03 v1.1 input alone", async () => {
    const join = recordingFile(JOIN_INPUT_FILE) as InputOf;
    expect(join.facts).toHaveLength(4);
    const v1Join = { ...join, facts: [] };
    expect(acceptsAt("v1", "composeInput", v1Join)).toBe(true);
    await expect(composer.composer(v1Join)).rejects.toThrow(NoRecordingError);
    await expect(composer.composer(v1Join)).rejects.toThrow(/composerPlan/);
    // Its term facts with their sources left out are not v1.1's term facts: nothing is recorded for them either.
    const unsourced = { ...join, facts: join.facts.map((fact) => ({ value: fact.value })) };
    expect(acceptsAt("v1.1", "composeInput", unsourced)).toBe(false);
    await expect(composer.composer(unsourced)).rejects.toThrow(NoRecordingError);
    expect(await composer.composer(join)).toEqual(fixture("plan-s1-02.json"));
  });
});

describe("the key of a composer input", () => {
  it("is the sha256 of the input's canonical JSON, whatever order its properties are written in", async () => {
    const input = fixture("input-s1-02.json");
    const sha = createHash("sha256").update(canonicalJson(input)).digest("hex");
    expect(requestKey("composerPlan", input)).toBe(`composerPlan:${sha}`);
    const shuffled: JsonObject = Object.fromEntries(Object.entries(input).reverse());
    expect(requestKey("composerPlan", shuffled)).toBe(requestKey("composerPlan", input));
    expect(await composer.composer(shuffled)).toEqual(fixture("plan-s1-02.json"));
  });

  it("keys an input with term facts by its content too: the twin's facts with their properties reordered get the same plan", async () => {
    const twin = fixture("input-s1-02-v1.1.json") as InputOf;
    const reordered = {
      ...twin,
      facts: twin.facts.map((fact) => Object.fromEntries(Object.entries(fact).reverse())),
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(twin));
    expect(requestKey("composerPlan", reordered)).toBe(requestKey("composerPlan", twin));
    expect(await composer.composer(reordered)).toEqual(fixture("plan-s1-02.json"));
  });
});

describe("an input with no recording fails loudly", () => {
  const sam = fixture("input-s1-02.json") as JsonObject & { inbound: { text: string } };

  it("rejects a changed row, naming the kind", async () => {
    const other = { ...sam, row: "outbox-never-recorded" };
    await expect(composer.composer(other)).rejects.toThrow(NoRecordingError);
    await expect(composer.composer(other)).rejects.toThrow(/composerPlan/);
  });

  it("answers nothing for an input that differs by one character", async () => {
    const other = { ...sam, inbound: { ...sam.inbound, text: `${sam.inbound.text} ` } };
    await expect(composer.composer(other)).rejects.toBeInstanceOf(NoRecordingError);
  });

  it("rejects an input JSON cannot hold, never answers it", async () => {
    await expect(composer.composer({ row: undefined })).rejects.toThrow(TypeError);
  });

  it("rejects the JOIN run's input at another time, or with its text changed (T-1145)", async () => {
    const join = recordingFile(JOIN_INPUT_FILE) as InputOf;
    const later = { ...join.inbound.sentAt, utc: "2026-10-19T14:01:50Z" };
    await expect(composer.composer({ ...join, inbound: { ...join.inbound, sentAt: later } })).rejects.toThrow(
      NoRecordingError,
    );
    await expect(composer.composer({ ...join, inbound: { ...join.inbound, text: "join" } })).rejects.toThrow(
      /composerPlan/,
    );
  });

  it("rejects the JOIN run's input under the fixture's stand-in row and turn (round 1's key), or another turn's row", async () => {
    const join = recordingFile(JOIN_INPUT_FILE) as InputOf;
    const chain = fixture("input-s1-02.json") as InputOf;
    await expect(composer.composer({ ...join, row: chain.row, turn: chain.turn })).rejects.toThrow(
      NoRecordingError,
    );
    const other = turnIdOf([JOIN_EVENT_ID, "evt-sam-0001"]);
    await expect(
      composer.composer({ ...join, row: rowIdOf("outbox", "S1-02", other, 1), turn: other }),
    ).rejects.toThrow(/composerPlan/);
  });

  it("fails the same way when the file holds no composer recording at all", async () => {
    const empty = buildRecordedComposer({ version: "v1", contract: "message-plan.v1", recordings: [] });
    expect(empty.size).toBe(0);
    await expect(empty.composer(sam)).rejects.toThrow(NoRecordingError);
  });
});

describe("a recording K-03 refuses is refused at load", () => {
  const sam = fixture("input-s1-02.json");
  const planS102 = fixture("plan-s1-02.json") as {
    lines: { role: string; text: string }[];
    question: { text: string };
  };
  const withPlan = (mutate: (plan: JsonObject) => void): Record<string, unknown> => {
    const plan = structuredClone(planS102) as unknown as JsonObject;
    mutate(plan);
    return { id: "extra", kind: "composerPlan", request: { ...sam, row: "outbox-extra" }, output: plan };
  };
  const withRecording = (...extra: Record<string, unknown>[]): unknown => {
    const file = composerFile();
    return { ...file, recordings: [...file.recordings, ...extra] };
  };
  const refusal = (file: unknown): RecordingRefusedError => {
    let error: unknown;
    try {
      buildRecordedComposer(file);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecordingRefusedError);
    return error as RecordingRefusedError;
  };
  const lines = (file: unknown): string => refusal(file).problems.join("\n");
  const setText = (plan: JsonObject, text: string): void => {
    const first = (plan.lines as { text: string }[])[0];
    if (first === undefined) throw new Error("test setup");
    first.text = text;
  };

  it("loads the extra recording once it is whole (the refusals below each break one thing)", async () => {
    const loaded = buildRecordedComposer(withRecording(withPlan(() => undefined)));
    // The v1 file's recordings and the extra one; the double as shipped also loads the v1.1 file (T-1175).
    expect(loaded.size).toBe(composerFile().recordings.length + 1);
    expect(composer.size).toBe(composerFile().recordings.length + v1dot1File().recordings.length);
    await expect(loaded.composer({ ...sam, row: "outbox-extra" })).resolves.toEqual(planS102);
    await expect(composer.composer({ ...sam, row: "outbox-extra" })).rejects.toThrow(NoRecordingError);
  });

  it("refuses a plan with a {{hold}} slot (D66), by the schema and by the vocabulary", () => {
    const hold = fixture("invalid/refuse-hold-slot.json");
    const text = lines(withRecording({ id: "hold", kind: "composerPlan", request: sam, output: hold }));
    expect(text).toContain("hold: the answer against plan");
    expect(text).toContain(
      "hold: the words name the slot {{hold}}, which K-03's vocabulary does not hold (hold is refused since D66)",
    );
  });

  it("refuses a plan with a slot outside the vocabulary, and a {{ that opens no slot", () => {
    const unknown = lines(
      withRecording(
        withPlan((plan) => {
          setText(plan, "Your total is {{total:$50}} today.");
        }),
      ),
    );
    expect(unknown).toContain("extra: the answer against plan");
    expect(unknown).toContain("the words name the slot {{total}}, which K-03's vocabulary does not hold");
    const broken = lines(
      withRecording(
        withPlan((plan) => {
          setText(plan, "Hello {{ name");
        }),
      ),
    );
    expect(broken).toContain("extra: the words open a {{ that is not a slot");
    const inQuestion = lines(
      withRecording(
        withPlan((plan) => {
          (plan.question as { text: string }).text = "Ready for {{hold}}?";
        }),
      ),
    );
    expect(inQuestion).toContain("the words name the slot {{hold}}");
  });

  it("refuses a plan the schema refuses (a contact card as a format)", () => {
    const bad = fixture("invalid/refuse-format-not-allowed.json");
    expect(lines(withRecording({ id: "card", kind: "composerPlan", request: sam, output: bad }))).toContain(
      "card: the answer against plan",
    );
  });

  it("refuses a plan that adds a field, or lacks one", () => {
    expect(lines(withRecording(withPlan((plan) => (plan.extra = true))))).toContain(
      "extra: the answer against plan: (root) must NOT have additional properties (extra)",
    );
    expect(lines(withRecording(withPlan((plan) => delete plan.question)))).toContain(
      "extra: the answer against plan",
    );
  });

  it("refuses an input the schema refuses (a frontier field)", () => {
    const frontier = fixture("invalid/refuse-frontier-in-input.json");
    const text = lines(
      withRecording({
        id: "frontier",
        kind: "composerPlan",
        request: frontier,
        seed: { fixture: "plan-s1-02.json" },
      }),
    );
    expect(text).toContain("frontier: the input: (root) must NOT have additional properties (frontier)");
  });

  it("refuses a seed that is a fixture K-03 refuses, one it does not list, or one that is no plan", () => {
    const seed = (fixtureName: string): string =>
      lines(
        withRecording({
          id: "seed",
          kind: "composerPlan",
          request: { ...sam, row: "outbox-seed-test" },
          seed: { fixture: fixtureName },
        }),
      );
    expect(seed("invalid/refuse-hold-slot.json")).toContain("a fixture K-03 refuses");
    expect(seed("plan-made-up.json")).toContain("not listed");
    expect(seed("slots.json")).toContain("seed slots.json against plan");
    expect(seed("plan-email-copy.json")).toContain("seed plan-email-copy.json against plan");
  });

  it("refuses a request that names no input, a missing file, and a file outside ai/recordings", () => {
    const request = (value: unknown): string =>
      lines(
        withRecording({
          id: "req",
          kind: "composerPlan",
          request: value,
          seed: { fixture: "plan-s1-02.json" },
        }),
      );
    expect(request({ fixture: "input-nowhere.json" })).toContain("req: the request cannot be read");
    expect(request({ file: "composer-inputs/nowhere.json" })).toContain("req: the request cannot be read");
    expect(request({ file: "../recordings.v1.json" })).toContain("req: the request cannot be read");
    expect(request({ row: "x" })).toContain("req: the input:");
  });

  it("refuses any other kind, a recording with both or neither of seed and output, and a stray field", () => {
    const other = lines(
      withRecording({
        id: "wrong",
        kind: "plannerOutput",
        request: sam,
        seed: { fixture: "plan-s1-02.json" },
      }),
    );
    expect(other).toContain('wrong: kind "plannerOutput" is not composerPlan');
    expect(
      lines(withRecording({ id: "both", kind: "composerPlan", request: sam, seed: {}, output: {} })),
    ).toContain("both: gives exactly one of seed and output");
    expect(lines(withRecording({ id: "none", kind: "composerPlan", request: sam }))).toContain(
      "none: gives exactly one of seed and output",
    );
    expect(
      lines(withRecording({ id: "stray", kind: "composerPlan", request: sam, output: {}, note: "x" })),
    ).toContain("stray: holds note, which it does not take");
  });

  it("refuses two recordings of one input, and a repeated id", () => {
    const first = composerFile().recordings[1];
    if (first === undefined) throw new Error("test setup");
    const text = lines(withRecording({ ...first, id: "again" }, { ...first }));
    expect(text).toContain("again: has the same input as composer-block-readback-poll");
    expect(text).toContain("the id is used twice");
  });

  it("names every problem at once and loads nothing", () => {
    const one = withPlan((plan) => {
      setText(plan, "a {{hold}}");
    });
    one.id = "one";
    one.request = { ...sam, row: "outbox-one" };
    const two = withPlan((plan) => {
      setText(plan, "a {{total}}");
    });
    two.id = "two";
    two.request = { ...sam, row: "outbox-two" };
    const error = refusal(withRecording(one, two));
    expect(error.problems.some((line) => line.startsWith("one:"))).toBe(true);
    expect(error.problems.some((line) => line.startsWith("two:"))).toBe(true);
  });

  it("refuses a file that is not the v1 shape, or is K-02's", () => {
    expect(() => buildRecordedComposer({ version: "v2", recordings: [] })).toThrow(RecordingRefusedError);
    expect(() => buildRecordedComposer([])).toThrow(RecordingRefusedError);
    const k02 = readJson(path.join(RECORDINGS_DIR, "recordings.v1.json"));
    expect(() => buildRecordedComposer(k02)).toThrow(RecordingRefusedError);
  });
});

describe("the double reads K-03 v1.1, each file by its own version (T-1175)", () => {
  const twinSeeded = (): RawRecording => {
    const seeded = v1dot1File().recordings[0];
    if (seeded === undefined) throw new Error("test setup");
    return seeded;
  };
  /** S1-02's twin given inline, with its plan as output. */
  const inlineTwin = (): Record<string, unknown> => ({
    id: "inline-s1-02",
    kind: "composerPlan",
    request: fixture("input-s1-02-v1.1.json"),
    output: fixture("plan-s1-02.json"),
  });
  const refusalOf = (build: () => RecordedComposer): string => {
    let error: unknown;
    try {
      build();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecordingRefusedError);
    return (error as RecordingRefusedError).problems.join("\n");
  };
  const v1With = (...extra: unknown[]): ComposerFile => {
    const file = composerFile();
    return { ...file, recordings: [...file.recordings, ...(extra as RawRecording[])] };
  };
  const v1dot1With = (...extra: unknown[]): ComposerFile => {
    const file = v1dot1File();
    return { ...file, recordings: [...file.recordings, ...(extra as RawRecording[])] };
  };

  it("refuses S1-02's term facts in a v1 file, and takes the same recording in a v1.1 file", async () => {
    // K-03 v1 neither reads v1.1's fixture nor accepts a term fact.
    const seeded = twinSeeded();
    expect(seeded.id).toBe("composer-s1-02-v1.1");
    expect(refusalOf(() => buildRecordedComposer(v1With(seeded)))).toContain(
      "composer-s1-02-v1.1: the request cannot be read: input-s1-02-v1.1.json is a v1.1 fixture, not v1",
    );
    expect(refusalOf(() => buildRecordedComposer(v1With(inlineTwin())))).toContain(
      "inline-s1-02: the input: /facts/0",
    );
    // K-03 v1.1 takes each of them.
    for (const recording of [seeded, inlineTwin()]) {
      const loaded = buildRecordedComposer({
        version: "v1",
        contract: "message-plan.v1.1",
        recordings: [recording],
      });
      expect(loaded.size).toBe(1);
      expect(await loaded.composer(fixture("input-s1-02-v1.1.json"))).toEqual(fixture("plan-s1-02.json"));
    }
    // A v1.1 file reads v1's fixtures too: every v1 input is a v1.1 input.
    const v1Input = composerFile().recordings[0];
    if (v1Input === undefined) throw new Error("test setup");
    const loaded = buildRecordedComposer({
      version: "v1",
      contract: "message-plan.v1.1",
      recordings: [v1Input],
    });
    expect(await loaded.composer(fixture("input-s1-02.json"))).toEqual(fixture("plan-s1-02.json"));
  });

  it("refuses a file whose contract is a K-03 version the double does not read, and names it among several", () => {
    for (const contract of ["message-plan.v1.2", "model.v1.1", "toString"]) {
      expect(() => buildRecordedComposer({ version: "v1", contract, recordings: [] })).toThrow(
        RecordingRefusedError,
      );
    }
    const text = refusalOf(() =>
      buildRecordedComposerFromFiles({
        [COMPOSER_RECORDINGS_FILE]: composerFile(),
        [COMPOSER_RECORDINGS_V1_1_FILE]: { ...v1dot1File(), contract: "message-plan.v1.2" },
      }),
    );
    expect(text).toContain(`${COMPOSER_RECORDINGS_V1_1_FILE}: the file is not`);
  });

  it("loads both files as one double, and refuses an input or an id recorded in both", async () => {
    const both = buildRecordedComposerFromFiles({
      [COMPOSER_RECORDINGS_FILE]: composerFile(),
      [COMPOSER_RECORDINGS_V1_1_FILE]: v1dot1File(),
    });
    expect(both.size).toBe(composer.size);
    const join = recordingFile(JOIN_INPUT_FILE);
    expect(await both.composer(join)).toEqual(await composer.composer(join));
    const s102 = composerFile().recordings[0];
    if (s102 === undefined) throw new Error("test setup");
    expect(s102.id).toBe("composer-s1-02");
    const repeated = refusalOf(() =>
      buildRecordedComposerFromFiles({
        [COMPOSER_RECORDINGS_FILE]: composerFile(),
        [COMPOSER_RECORDINGS_V1_1_FILE]: v1dot1With({ ...s102, id: "again" }),
      }),
    );
    expect(repeated).toContain("again: has the same input as composer-s1-02");
    const reused = refusalOf(() =>
      buildRecordedComposerFromFiles({
        [COMPOSER_RECORDINGS_FILE]: composerFile(),
        [COMPOSER_RECORDINGS_V1_1_FILE]: v1dot1With({
          ...s102,
          request: { ...fixture("input-s1-02-v1.1.json"), row: "outbox-s1-02-sam-2" },
        }),
      }),
    );
    expect(reused).toContain("composer-s1-02: the id is used twice");
  });

  it("reads K-03 v1 by default and v1.1 when asked, never a version frozen.json does not list", () => {
    expect(PLAN_VERSIONS).toEqual(["v1", "v1.1"]);
    const frozen = readJson(path.join(CONTRACT_DIR, "message-plan", "frozen.json")) as { frozen: string[] };
    expect(frozen.frozen).toEqual([...PLAN_VERSIONS]);
    const twin = fixture("input-s1-02-v1.1.json");
    const v1 = loadPlanContract();
    expect(v1.version).toBe("v1");
    expect(() => v1.fixtures.read("input-s1-02-v1.1.json")).toThrow(
      "input-s1-02-v1.1.json is a v1.1 fixture, not v1",
    );
    expect(v1.validate("composeInput", twin)).not.toEqual([]);
    const v1dot1 = loadPlanContract(undefined, "v1.1");
    expect(v1dot1.version).toBe("v1.1");
    for (const name of ["input-s1-02-v1.1.json", "input-s1-02.json"]) {
      expect(v1dot1.fixtures.read(name)).toEqual(fixture(name));
      expect(v1dot1.validate("composeInput", fixture(name))).toEqual([]);
    }
    expect(v1dot1.validate("plan", fixture("plan-s1-02.json"))).toEqual([]);
    expect(v1dot1.validate("inputAndPlan", fixture("input-and-plan-s1-02.json"))).toEqual([]);
    expect(v1dot1.slotNames).toEqual(v1.slotNames);
    expect(() => v1dot1.fixtures.read("invalid/refuse-plan-s1-02-on-v1-input.json")).toThrow(
      "a fixture K-03 refuses",
    );
    expect(() => loadPlanContract(undefined, "v1.2" as unknown as PlanVersion)).toThrow("not v1.2");
    // A copy of the contracts whose frozen.json lists v1 alone: v1.1 is not read from it, nor the v1.1 file.
    const root = mkdtempSync(path.join(os.tmpdir(), "rosie-k03-"));
    try {
      for (const folder of ["common", "bundle"]) {
        mkdirSync(path.join(root, folder));
        for (const name of readdirSync(path.join(CONTRACT_DIR, folder)).filter((entry) =>
          entry.endsWith(".schema.json"),
        ))
          copyFileSync(path.join(CONTRACT_DIR, folder, name), path.join(root, folder, name));
      }
      cpSync(path.join(CONTRACT_DIR, "message-plan"), path.join(root, "message-plan"), { recursive: true });
      writeFileSync(path.join(root, "message-plan", "frozen.json"), JSON.stringify({ frozen: ["v1"] }));
      expect(() => loadPlanContract(root, "v1.1")).toThrow("K-03 v1.1 is not frozen");
      expect(loadPlanContract(root).version).toBe("v1");
      expect(buildRecordedComposer(composerFile(), { contractsRoot: root }).size).toBe(
        composerFile().recordings.length,
      );
      expect(() => buildRecordedComposer(v1dot1File(), { contractsRoot: root })).toThrow(
        "K-03 v1.1 is not frozen",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the same input twice gives byte-identical answers", () => {
  it("returns the same bytes on every call, for every recording", async () => {
    for (const [, recording] of RECORDED) {
      const input = inputOf(recording);
      const [a, b, c] = [
        await composer.composer(input),
        await composer.composer(input),
        await composer.composer(input),
      ];
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    }
  });

  it("is the same from a second load, and a caller changing a plan changes no later answer", async () => {
    const again = loadRecordedComposer();
    const input = fixture("input-s1-02.json");
    const first = await composer.composer(input);
    const bytes = JSON.stringify(first);
    (first.lines as { text: string }[])[0] = { text: "changed" };
    expect(JSON.stringify(await composer.composer(input))).toBe(bytes);
    expect(JSON.stringify(await again.composer(input))).toBe(bytes);
    const join = recordingFile(JOIN_INPUT_FILE);
    expect(JSON.stringify(await again.composer(join))).toBe(JSON.stringify(await composer.composer(join)));
  });
});

describe("the double with the composer in it", () => {
  it("offers the three K-02 reads and the composer, and the K-02 file alone still has no composer", async () => {
    const double = await loadRecordedDouble();
    expect(Object.keys(double).sort()).toEqual(["composer", "decide", "planner", "safetyRead", "size"]);
    const model = await loadRecordedModel();
    expect(Object.keys(model).sort()).toEqual(["decide", "planner", "safetyRead", "size"]);
    expect(double.size).toBe(model.size + composer.size);
    expect(await double.composer(fixture("input-s1-02.json"))).toEqual(fixture("plan-s1-02.json"));
    expect(await double.composer(recordingFile(JOIN_INPUT_FILE))).toEqual(fixture("plan-s1-02.json"));
    const planner = recordingFile("contexts/planner-answer.json");
    expect(await double.planner({ context: planner })).toEqual(await model.planner({ context: planner }));
  });
});

describe("no network", () => {
  it("runs with outbound fetch stubbed to throw, and never calls it", async () => {
    expect(() => fetch("https://api.anthropic.com/v1/messages")).toThrow("no network");
    fetchStub.mockClear();
    const loaded = loadRecordedComposer();
    await loaded.composer(fixture("input-s1-02.json"));
    await loaded.composer(fixture("input-s1-02.json"));
    await loaded.composer(fixture("input-s1-02-v1.1.json"));
    await composeOnDouble(recordingFile(JOIN_INPUT_FILE));
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
