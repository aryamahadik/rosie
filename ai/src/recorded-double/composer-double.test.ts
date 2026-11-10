// Tests of the composer's call of the recorded-model double (T-1071, C-123), against K-03 v1's fixtures, with the walking
// skeleton's JOIN run's input (T-1145; K-02 README "v1.1", recording 4). Deterministic and offline: outbound fetch is
// stubbed to throw for the whole file, and a test fails if anything calls it. The K-02 side of the double has its own tests
// (recorded-double.test.ts).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  NoRecordingError,
  RecordingRefusedError,
  buildRecordedComposer,
  canonicalJson,
  loadRecordedComposer,
  loadRecordedDouble,
  loadRecordedModel,
  requestKey,
  type JsonObject,
  type RecordedComposer,
} from "./index";

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
const composerFile = (): { version: string; contract: string; recordings: RawRecording[] } =>
  readJson(path.join(RECORDINGS_DIR, "composer.v1.json")) as {
    version: string;
    contract: string;
    recordings: RawRecording[];
  };

// An independent validator, as T-082's contract test builds it, so the double is not the judge of its own answers.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const folder of ["common", "bundle", "message-plan"]) {
  const dir = path.join(CONTRACT_DIR, folder);
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".schema.json")))
    ajv.addSchema(readJson(path.join(dir, name)) as object);
}
const SCHEMA_ID = (
  readJson(path.join(CONTRACT_DIR, "message-plan", "message-plan.v1.schema.json")) as { $id: string }
).$id;
function accepts(def: string, value: unknown): boolean {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`no schema for ${def}`);
  return validate(value) as boolean;
}

const index = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: IndexEntry[] }).fixtures;
interface IndexEntry {
  file: string;
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
/** A composer input's inbound text and its time (K-03 v1 composeInput.inbound). */
interface Inbound {
  text: string;
  sentAt: { utc: string; zone: string };
}
const unique = (names: readonly string[]): string[] => [...new Set(names)];

/** The composer's input a recording names. */
function inputOf(recording: RawRecording): JsonObject {
  if (recording.request.fixture !== undefined) return fixture(recording.request.fixture);
  if (recording.request.file !== undefined) return recordingFile(recording.request.file);
  throw new Error("the test's setup lacks an input it reads");
}

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

describe("the plan fixtures: each input gets its plan", () => {
  it("holds a recording for every accepted K-03 v1 plan fixture, and plan-s1-02's for turn 1's two inputs", () => {
    expect(acceptedPlans).toHaveLength(6);
    const seeded = composerFile().recordings.map((entry) => entry.seed.fixture);
    expect(unique(seeded).sort()).toEqual([...acceptedPlans].sort());
    // Each plan seeds one recording, but plan-s1-02.json: the fixture chain's input-s1-02.json and the JOIN run's input
    // (T-1145; K-02 README "v1.1", recording 4).
    expect(seeded.filter((file) => file === "plan-s1-02.json")).toHaveLength(2);
    expect(seeded).toHaveLength(acceptedPlans.length + 1);
    expect(composer.size).toBe(acceptedPlans.length + 1);
  });

  it("answers input-s1-02 with plan-s1-02", async () => {
    const answer = await composer.composer(fixture("input-s1-02.json"));
    expect(answer).toEqual(fixture("plan-s1-02.json"));
    expect(accepts("plan", answer)).toBe(true);
  });

  it("answers the JOIN run's input, input-s1-02 with only its inbound changed to JOIN and its time, with plan-s1-02", async () => {
    const join = recordingFile(JOIN_INPUT_FILE) as JsonObject & { inbound: Inbound };
    const chain = fixture("input-s1-02.json") as JsonObject & { inbound: Inbound };
    expect({ ...join, inbound: chain.inbound }).toEqual(chain);
    expect(join.inbound).toEqual({
      text: "JOIN",
      sentAt: { utc: "2026-10-19T14:01:49Z", zone: chain.inbound.sentAt.zone },
    });
    // The same JOIN text and time as the JOIN run's decide context (ai/recordings/recordings.v1.1.json).
    const context = recordingFile("contexts/join-s1-01.json") as {
      texts: { words: string; sentAt: Inbound["sentAt"] }[];
    };
    expect(context.texts.map((text) => ({ text: text.words, sentAt: text.sentAt }))).toEqual([join.inbound]);
    expect(accepts("composeInput", join)).toBe(true);
    const recorded = composerFile().recordings.filter((entry) => entry.request.file === JOIN_INPUT_FILE);
    expect(recorded.map((entry) => [entry.id, entry.seed.fixture])).toEqual([
      ["composer-join-s1-02", "plan-s1-02.json"],
    ]);
    const answer = await composer.composer(join);
    expect(answer).toEqual(fixture("plan-s1-02.json"));
    expect(answer).toEqual(await composer.composer(chain));
    expect(accepts("plan", answer)).toBe(true);
  });

  for (const recording of composerFile().recordings) {
    it(`${recording.id} (${recording.seed.fixture}): its input is valid and gets it, valid against $defs/plan`, async () => {
      const input = inputOf(recording);
      expect(accepts("composeInput", input)).toBe(true);
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

describe("the key of a composer input", () => {
  it("is the sha256 of the input's canonical JSON, whatever order its properties are written in", async () => {
    const input = fixture("input-s1-02.json");
    const sha = createHash("sha256").update(canonicalJson(input)).digest("hex");
    expect(requestKey("composerPlan", input)).toBe(`composerPlan:${sha}`);
    const shuffled: JsonObject = Object.fromEntries(Object.entries(input).reverse());
    expect(requestKey("composerPlan", shuffled)).toBe(requestKey("composerPlan", input));
    expect(await composer.composer(shuffled)).toEqual(fixture("plan-s1-02.json"));
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
    const join = recordingFile(JOIN_INPUT_FILE) as JsonObject & { inbound: Inbound };
    const later = { ...join.inbound.sentAt, utc: "2026-10-19T14:01:50Z" };
    await expect(composer.composer({ ...join, inbound: { ...join.inbound, sentAt: later } })).rejects.toThrow(
      NoRecordingError,
    );
    await expect(composer.composer({ ...join, inbound: { ...join.inbound, text: "join" } })).rejects.toThrow(
      /composerPlan/,
    );
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
    expect(loaded.size).toBe(composer.size + 1);
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

describe("the same input twice gives byte-identical answers", () => {
  it("returns the same bytes on every call, for every recording", async () => {
    for (const recording of composerFile().recordings) {
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
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
