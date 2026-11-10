// The joined safety read (T-554; C-047, C-113; 02-contracts section 11, 'Safety read on each raw text, on arrival, before
// batching'), under Node (Vitest project "unit"). The actor's safety-read port as the root binds it (./real.ts
// realSafetyRead) reads each raw text through @rosie/ai's safety read (T-365, with T-366's danger-word rules), here
// built over the recorded-model double that T-004's fixture loader builds from the skeleton's recordings
// (./test-support.ts SKELETON_SAFETY_RECORDINGS), behind a fake Messages API. The Workers tests use a copy of that double
// built without the loader (which reads files and compiles K-02's schema with Ajv, which the Workers runtime does not
// allow): here each of the copy's answers is held to the loader's. No model is called (J-02; DL-027): the global fetch is
// stubbed to fail the file. Test values only (rule 9).
import { HAIKU_MODEL } from "@rosie/ai/src/gateway/index";
import {
  buildRecordedModel,
  loadModelContract,
  type ModelContract,
  type RecordedModel,
} from "@rosie/ai/src/recorded-double/index";
import safetyNo from "@rosie/contracts/model/fixtures/safety-no.json";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BUNDLE_A } from "../bundle/test-support";
import { FIXTURE_DANGER_WORDS } from "../safety/test-support";
import type { DangerWordEntry, SafetyReadRequest } from "../safety/types";
import type { Span } from "../trace";
import {
  composeRoot,
  NoSafetyReaderError,
  NotJoinedError,
  realSafetyRead,
  workerRoot,
  type SafetyReaders,
} from "./index";
import {
  fakeSafetyModels,
  JOIN_TEXT,
  SKELETON_SAFETY_RECORDINGS,
  skeletonFakes,
  skeletonSafetyDouble,
  type FakeSafetyModels,
} from "./test-support";

const TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
/** Sam's JOIN's event id (K-08 trace-skeleton.json's, as the e2e skeleton sends it). */
const JOIN_EVENT = "evt-sam-0000";
/** Made-up words holding a trade's (plug-in) danger word of the fixture bundle: "cut won't stop bleeding". */
const LIFT_TEXT = "my cut won't stop bleeding";
const LIFT_EVENT = "evt-alex-0211";
/** A recording, in T-004's form, the double reads as No (safety-no.json) for the lift text. */
const LIFT_RECORDING = {
  id: "wiring-lift",
  kind: "safetyRead",
  request: { text: LIFT_TEXT },
  seed: { fixture: "safety-no.json" },
} as const;

/** A text as the actor hands it to the safety read on arrival: its words opened, on its trace and bundle. */
function requestOf(text: string, eventId = JOIN_EVENT): SafetyReadRequest {
  return {
    eventId,
    source: "text",
    traceId: TRACE,
    bundleId: BUNDLE_A,
    words: { body: text, subject: null },
  };
}

const globalFetch = vi.fn(() => {
  throw new Error("no network in the wiring's safety read test: the global fetch was called");
});

let contract: ModelContract;
/** The skeleton's recordings, through T-004's loader. */
let loaded: RecordedModel;
/** The same, with the lift text's recording. */
let withLift: RecordedModel;

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  contract = await loadModelContract();
  loaded = await buildRecordedModel(SKELETON_SAFETY_RECORDINGS);
  withLift = await buildRecordedModel({
    ...SKELETON_SAFETY_RECORDINGS,
    recordings: [...SKELETON_SAFETY_RECORDINGS.recordings, LIFT_RECORDING],
  });
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

interface Joined {
  readonly models: FakeSafetyModels;
  readonly spans: Span[];
  readonly read: (request: SafetyReadRequest) => ReturnType<ReturnType<typeof realSafetyRead>["read"]>;
}

/** The joined port over a double T-004's loader built, with these danger words; the spans it writes are kept here. */
function joined(
  recorded: RecordedModel,
  dangerWords: readonly DangerWordEntry[] = FIXTURE_DANGER_WORDS,
): Joined {
  const models = fakeSafetyModels(recorded);
  const spans: Span[] = [];
  const port = realSafetyRead({
    readers: models.readers,
    dangerWords: () => dangerWords,
    sink: (span) => {
      spans.push(span);
    },
    now: () => Date.now(),
  });
  return { models, spans, read: (request) => port.read(request) };
}

describe("the skeleton's safety recordings, through T-004's fixture loader", () => {
  it("load whole, read Sam's JOIN as safety-no.json does, and the Workers' copy of the double answers each text as the loader's does", async () => {
    const copy = skeletonSafetyDouble();

    expect(loaded.size).toBe(SKELETON_SAFETY_RECORDINGS.recordings.length);
    expect(copy.size).toBe(loaded.size);
    for (const recording of SKELETON_SAFETY_RECORDINGS.recordings) {
      expect(await copy.safetyRead(recording.request)).toEqual(await loaded.safetyRead(recording.request));
    }
    expect(await loaded.safetyRead({ text: JOIN_TEXT })).toEqual(safetyNo.read);
  });
});

describe("the joined safety-read port: @rosie/ai's safety read on each raw text, on arrival", () => {
  it("reads Sam's JOIN: verdict No (safety-no.json) from one Haiku call given the JOIN's words, its model-call span in the text's trace under its bundle id", async () => {
    const run = joined(loaded);

    const answer = await run.read(requestOf(JOIN_TEXT));

    expect(answer.result).toEqual({ ...safetyNo, eventId: JOIN_EVENT });
    expect(contract.validate("safetyResult", answer.result)).toEqual([]);
    expect(run.models.calls).toEqual([{ model: HAIKU_MODEL, text: JOIN_TEXT }]);
    expect(answer.modelCalls).toMatchObject([
      { model: HAIKU_MODEL, role: "haiku", purpose: "safetyRead", outcome: "ok" },
    ]);
    expect(run.spans).toHaveLength(1);
    expect(run.spans[0]).toMatchObject({
      trace_id: TRACE,
      hop: "portCall",
      provider: "anthropic",
      call: "messages",
      attempt: 1,
      outcome: "ok",
      event_id: JOIN_EVENT,
      bundle_id: BUNDLE_A,
    });
    expect(JSON.stringify(run.spans)).not.toContain(JOIN_TEXT);
  });

  it("gives the read the bundle's danger words: a trade's danger word the double reads as No is lifted to Unsure (T-366); given none, it stays No", async () => {
    const lifted = await joined(withLift).read(requestOf(LIFT_TEXT, LIFT_EVENT));
    const plain = await joined(withLift, []).read(requestOf(LIFT_TEXT, LIFT_EVENT));

    expect(lifted.result).toMatchObject({
      outcomes: ["Unsure"],
      liftedToUnsure: true,
      dangerWords: [{ words: "cut won't stop bleeding", list: "plugin", kind: "other" }],
    });
    expect(plain.result).toMatchObject({ outcomes: ["No"], liftedToUnsure: false, dangerWords: [] });
  });

  it("fails closed before any model call: no safety read bound, danger words that cannot be read, or a reader that cannot be built", async () => {
    const models = fakeSafetyModels(loaded);
    const sink = (): void => undefined;
    const now = (): number => Date.now();
    const noReader: SafetyReaders = () => {
      throw new Error("no manifest for that bundle");
    };

    await expect(
      realSafetyRead({ readers: null, dangerWords: () => FIXTURE_DANGER_WORDS, sink, now }).read(
        requestOf(JOIN_TEXT),
      ),
    ).rejects.toThrow(new NoSafetyReaderError());
    await expect(
      realSafetyRead({
        readers: models.readers,
        dangerWords: () => {
          throw new NotJoinedError("stateReads");
        },
        sink,
        now,
      }).read(requestOf(JOIN_TEXT)),
    ).rejects.toThrow(new NotJoinedError("stateReads"));
    await expect(
      realSafetyRead({ readers: noReader, dangerWords: () => FIXTURE_DANGER_WORDS, sink, now }).read(
        requestOf(JOIN_TEXT),
      ),
    ).rejects.toThrow("no manifest for that bundle");
    expect(models.calls).toEqual([]);
  });
});

describe("the root binds it", () => {
  it("under test: the actor's safety read is the joined port, given the bound bundle port's danger words, its span logged on the text's trace", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const fakes = skeletonFakes();
      const models = fakeSafetyModels(withLift);
      const root = composeRoot({
        environment: "test",
        sets: { fake: fakes.ports },
        actors: null,
        vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
        safetyReaders: models.readers,
      });

      expect(root.bindings.find((binding) => binding.port === "safetyRead")).toEqual({
        port: "safetyRead",
        implementation: "real",
      });
      expect(root.safety.read).toBe(root.ports.safetyRead);
      const join = await root.safety.read.read(requestOf(JOIN_TEXT));
      // The fixture bundle's danger words (the bound stateReads port's) reach the read: the lift text reads Unsure.
      const lift = await root.safety.read.read(requestOf(LIFT_TEXT, LIFT_EVENT));

      expect(join.result.outcomes).toEqual(["No"]);
      expect(lift.result).toMatchObject({ outcomes: ["Unsure"], liftedToUnsure: true });
      expect(models.calls).toEqual([
        { model: HAIKU_MODEL, text: JOIN_TEXT },
        { model: HAIKU_MODEL, text: LIFT_TEXT },
      ]);
      const lines = log.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as unknown);
      expect(lines).toMatchObject([
        { msg: "span", trace_id: TRACE, hop: "portCall", provider: "anthropic", event_id: JOIN_EVENT },
        { msg: "span", trace_id: TRACE, hop: "portCall", provider: "anthropic", event_id: LIFT_EVENT },
      ]);
      expect(JSON.stringify(lines)).not.toContain(LIFT_TEXT);
    } finally {
      log.mockRestore();
    }
  });

  it("on the Worker's staging: bound (its pick is real) with no safety read handed in, so every read fails closed and the actor applies its no-verdict rule", async () => {
    const root = workerRoot({ ENVIRONMENT: "staging", BASE_PATH: "", DB_SCHEMA: "" });

    expect(root.bindings.find((binding) => binding.port === "safetyRead")?.implementation).toBe("real");
    await expect(root.ports.safetyRead.read(requestOf(JOIN_TEXT))).rejects.toThrow(new NoSafetyReaderError());
  });

  it("on the Worker's production: closed", async () => {
    const root = workerRoot({ ENVIRONMENT: "production", BASE_PATH: "", DB_SCHEMA: "" });

    expect(root.bindings.find((binding) => binding.port === "safetyRead")?.implementation).toBe("closed");
    await expect(root.ports.safetyRead.read(requestOf(JOIN_TEXT))).rejects.toThrow(
      new NotJoinedError("safetyRead"),
    );
  });
});
