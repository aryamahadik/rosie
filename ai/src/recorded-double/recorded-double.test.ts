// Tests of the recorded-model double (T-004, C-123), against K-02's fixtures: v1's, and v1.1's for the walking
// skeleton's turn 1 (T-1145; contracts/model/README.md "v1.1", the recordings the double needs). Deterministic and
// offline: outbound fetch is stubbed to throw for the whole file, and a test fails if anything calls it.

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

import {
  MODEL_VERSIONS,
  NoRecordingError,
  RECORDINGS_FILE,
  RECORDINGS_FILES,
  RECORDINGS_V1_1_FILE,
  RecordingRefusedError,
  buildRecordedModel,
  buildRecordedModelFromFiles,
  canonicalJson,
  loadModelContract,
  loadRecordedModel,
  requestKey,
  type DecideRole,
  type JsonObject,
  type ModelVersion,
  type RecordedModel,
} from "./index";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTRACT_DIR = path.join(REPO_ROOT, "contracts");
const FIXTURES_DIR = path.join(CONTRACT_DIR, "model", "fixtures");
const RECORDINGS_DIR = path.join(REPO_ROOT, "ai", "recordings");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}
const fixture = (file: string): Record<string, unknown> =>
  readJson(path.join(FIXTURES_DIR, file)) as Record<string, unknown>;
interface RecordingsFile {
  version: string;
  contract: string;
  recordings: Record<string, unknown>[];
}
const recordingsFile = (): RecordingsFile =>
  readJson(path.join(RECORDINGS_DIR, "recordings.v1.json")) as RecordingsFile;
/** K-02 v1.1's recordings: the walking skeleton's turn 1 (T-1145). */
const v1dot1File = (): RecordingsFile =>
  readJson(path.join(RECORDINGS_DIR, "recordings.v1.1.json")) as RecordingsFile;
/** A context file of ai/recordings, by its path there. */
const recordedContext = (file: string): JsonObject => readJson(path.join(RECORDINGS_DIR, file)) as JsonObject;

// An independent validator, as T-081's contract test builds it, so the double is not the judge of its own answers.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const folder of ["common", "bundle", "model"]) {
  const dir = path.join(CONTRACT_DIR, folder);
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".schema.json")))
    ajv.addSchema(readJson(path.join(dir, name)) as object);
}
const schemaIdOf = (version: ModelVersion): string =>
  (readJson(path.join(CONTRACT_DIR, "model", `model.${version}.schema.json`)) as { $id: string }).$id;
const SCHEMA_ID = schemaIdOf("v1");
function accepts(def: string, value: unknown): boolean {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`no schema for ${def}`);
  return validate(value) as boolean;
}
/** Whether K-02 at `version` accepts `value` as `$defs/<def>`, by the independent validator. */
function acceptsAt(version: ModelVersion, def: string, value: unknown): boolean {
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
/** The accepted fixtures of one $defs entry, of every version or of the one named. */
const acceptedOf = (def: string, version?: string): string[] =>
  index
    .filter(
      (entry) =>
        entry.expect === "accept" &&
        entry.def === def &&
        (version === undefined || entry.version === version),
    )
    .map((entry) => entry.file);

/** A value a test must find; a miss is a broken test. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("the test's setup lacks a value it reads");
  return value;
}

// ---- K-02 v1.1: the walking skeleton's turn 1 (T-1145; README "v1.1", the recordings the double needs) ----------

/** The JOIN text and its time, as tests/e2e/skeleton sends them (its JOIN event: body JOIN, sentAt 14:01:49Z). */
const JOIN_WORDS = "JOIN";
const JOIN_SENT_UTC = "2026-10-19T14:01:49Z";
/** The JOIN run's context, recording 2's, in ai/recordings. */
const JOIN_CONTEXT_FILE = "contexts/join-s1-01.json";

interface TurnText {
  eventId: string;
  words: string;
  sentAt: { utc: string; zone: string };
}
interface TurnChoice {
  choiceId: string;
  kind: string;
  door: string | null;
  step: string;
  stakes: string;
  fields: unknown[];
}
/** A K-02 context, as far as these tests read it. */
interface TurnContext extends JsonObject {
  turnId: string;
  bundleId: unknown;
  texts: TurnText[];
  choices: TurnChoice[];
}
interface DecideOutput extends JsonObject {
  language: string;
  parts: JsonObject[];
}
/** A K-02 decideResult fixture, as far as these tests read it. */
interface DecideFixture {
  stakes: string;
  routing: { first: string; second: string };
  reads: { model: string; role: DecideRole; output: DecideOutput }[];
  agreed: boolean;
  reread: boolean;
  parts: { outcome: string }[];
}
interface TraceSpan {
  hop: string;
  event_id?: string;
  decided?: Record<string, unknown>;
  model_calls?: { model: string; purpose: string }[];
}
/** K-08 v1's trace of the skeleton's JOIN run (the card's "the JOIN run's ids"): its turn, bundle and spans. */
const TRACE = readJson(path.join(CONTRACT_DIR, "event-trace", "fixtures", "trace-skeleton.json")) as {
  turn_id: string;
  bundle_id: unknown;
  spans: TraceSpan[];
};
const spanOf = (hop: string): TraceSpan => must(TRACE.spans.find((span) => span.hop === hop));

/** A read with every part's quote replaced: decide-s1-01-enter.json's read as the JOIN run's quote gives it. */
const withQuote = (output: DecideOutput, quote: string): JsonObject => ({
  ...output,
  parts: output.parts.map((part) => ({ ...part, quote })),
});

/** What a recording's request names as its context: a K-02 fixture's file, or a path in ai/recordings. */
function contextNameOf(recording: Record<string, unknown>): string {
  const context = (recording.request as { context: { fixture?: string; file?: string } }).context;
  return must(context.fixture ?? context.file);
}
const unique = (names: readonly string[]): string[] => [...new Set(names)];

const fetchStub = vi.fn(() => {
  throw new Error("no network in a double test: outbound fetch was called");
});
let model: RecordedModel;

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);
  model = await loadRecordedModel();
});
afterAll(() => {
  expect(fetchStub).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("the context fixtures: each gets its paired decide answer", () => {
  // K-02 v1's contexts, by version, in recordings.v1.json; v1.1's context-s1-01.json has its recordings in
  // recordings.v1.1.json (T-1145; ADR-013, new task 1), pinned below in "turn 1".
  const contexts = acceptedOf("context", "v1");
  const decides = acceptedOf("decideResult");

  it("holds every accepted K-02 v1 context fixture, and pairs each with one decide fixture", () => {
    expect(contexts).toEqual(["context-s1-02.json", "context-two-requests.json"]);
    const recordings = recordingsFile().recordings.filter((entry) => entry.kind === "decideRead");
    const pairs = contexts.map((context) =>
      decides.filter((decide) =>
        recordings.some(
          (entry) =>
            (entry.request as { context: { fixture: string } }).context.fixture === context &&
            (entry.seed as { fixture: string }).fixture === decide,
        ),
      ),
    );
    expect(pairs).toEqual([["decide-s1-02-choose.json"], ["decide-two-requests.json"]]);
  });

  for (const [context, decide] of [
    ["context-s1-02.json", "decide-s1-02-choose.json"],
    ["context-two-requests.json", "decide-two-requests.json"],
  ] as const) {
    it(`${context}: each read of ${decide} comes back, and validates as a decideRead`, async () => {
      const result = fixture(decide) as { reads: { role: DecideRole; output: unknown }[] };
      for (const read of result.reads) {
        const answer = await model.decide({
          context: fixture(context),
          role: read.role,
        });
        expect(answer).toEqual(read.output);
        expect(accepts("decideRead", answer)).toBe(true);
      }
    });
  }
});

describe("the safety read fixtures", () => {
  const answered = acceptedOf("safetyResult").filter(
    (file) => (fixture(file) as { read: unknown }).read !== null,
  );

  it("seeds one recording from every accepted safety fixture that holds a read (a timeout holds none)", () => {
    const seeded = recordingsFile()
      .recordings.filter((entry) => entry.kind === "safetyRead")
      .map((entry) => (entry.seed as { fixture: string }).fixture);
    expect(seeded.sort()).toEqual([...answered].sort());
    expect(answered).toHaveLength(9);
  });

  for (const file of answered) {
    it(`${file}: its text gets its read, which validates as a safetyRead`, async () => {
      const recording = recordingsFile().recordings.find(
        (entry) => (entry.seed as { fixture: string }).fixture === file,
      );
      const text = (recording?.request as { text: string }).text;
      const expected = (fixture(file) as { read: { labels: { evidence: string }[] } }).read;
      // The synthetic text holds the evidence the read quotes.
      for (const label of expected.labels) expect(text).toContain(label.evidence);
      const answer = await model.safetyRead({ text });
      expect(answer).toEqual(expected);
      expect(accepts("safetyRead", answer)).toBe(true);
    });
  }
});

describe("the planner fixtures", () => {
  for (const file of acceptedOf("plannerOutput")) {
    it(`${file}: its context gets it, and it validates as a plannerOutput`, async () => {
      const recording = recordingsFile().recordings.find(
        (entry) => (entry.seed as { fixture: string }).fixture === file,
      );
      const ref = (recording?.request as { context: { file: string } }).context.file;
      const context = readJson(path.join(RECORDINGS_DIR, ref)) as JsonObject;
      expect(accepts("context", context)).toBe(true);
      const answer = await model.planner({ context });
      expect(answer).toEqual(fixture(file));
      expect(accepts("plannerOutput", answer)).toBe(true);
    });
  }
});

describe("a request with no recording fails loudly", () => {
  const sam = fixture("context-s1-02.json") as JsonObject;

  it("rejects a safety text, a context and a role it holds no recording for, naming the kind", async () => {
    await expect(model.safetyRead({ text: "Do you take walk-ins?" })).rejects.toThrow(NoRecordingError);
    await expect(model.safetyRead({ text: "Do you take walk-ins?" })).rejects.toThrow(/safetyRead/);
    await expect(model.decide({ context: sam, role: "reread" })).rejects.toThrow(NoRecordingError);
    await expect(model.planner({ context: sam })).rejects.toThrow(/plannerOutput/);
    await expect(
      model.decide({ context: { ...sam, turnId: "turn-never-recorded" }, role: "first" }),
    ).rejects.toThrow(NoRecordingError);
  });

  it("answers nothing for a request that differs by one character", async () => {
    await expect(
      model.safetyRead({ text: "Can I book a haircut for Saturday at 2? " }),
    ).rejects.toBeInstanceOf(NoRecordingError);
  });

  it("rejects a request JSON cannot hold, never answers it", async () => {
    await expect(model.decide({ context: { turnId: undefined }, role: "first" })).rejects.toThrow(TypeError);
  });

  it("holds no composer: K-02 has no composer output, so the double offers only the three reads", () => {
    expect(Object.keys(model).sort()).toEqual(["decide", "planner", "safetyRead", "size"]);
    expect(model.size).toBe(recordingsFile().recordings.length + v1dot1File().recordings.length);
  });
});

describe("a recording the K-02 schema or rules refuse is refused at load", () => {
  const sam = fixture("context-s1-02.json");
  const inlineRead = (parts: unknown[]): unknown => ({ language: "en", parts });
  const good = (): Record<string, unknown> => ({
    id: "extra",
    kind: "decideRead",
    request: { context: sam, role: "reread" },
    output: inlineRead([
      {
        verb: "choose",
        quote: "Barbershop, plumbing, electrical",
        question: "oq-s1-02",
        choice: "c-01",
        fields: [
          {
            name: "kinds",
            value: "Barbershop, plumbing, electrical",
            words: "Barbershop, plumbing, electrical",
          },
        ],
      },
    ]),
  });
  const withRecording = (...extra: Record<string, unknown>[]): unknown => {
    const file = recordingsFile();
    return { ...file, recordings: [...file.recordings, ...extra] };
  };
  const refusal = async (file: unknown): Promise<RecordingRefusedError> => {
    const error = await buildRecordedModel(file).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RecordingRefusedError);
    return error as RecordingRefusedError;
  };

  it("loads the extra recording once it is whole (the refusals below each break one thing)", async () => {
    const loaded = await buildRecordedModel(withRecording(good()));
    expect(loaded.size).toBe(recordingsFile().recordings.length + 1);
    expect(await loaded.decide({ context: sam, role: "reread" })).toEqual(good().output);
    await expect(model.decide({ context: sam, role: "reread" })).rejects.toThrow(NoRecordingError);
  });

  it("refuses a decide answer with a verb that is none of the eight", async () => {
    const bad = good();
    bad.output = inlineRead([{ verb: "book", quote: "Barbershop", choice: "c-01" }]);
    const error = await refusal(withRecording(bad));
    expect(error.problems.join("\n")).toContain("extra: the answer against decideRead");
  });

  it("refuses a field with a value and empty words", async () => {
    const bad = good();
    const part = (bad.output as { parts: { fields: { words: string }[] }[] }).parts[0];
    if (part === undefined) throw new Error("test setup");
    part.fields[0] = { ...part.fields[0], words: "" };
    const error = await refusal(withRecording(bad));
    expect(error.problems.join("\n")).toContain("extra: the answer against decideRead");
  });

  it("refuses a planner answer that books", async () => {
    const error = await refusal(
      withRecording({
        id: "books",
        kind: "plannerOutput",
        request: { context: { file: "contexts/planner-log-gap.json" } },
        output: { language: "en", action: { verb: "book", summary: "booked" } },
      }),
    );
    expect(error.problems.join("\n")).toContain("books: the answer against plannerOutput");
  });

  it("refuses a safety answer with an outcome that is none of the nine", async () => {
    const error = await refusal(
      withRecording({
        id: "bad-safety",
        kind: "safetyRead",
        request: { text: "Is the shop open?" },
        output: {
          labels: [
            {
              outcome: "Maybe",
              tense: "now",
              evidence: "",
              atRisk: "nobody",
              writer: "the person at the handle",
            },
          ],
        },
      }),
    );
    expect(error.problems.join("\n")).toContain("bad-safety: the answer against safetyRead");
  });

  it("refuses a decide answer that chooses a choice the context does not offer (optionOffered)", async () => {
    const bad = good();
    must((bad.output as { parts: { choice: string }[] }).parts[0]).choice = "c-99";
    const error = await refusal(withRecording(bad));
    expect(error.problems.join("\n")).toContain("extra: rule optionOffered");
    expect(error.problems.join("\n")).toContain("c-99");
  });

  it("refuses a decide answer whose quote is not in the turn's texts (quoteInText)", async () => {
    const bad = good();
    must((bad.output as { parts: { quote: string }[] }).parts[0]).quote = "Barbershop and plumbing";
    const error = await refusal(withRecording(bad));
    expect(error.problems.join("\n")).toContain("extra: rule quoteInText");
  });

  it("refuses a context the schema refuses (61 choices)", async () => {
    const choices = (sam as { choices: unknown[] }).choices;
    const crowded = { ...sam, choices: Array.from({ length: 61 }, (_, k) => choices[k % choices.length]) };
    const error = await refusal(
      withRecording({
        id: "too-many",
        kind: "plannerOutput",
        request: { context: crowded },
        seed: { fixture: "planner-log-gap.json" },
      }),
    );
    expect(error.problems.join("\n")).toContain(
      "too-many: the context: /choices must NOT have more than 60 items",
    );
  });

  it("refuses a seed that is a fixture K-02 refuses, or one it does not list", async () => {
    const refused = await refusal(
      withRecording({
        id: "seed-refused",
        kind: "plannerOutput",
        request: { context: { file: "contexts/planner-log-gap.json" } },
        seed: { fixture: "invalid/refuse-planner-books.json" },
      }),
    );
    expect(refused.problems.join("\n")).toContain("a fixture K-02 refuses");
    const unlisted = await refusal(
      withRecording({
        id: "seed-unlisted",
        kind: "plannerOutput",
        request: { context: { file: "contexts/planner-log-gap.json" } },
        seed: { fixture: "planner-made-up.json" },
      }),
    );
    expect(unlisted.problems.join("\n")).toContain("not listed");
  });

  it("refuses a safety seed that timed out (no model answer), and a decide seed of another turn", async () => {
    const timeout = await refusal(
      withRecording({
        id: "timeout",
        kind: "safetyRead",
        request: { text: "there is a cut that won't stop bleeding" },
        seed: { fixture: "safety-timeout-danger-word.json" },
      }),
    );
    expect(timeout.problems.join("\n")).toContain("holds no model answer to replay");
    const other = await refusal(
      withRecording({
        id: "other-turn",
        kind: "decideRead",
        request: { context: { fixture: "context-s1-02.json" }, role: "first" },
        seed: { fixture: "decide-two-requests.json" },
      }),
    );
    expect(other.problems.join("\n")).toContain("another turn or bundle");
  });

  it("refuses a planner answer naming a fact the context does not hold", async () => {
    const error = await refusal(
      withRecording({
        id: "ghost-fact",
        kind: "plannerOutput",
        request: { context: { file: "contexts/planner-log-gap.json" } },
        seed: { fixture: "planner-answer.json" },
      }),
    );
    expect(error.problems.join("\n")).toContain("the fact pay.noshow, which the context does not hold");
  });

  it("refuses a composer recording and any other kind K-02 has no model-facing output for", async () => {
    const error = await refusal(
      withRecording({ id: "composer", kind: "composer", request: { text: "x" }, output: {} }),
    );
    expect(error.problems.join("\n")).toContain(
      'composer: kind "composer" is not one of K-02\'s model-facing outputs',
    );
  });

  it("refuses two recordings of one request, and a repeated id", async () => {
    const first = recordingsFile().recordings[4];
    if (first === undefined) throw new Error("test setup");
    const error = await refusal(withRecording({ ...first, id: "again" }, { ...first }));
    const lines = error.problems.join("\n");
    expect(lines).toContain("again: has the same request as safety-no");
    expect(lines).toContain("the id is used twice");
  });

  it("names every problem at once and loads nothing", async () => {
    const one = good();
    one.id = "one";
    one.output = inlineRead([{ verb: "book" }]);
    const two: Record<string, unknown> = {
      ...good(),
      id: "two",
      request: { context: sam, role: "check" },
    };
    must((two.output as { parts: { choice: string }[] }).parts[0]).choice = "c-99";
    const error = await refusal(withRecording(one, two));
    expect(error.problems.some((line) => line.startsWith("one:"))).toBe(true);
    expect(error.problems.some((line) => line.startsWith("two:"))).toBe(true);
  });

  it("refuses a recordings file that is not the v1 shape", async () => {
    await expect(buildRecordedModel({ version: "v2", recordings: [] })).rejects.toThrow(
      RecordingRefusedError,
    );
    await expect(buildRecordedModel([])).rejects.toThrow(RecordingRefusedError);
  });

  it("refuses a context file outside ai/recordings", async () => {
    const error = await refusal(
      withRecording({
        id: "escape",
        kind: "plannerOutput",
        request: { context: { file: "../recordings.v1.json" } },
        seed: { fixture: "planner-log-gap.json" },
      }),
    );
    expect(error.problems.join("\n")).toContain("escape: the request cannot be read");
  });
});

describe("turn 1 (K-02 v1.1): the recordings the README names, every context pinned by version", () => {
  const s101 = (): TurnContext => fixture("context-s1-01.json") as TurnContext;
  const enter = (): DecideFixture => fixture("decide-s1-01-enter.json") as unknown as DecideFixture;
  const joinContext = (): TurnContext => recordedContext(JOIN_CONTEXT_FILE) as TurnContext;
  /** K-02 v1.1's decide recordings, in the file's order. */
  const decideRecordings = (): Record<string, unknown>[] =>
    v1dot1File().recordings.filter((entry) => entry.kind === "decideRead");

  it("pins every context it knows by its K-02 version, each accepted by its own version's schema", () => {
    expect(MODEL_VERSIONS).toEqual(["v1", "v1.1"]);
    const frozen = readJson(path.join(CONTRACT_DIR, "model", "frozen.json")) as { frozen: string[] };
    expect(frozen.frozen).toEqual([...MODEL_VERSIONS]);
    // K-02's context fixtures by version: v1's two and v1.1's turn 1; no other version holds one.
    expect(acceptedOf("context", "v1")).toEqual(["context-s1-02.json", "context-two-requests.json"]);
    expect(acceptedOf("context", "v1.1")).toEqual(["context-s1-01.json"]);
    expect(acceptedOf("context")).toHaveLength(3);
    // Every context a recording names, by the file that holds it, and so by the version it is checked against.
    expect(RECORDINGS_FILES).toEqual([RECORDINGS_FILE, RECORDINGS_V1_1_FILE]);
    expect([recordingsFile().contract, v1dot1File().contract]).toEqual(["model.v1", "model.v1.1"]);
    const known = (file: RecordingsFile): string[] =>
      unique(file.recordings.filter((entry) => entry.kind !== "safetyRead").map(contextNameOf));
    const byVersion: Record<ModelVersion, string[]> = {
      v1: known(recordingsFile()),
      "v1.1": known(v1dot1File()),
    };
    expect(byVersion).toEqual({
      v1: [
        "context-s1-02.json",
        "context-two-requests.json",
        "contexts/planner-answer.json",
        "contexts/planner-log-gap.json",
        "contexts/planner-hand-off.json",
      ],
      "v1.1": ["context-s1-01.json", JOIN_CONTEXT_FILE],
    });
    const contextOf = (name: string): unknown =>
      name.startsWith("contexts/") ? recordedContext(name) : fixture(name);
    // A v1 context is a v1.1 context too; a context with the sign-up door is v1.1's alone.
    for (const name of byVersion.v1) {
      expect(acceptsAt("v1", "context", contextOf(name))).toBe(true);
      expect(acceptsAt("v1.1", "context", contextOf(name))).toBe(true);
    }
    for (const name of byVersion["v1.1"]) {
      expect(acceptsAt("v1.1", "context", contextOf(name))).toBe(true);
      expect(acceptsAt("v1", "context", contextOf(name))).toBe(false);
    }
  });

  it("decide on context-s1-01.json: both Haiku reads enter c-01, the sign-up door, with no re-read", async () => {
    const context = s101();
    const decide = enter();
    // The one choice: c-01, the sign-up door to S1-01, low stakes, no field (README "v1.1" default 9).
    expect(context.choices).toHaveLength(1);
    expect(must(context.choices[0])).toMatchObject({
      choiceId: "c-01",
      kind: "door",
      door: "signUp",
      step: "S1-01",
      stakes: "low",
      fields: [],
    });
    // decide-s1-01-enter.json: two Haiku reads, first and check, agreed, no re-read, the part goes (default 10).
    expect(decide.routing).toEqual({ first: "haiku", second: "haiku" });
    expect(decide.reads.map((read) => [read.model, read.role])).toEqual([
      ["haiku", "first"],
      ["haiku", "check"],
    ]);
    expect([decide.stakes, decide.agreed, decide.reread]).toEqual(["low", true, false]);
    expect(decide.parts.map((part) => part.outcome)).toEqual(["go"]);
    // The double holds exactly those two reads for this context, each seeded from that fixture.
    const recorded = decideRecordings().filter((entry) => contextNameOf(entry) === "context-s1-01.json");
    expect(
      recorded.map((entry) => [
        entry.kind,
        (entry.request as { role: string }).role,
        (entry.seed as { fixture: string }).fixture,
      ]),
    ).toEqual([
      ["decideRead", "first", "decide-s1-01-enter.json"],
      ["decideRead", "check", "decide-s1-01-enter.json"],
    ]);
    for (const read of decide.reads) {
      const answer = await model.decide({ context, role: read.role });
      expect(answer).toEqual(read.output);
      expect(answer).toEqual({
        language: "en",
        parts: [{ verb: "enter", quote: must(context.texts[0]).words, choice: "c-01", fields: [] }],
      });
      expect(acceptsAt("v1.1", "decideRead", answer)).toBe(true);
    }
    // No re-read: the double holds none for this turn, and asking for one fails loudly.
    await expect(model.decide({ context, role: "reread" })).rejects.toThrow(NoRecordingError);
  });

  it("decide on the JOIN run's context: both reads enter c-01 with the quote JOIN, decide-s1-01-enter.json's reads otherwise", async () => {
    const join = joinContext();
    const base = s101();
    const text = must(base.texts[0]);
    // context-s1-01.json with only the JOIN run's turn id and its one text changed (README "v1.1" recording 2).
    expect({ ...join, turnId: base.turnId, texts: base.texts }).toEqual(base);
    // The JOIN run's ids are K-08 trace-skeleton.json's: its turn, its one event, its bundle.
    expect(join.turnId).toBe(TRACE.turn_id);
    expect(join.bundleId).toEqual(TRACE.bundle_id);
    expect(join.texts).toEqual([
      {
        ...text,
        eventId: spanOf("receive").event_id,
        words: JOIN_WORDS,
        sentAt: { utc: JOIN_SENT_UTC, zone: text.sentAt.zone },
      },
    ]);
    // K-08's frontier and decide spans of that run: one door, S1-01, low stakes; two Haiku reads agreeing on enter, no
    // re-read.
    expect(spanOf("frontier").decided).toEqual({
      choices: join.choices.length,
      doors: [must(join.choices[0]).step],
      stakes: "low",
    });
    expect(spanOf("decideReads").decided).toEqual({
      readsAgree: true,
      verb: "enter",
      choice: "S1-01",
      reread: false,
    });
    expect(must(spanOf("decideReads").model_calls).map((call) => [call.model, call.purpose])).toEqual([
      ["claude-haiku-5-5", "decideFirst"],
      ["claude-haiku-5-5", "decideCheck"],
    ]);
    // Each recorded read is decide-s1-01-enter.json's own read in its role, with the quote JOIN.
    const recorded = decideRecordings().filter((entry) => contextNameOf(entry) === JOIN_CONTEXT_FILE);
    expect(recorded.map((entry) => (entry.request as { role: string }).role)).toEqual(["first", "check"]);
    for (const read of enter().reads) {
      const written = recorded.find((entry) => (entry.request as { role: string }).role === read.role);
      expect(must(written).output).toEqual(withQuote(read.output, JOIN_WORDS));
      const answer = await model.decide({ context: join, role: read.role });
      expect(answer).toEqual(withQuote(read.output, JOIN_WORDS));
      expect(answer).toEqual({
        language: "en",
        parts: [{ verb: "enter", quote: "JOIN", choice: "c-01", fields: [] }],
      });
      expect(acceptsAt("v1.1", "decideRead", answer)).toBe(true);
    }
    await expect(model.decide({ context: join, role: "reread" })).rejects.toThrow(NoRecordingError);
  });

  it("the safety reads of JOIN and of the master's words each read No, seeded from safety-no.json", async () => {
    const masterWords = must(s101().texts[0]).words;
    const recorded = v1dot1File().recordings.filter((entry) => entry.kind === "safetyRead");
    expect(
      recorded.map((entry) => [
        (entry.request as { text: string }).text,
        (entry.seed as { fixture: string }).fixture,
      ]),
    ).toEqual([
      [JOIN_WORDS, "safety-no.json"],
      [masterWords, "safety-no.json"],
    ]);
    const no = (fixture("safety-no.json") as { read: { labels: { outcome: string }[] } }).read;
    expect(no.labels.map((label) => label.outcome)).toEqual(["No"]);
    for (const text of [JOIN_WORDS, masterWords]) {
      const answer = await model.safetyRead({ text });
      expect(answer).toEqual(no);
      expect((answer.labels as { outcome: string }[]).map((label) => label.outcome)).toEqual(["No"]);
      expect(acceptsAt("v1.1", "safetyRead", answer)).toBe(true);
    }
    // K-08's safety span of the JOIN run reads No too.
    expect(spanOf("safetyRead").decided).toEqual({ labels: ["No"], dangerWords: 0, timedOut: false });
  });

  it("fails loudly for a turn 1 request it holds no recording for, never with a made-up answer", async () => {
    const base = s101();
    const join = joinContext();
    // The master's words under the JOIN run's turn id, and JOIN under the fixture's: contexts nobody recorded.
    await expect(model.decide({ context: { ...base, turnId: join.turnId }, role: "first" })).rejects.toThrow(
      NoRecordingError,
    );
    await expect(model.decide({ context: { ...join, turnId: base.turnId }, role: "check" })).rejects.toThrow(
      NoRecordingError,
    );
    // The JOIN run on another bundle.
    await expect(
      model.decide({ context: { ...join, bundleId: { hash: "0".repeat(64), build: 1 } }, role: "first" }),
    ).rejects.toThrow(/decideRead/);
    // A safety text one character off.
    await expect(model.safetyRead({ text: "join" })).rejects.toThrow(NoRecordingError);
    await expect(model.safetyRead({ text: `${JOIN_WORDS} ` })).rejects.toThrow(NoRecordingError);
    // The planner holds nothing for turn 1.
    await expect(model.planner({ context: base })).rejects.toThrow(/plannerOutput/);
  });
});

describe("the double reads K-02 v1.1, each file by its own version", () => {
  const firstRead = (): DecideOutput =>
    must((fixture("decide-s1-01-enter.json") as unknown as DecideFixture).reads[0]).output;
  /** Turn 1's first read with its context inline, given as output. */
  const inlineTurn1 = (): Record<string, unknown> => ({
    id: "inline-s1-01",
    kind: "decideRead",
    request: { context: fixture("context-s1-01.json"), role: "first" },
    output: firstRead(),
  });
  const refusalOf = async (built: Promise<RecordedModel>): Promise<string> => {
    const error = await built.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RecordingRefusedError);
    return (error as RecordingRefusedError).problems.join("\n");
  };
  const v1With = (...extra: Record<string, unknown>[]): RecordingsFile => {
    const file = recordingsFile();
    return { ...file, recordings: [...file.recordings, ...extra] };
  };
  const v1dot1With = (...extra: Record<string, unknown>[]): RecordingsFile => {
    const file = v1dot1File();
    return { ...file, recordings: [...file.recordings, ...extra] };
  };

  it("refuses turn 1's sign-up door in a v1 file, and takes the same recording in a v1.1 file", async () => {
    // K-02 v1 neither reads v1.1's fixture nor accepts the sign-up door.
    const seeded = must(v1dot1File().recordings[0]);
    expect(seeded.id).toBe("decide-s1-01-first");
    expect(await refusalOf(buildRecordedModel(v1With(seeded)))).toContain(
      "decide-s1-01-first: the request cannot be read: context-s1-01.json is a v1.1 fixture, not v1",
    );
    expect(await refusalOf(buildRecordedModel(v1With(inlineTurn1())))).toContain(
      "inline-s1-01: the context: /choices/0/door",
    );
    // K-02 v1.1 takes each of them.
    for (const recording of [seeded, inlineTurn1()]) {
      const loaded = await buildRecordedModel({
        version: "v1",
        contract: "model.v1.1",
        recordings: [recording],
      });
      expect(loaded.size).toBe(1);
      expect(await loaded.decide({ context: fixture("context-s1-01.json"), role: "first" })).toEqual(
        firstRead(),
      );
    }
  });

  it("refuses a file whose contract is a K-02 version the double does not read, and names it among several", async () => {
    await expect(
      buildRecordedModel({ version: "v1", contract: "model.v1.2", recordings: [] }),
    ).rejects.toThrow(RecordingRefusedError);
    await expect(
      buildRecordedModel({ version: "v1", contract: "message-plan.v1", recordings: [] }),
    ).rejects.toThrow(RecordingRefusedError);
    await expect(buildRecordedModel({ version: "v1", contract: "toString", recordings: [] })).rejects.toThrow(
      RecordingRefusedError,
    );
    const lines = await refusalOf(
      buildRecordedModelFromFiles({
        [RECORDINGS_FILE]: recordingsFile(),
        [RECORDINGS_V1_1_FILE]: { ...v1dot1File(), contract: "model.v1.2" },
      }),
    );
    expect(lines).toContain(`${RECORDINGS_V1_1_FILE}: the file is not`);
  });

  it("loads both files as one double, and refuses a request or an id recorded in both", async () => {
    const both = await buildRecordedModelFromFiles({
      [RECORDINGS_FILE]: recordingsFile(),
      [RECORDINGS_V1_1_FILE]: v1dot1File(),
    });
    expect(both.size).toBe(model.size);
    expect(await both.safetyRead({ text: JOIN_WORDS })).toEqual(await model.safetyRead({ text: JOIN_WORDS }));
    const safetyNo = must(recordingsFile().recordings[4]);
    expect(safetyNo.id).toBe("safety-no");
    const repeated = await refusalOf(
      buildRecordedModelFromFiles({
        [RECORDINGS_FILE]: recordingsFile(),
        [RECORDINGS_V1_1_FILE]: v1dot1With({ ...safetyNo, id: "again" }),
      }),
    );
    expect(repeated).toContain("again: has the same request as safety-no");
    const reused = await refusalOf(
      buildRecordedModelFromFiles({
        [RECORDINGS_FILE]: recordingsFile(),
        [RECORDINGS_V1_1_FILE]: v1dot1With({ ...safetyNo, request: { text: "Is the shop open today?" } }),
      }),
    );
    expect(reused).toContain("safety-no: the id is used twice");
  });

  it("reads K-02 v1 by default and v1.1 when asked, never a version frozen.json does not list", async () => {
    const v1 = await loadModelContract();
    expect(v1.version).toBe("v1");
    expect(() => v1.fixtures.read("context-s1-01.json")).toThrow(
      "context-s1-01.json is a v1.1 fixture, not v1",
    );
    expect(v1.validate("context", fixture("context-s1-01.json"))).not.toEqual([]);
    const v1dot1 = await loadModelContract(undefined, "v1.1");
    expect(v1dot1.version).toBe("v1.1");
    for (const name of ["context-s1-01.json", "context-s1-02.json"]) {
      expect(v1dot1.fixtures.read(name)).toEqual(fixture(name));
      expect(v1dot1.validate("context", fixture(name))).toEqual([]);
    }
    expect(() => v1dot1.fixtures.read("invalid/refuse-over-60-choices.json")).toThrow(
      "a fixture K-02 refuses",
    );
    await expect(loadModelContract(undefined, "v1.2" as unknown as ModelVersion)).rejects.toThrow("not v1.2");
    // A copy of the contracts whose frozen.json lists v1 alone: v1.1 is not read from it.
    const root = mkdtempSync(path.join(os.tmpdir(), "rosie-k02-"));
    try {
      for (const folder of ["common", "bundle"]) {
        mkdirSync(path.join(root, folder));
        for (const name of readdirSync(path.join(CONTRACT_DIR, folder)).filter((entry) =>
          entry.endsWith(".schema.json"),
        ))
          copyFileSync(path.join(CONTRACT_DIR, folder, name), path.join(root, folder, name));
      }
      cpSync(path.join(CONTRACT_DIR, "model"), path.join(root, "model"), { recursive: true });
      writeFileSync(path.join(root, "model", "frozen.json"), JSON.stringify({ frozen: ["v1"] }));
      await expect(loadModelContract(root, "v1.1")).rejects.toThrow("K-02 v1.1 is not frozen");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the same request twice gives byte-identical answers", () => {
  it("returns the same bytes on every call, for every kind", async () => {
    const sam = fixture("context-s1-02.json") as JsonObject;
    const planner = readJson(path.join(RECORDINGS_DIR, "contexts", "planner-answer.json")) as JsonObject;
    const calls: (() => Promise<unknown>)[] = [
      () => model.decide({ context: sam, role: "first" }),
      () => model.safetyRead({ text: "if Riley messes up my hair again I'll hurt him" }),
      () => model.planner({ context: planner }),
    ];
    for (const call of calls) {
      const [a, b, c] = [await call(), await call(), await call()];
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    }
  });

  it("gives turn 1's answers byte for byte on every call and from a second load (K-02 v1.1)", async () => {
    const again = await loadRecordedModel();
    const calls: ((double: RecordedModel) => Promise<unknown>)[] = [
      (double) => double.decide({ context: fixture("context-s1-01.json"), role: "first" }),
      (double) => double.decide({ context: recordedContext(JOIN_CONTEXT_FILE), role: "check" }),
      (double) => double.safetyRead({ text: JOIN_WORDS }),
    ];
    for (const call of calls) {
      const [a, b, c] = [await call(model), await call(model), await call(again)];
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    }
  });

  it("is the same from a second load, and a caller changing an answer changes no later answer", async () => {
    const again = await loadRecordedModel();
    const request = { text: "my lips are swelling after the beard color and I can't breathe well" };
    const first = await model.safetyRead(request);
    const bytes = JSON.stringify(first);
    must((first.labels as { outcome: string }[])[0]).outcome = "No";
    expect(JSON.stringify(await model.safetyRead(request))).toBe(bytes);
    expect(JSON.stringify(await again.safetyRead(request))).toBe(bytes);
  });

  it("keys a request by its content, not by the order its properties are written in", async () => {
    const sam = fixture("context-s1-02.json");
    const shuffled: JsonObject = Object.fromEntries(Object.entries(sam).reverse());
    expect(canonicalJson(shuffled)).toBe(canonicalJson(sam));
    expect(requestKey("decideRead", { context: shuffled, role: "first" })).toBe(
      requestKey("decideRead", { role: "first", context: sam }),
    );
    expect(await model.decide({ context: shuffled, role: "first" })).toEqual(
      await model.decide({ context: sam, role: "first" }),
    );
  });
});

describe("no network", () => {
  it("runs with outbound fetch stubbed to throw, and never calls it", async () => {
    expect(() => fetch("https://api.anthropic.com/v1/messages")).toThrow("no network");
    fetchStub.mockClear();
    const loaded = await loadRecordedModel();
    await loaded.safetyRead({ text: "the gas leak was fixed in March" });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
