// Tests of the recorded-model double (T-004, C-123), against K-02 v1's fixtures. Deterministic and offline: outbound
// fetch is stubbed to throw for the whole file, and a test fails if anything calls it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  NoRecordingError,
  RecordingRefusedError,
  buildRecordedModel,
  canonicalJson,
  loadRecordedModel,
  requestKey,
  type DecideRole,
  type JsonObject,
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
const recordingsFile = (): { version: string; contract: string; recordings: Record<string, unknown>[] } =>
  readJson(path.join(RECORDINGS_DIR, "recordings.v1.json")) as {
    version: string;
    contract: string;
    recordings: Record<string, unknown>[];
  };

// An independent validator, as T-081's contract test builds it, so the double is not the judge of its own answers.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const folder of ["common", "bundle", "model"]) {
  const dir = path.join(CONTRACT_DIR, folder);
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".schema.json")))
    ajv.addSchema(readJson(path.join(dir, name)) as object);
}
const SCHEMA_ID = (readJson(path.join(CONTRACT_DIR, "model", "model.v1.schema.json")) as { $id: string }).$id;
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
const acceptedOf = (def: string): string[] =>
  index.filter((entry) => entry.expect === "accept" && entry.def === def).map((entry) => entry.file);

/** A value a test must find; a miss is a broken test. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("the test's setup lacks a value it reads");
  return value;
}

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
  const contexts = acceptedOf("context");
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
    expect(model.size).toBe(recordingsFile().recordings.length);
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
    expect(loaded.size).toBe(model.size + 1);
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
