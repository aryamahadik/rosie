// Tests of the safety read (T-365, C-113): npm run test:unit -- ai/src/safety. No live call anywhere (J-02; DL-027):
// every test hands the reader a fake Messages API whose answers come from the recorded-model double (T-004) over K-02
// v1's fixtures, or are written here, and the global fetch is stubbed to fail the file if anything reaches it. Time is
// vitest's fake clock. Every answer is held to K-02 v1's own schema (Ajv, through the double's contract loader) and
// every span to K-08 v1's (through the runtime's trace test support). Texts and names are the master's sample cast and
// fixture set v1's demo shops (rule 9).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CacheLayoutError, createPromptCache, messagesParams, sha256Hex } from "../cache";
import {
  API_URL,
  API_VERSION,
  GatewayConfigError,
  HAIKU_MODEL,
  KEY_VARIABLE,
  MissingKeyError,
  SONNET_MODEL,
  costMicroUsd,
  type FetchLike,
} from "../gateway";
import {
  buildRecordedModel,
  loadModelContract,
  loadRecordedModel,
  type ModelContract,
  type RecordedModel,
} from "../recorded-double";
import { openTrace, spanProblems, type TraceContext } from "../../../runtime/src/trace";
import { schemaErrors } from "../../../runtime/src/trace/test-support";
import type { SafetyReadPort } from "../../../runtime/src/safety/types";
import {
  SAFETY_READ_PROMPT,
  SAFETY_READ_SCHEMA,
  SAFETY_TRY_MS,
  SAFETY_VERDICT_MS,
  createSafetyReader,
  heldOutcomes,
  safetyReadTurn,
  type SafetyLabel,
  type SafetyReadAnswer,
  type SafetyReadCallOptions,
  type SafetyReadInput,
  type SafetyReader,
  type SafetyResult,
} from "./index";
import {
  BUNDLE,
  CARD_FIXTURES,
  MANIFEST,
  PROMPTS,
  RECORDINGS,
  SAFETY_RECORDINGS,
  USAGE,
  always,
  cacheBundleWith,
  fakeMessagesApi,
  k02,
  textOf,
  type Behavior,
  type Seen,
} from "./test-support";

// An obviously fake key, long enough to be found anywhere it leaks.
const KEY = "sk-ant-api03-FAKE-KEY-FOR-SAFETY-TESTS-0123456789";
const ENV = { [KEY_VARIABLE]: KEY };

const globalFetch = vi.fn(() => {
  throw new Error("no network in a safety read test: the global fetch was called");
});

let contract: ModelContract;
let recorded: RecordedModel;

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  contract = await loadModelContract();
  recorded = await loadRecordedModel();
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T18:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function readerOver(api: { fetch: FetchLike }, env: Record<string, string | undefined> = ENV): SafetyReader {
  return createSafetyReader({ bundle: BUNDLE, prompts: PROMPTS, env, fetch: api.fetch });
}

/** A read with the fake clock run to the 4 s mark, so an answer with no verdict, given then, comes too. */
async function readThrough(
  reader: SafetyReader,
  input: SafetyReadInput,
  options?: SafetyReadCallOptions,
): Promise<SafetyReadAnswer> {
  const pending = reader.read(input, options);
  await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS);
  return pending;
}

const models = (seen: readonly Seen[]): string[] => seen.map((entry) => entry.model);
const tensesOf = (labels: readonly SafetyLabel[] | undefined): [string, string][] =>
  (labels ?? []).map((label) => [label.outcome, label.tense]);

/** The answer is K-02 v1's: its result a `safetyResult`, its read (when there is one) a `safetyRead`. */
function expectK02(answer: SafetyReadAnswer): void {
  expect(contract.validate("safetyResult", answer.result)).toEqual([]);
  if (answer.result.read !== null) expect(contract.validate("safetyRead", answer.result.read)).toEqual([]);
}

/** A fixture's input: its event id, a text on arrival, and the text the double holds for it. */
const inputOf = (file: string): SafetyReadInput => ({
  eventId: k02(file).eventId,
  source: "text",
  text: textOf(file),
});

describe("each K-02 safety fixture's text gives that fixture's labels and tenses (recorded-model double)", () => {
  it("holds a text for every fixture this card reads", () => {
    for (const file of CARD_FIXTURES) expect(textOf(file)).toMatch(/\S/u);
  });

  it.each(CARD_FIXTURES)("%s", async (file) => {
    const fixture = k02(file);
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const answer = await readerOver(api).read(inputOf(file));

    expect(api.misses).toEqual([]);
    expect(models(api.seen)).toEqual([HAIKU_MODEL]);
    expect(api.seen[0]?.text).toBe(textOf(file));
    // The fixture's labels, each with its outcome, tense, evidence words, who is at risk and who wrote it.
    expect(answer.result.read).toEqual(fixture.read);
    expect(tensesOf(answer.result.read?.labels)).toEqual(tensesOf(fixture.read?.labels));
    expect(answer.result.outcomes).toEqual(fixture.outcomes);
    // The whole result is the fixture's, but for the danger words code matches, which are T-366's.
    expect(answer.result).toEqual({ ...fixture, dangerWords: [] });
    expect(answer.modelCalls).toHaveLength(1);
    expectK02(answer);
  });
});

/** A text with two dangers, written from two fixtures' texts, and its read: both fixtures' labels, in the text's order. */
const TWO_DANGERS_TEXT = `${textOf("safety-unsafe-at-home.json")}, and ${textOf("safety-crisis-words.json")}`;
const TWO_DANGERS_LABELS = [
  ...(k02("safety-unsafe-at-home.json").read?.labels ?? []),
  ...(k02("safety-crisis-words.json").read?.labels ?? []),
];

describe("several labels per text", () => {
  let withTwo: RecordedModel;

  beforeAll(async () => {
    // A recording for a synthetic two-danger text, beside the double's own safety recordings. Its answer is checked
    // against K-02 at load, like every recording (T-004); it is written here, never recorded live.
    withTwo = await buildRecordedModel({
      version: RECORDINGS.version,
      contract: RECORDINGS.contract,
      recordings: [
        ...SAFETY_RECORDINGS,
        {
          id: "synthetic-two-dangers",
          kind: "safetyRead",
          request: { text: TWO_DANGERS_TEXT },
          output: { labels: TWO_DANGERS_LABELS },
        },
      ],
    });
  });

  it("returns both labels for a text with two dangers, each with its tense, and both outcomes hold", async () => {
    const api = fakeMessagesApi(withTwo, always({ kind: "double" }));
    const answer = await readerOver(api).read({
      eventId: "evt-alex-0301",
      source: "text",
      text: TWO_DANGERS_TEXT,
    });

    expect(api.misses).toEqual([]);
    expect(tensesOf(answer.result.read?.labels)).toEqual([
      ["Unsafe at home", "could restart"],
      ["Crisis words", "now"],
    ]);
    expect(answer.result.read?.labels).toEqual(TWO_DANGERS_LABELS);
    for (const label of answer.result.read?.labels ?? []) expect(TWO_DANGERS_TEXT).toContain(label.evidence);
    expect(answer.result.outcomes).toEqual(["Unsafe at home", "Crisis words"]);
    expect(answer.result).toMatchObject({ timedOut: false, liftedToUnsure: false, dangerWords: [] });
    expectK02(answer);
  });

  it("keeps every label as the model gave it, and holds each danger outcome once, in the labels' order", async () => {
    const label = (
      outcome: SafetyLabel["outcome"],
      tense: SafetyLabel["tense"],
      evidence: string,
    ): SafetyLabel => ({
      outcome,
      tense,
      evidence,
      atRisk: "unknown",
      writer: "the person at the handle",
    });
    const labels = [
      label("A threat to staff or others", "now", "I'll hurt him"),
      label("No", "now", ""),
      label("An emergency", "now", "the shop is on fire"),
      label("A threat to staff or others", "now", "I'll hurt Riley too"),
    ];
    const api = fakeMessagesApi(recorded, always({ kind: "ok", output: { labels } }));
    const answer = await readerOver(api).read({
      eventId: "evt-alex-0302",
      source: "text",
      text: "I'll hurt him, the shop is on fire, and I'll hurt Riley too",
    });
    expect(answer.result.read?.labels).toEqual(labels);
    expect(answer.result.outcomes).toEqual(["A threat to staff or others", "An emergency"]);
    expectK02(answer);
  });
});

describe("tense: over and joke are not danger; unknown is (arch 06 line 329)", () => {
  const label = (outcome: SafetyLabel["outcome"], tense: SafetyLabel["tense"]): SafetyLabel => ({
    outcome,
    tense,
    evidence: "",
    atRisk: "nobody",
    writer: "the person at the handle",
  });

  it("holds a danger label whose tense is now, could restart or unknown", () => {
    for (const tense of ["now", "could restart", "unknown"] as const) {
      expect(heldOutcomes({ labels: [label("An emergency", tense)] })).toEqual(["An emergency"]);
    }
  });

  it("does not hold a danger label whose tense is over or joke: with nothing else, the text reads No", () => {
    for (const tense of ["over", "joke"] as const) {
      expect(heldOutcomes({ labels: [label("An emergency", tense)] })).toEqual(["No"]);
      expect(
        heldOutcomes({ labels: [label("Crisis words", tense), label("Unsafe at home", "now")] }),
      ).toEqual(["Unsafe at home"]);
    }
  });

  it("always holds Unsure, whatever its tense: unsure is read as danger (A3-22's safe default)", () => {
    for (const tense of ["now", "could restart", "over", "joke", "unknown"] as const) {
      expect(heldOutcomes({ labels: [label("Unsure", tense)] })).toEqual(["Unsure"]);
    }
  });

  it("reads No for a No label in any tense (a danger word's lift is T-366's)", () => {
    for (const tense of ["now", "could restart", "over", "joke", "unknown"] as const) {
      expect(heldOutcomes({ labels: [label("No", tense)] })).toEqual(["No"]);
    }
  });

  it("passes a joke's read on as the model gave it, and its outcome is No", async () => {
    const read = { labels: [{ ...label("An emergency", "joke"), evidence: "this traffic is killing me" }] };
    const api = fakeMessagesApi(recorded, always({ kind: "ok", output: read }));
    const answer = await readerOver(api).read({
      eventId: "evt-alex-0303",
      source: "text",
      text: "running late, this traffic is killing me",
    });
    expect(answer.result.read).toEqual(read);
    expect(answer.result.outcomes).toEqual(["No"]);
    expectK02(answer);
  });
});

describe("Haiku, then Sonnet if Haiku fails or times out, 2 s each (fake clock)", () => {
  const file = "safety-emergency-now.json";

  it("calls Sonnet when Haiku times out at 2 s, and not before", async () => {
    const api = fakeMessagesApi(recorded, (seen) =>
      seen.model === HAIKU_MODEL ? { kind: "hang" } : { kind: "double" },
    );
    const pending = readerOver(api).read(inputOf(file));

    await vi.advanceTimersByTimeAsync(SAFETY_TRY_MS - 1);
    expect(models(api.seen)).toEqual([HAIKU_MODEL]);
    await vi.advanceTimersByTimeAsync(1);
    expect(models(api.seen)).toEqual([HAIKU_MODEL, SONNET_MODEL]);

    const answer = await pending;
    expect(SAFETY_TRY_MS).toBe(2000);
    expect(answer.result.tries).toEqual([
      { model: "haiku", result: "timeout" },
      { model: "sonnet", result: "verdict" },
    ]);
    expect(answer.result.read).toEqual(k02(file).read);
    expect(answer.result.outcomes).toEqual(["An emergency"]);
    expect(answer.modelCalls.map((call) => [call.model, call.role, call.outcome, call.ms])).toEqual([
      [HAIKU_MODEL, "haiku", "timedOut", 2000],
      [SONNET_MODEL, "sonnet", "ok", 0],
    ]);
    expectK02(answer);
  });

  it("does not call Sonnet when Haiku gives a verdict", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const answer = await readerOver(api).read(inputOf(file));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(models(api.seen)).toEqual([HAIKU_MODEL]);
    expect(answer.result.tries).toEqual([{ model: "haiku", result: "verdict" }]);
  });

  const failures: [string, Behavior][] = [
    ["an overloaded API (529)", { kind: "status", status: 529 }],
    ["a 429", { kind: "status", status: 429 }],
    ["a dropped connection", { kind: "throw", message: "socket hang up" }],
    ["a refusal", { kind: "ok", output: { labels: [] }, stop: "refusal" }],
    ["a cut-off answer, even one that parses", { kind: "ok", output: k02(file).read, stop: "max_tokens" }],
    ["an answer that is not JSON", { kind: "text", text: "Sorry, no JSON here." }],
    ["an answer that is not a K-02 read", { kind: "ok", output: { labels: [{ outcome: "Danger" }] } }],
    ["a read with no label", { kind: "ok", output: { labels: [] } }],
  ];
  it.each(failures)("calls Sonnet at once when Haiku's try fails: %s", async (_name, failure) => {
    const api = fakeMessagesApi(recorded, (seen) =>
      seen.model === HAIKU_MODEL ? failure : { kind: "double" },
    );
    const answer = await readerOver(api).read(inputOf(file));
    expect(models(api.seen)).toEqual([HAIKU_MODEL, SONNET_MODEL]);
    expect(answer.result.tries).toEqual([
      { model: "haiku", result: "error" },
      { model: "sonnet", result: "verdict" },
    ]);
    expect(answer.result.read).toEqual(k02(file).read);
    expect(answer.modelCalls.map((call) => call.outcome)).toEqual(["failed", "ok"]);
    expectK02(answer);
  });

  it("gives Sonnet its own 2 s after a Haiku failure, and with no verdict answers at the 4 s mark", async () => {
    const api = fakeMessagesApi(recorded, (seen) =>
      seen.model === HAIKU_MODEL ? { kind: "status", status: 500 } : { kind: "hang" },
    );
    let settled = false;
    const pending = readerOver(api)
      .read(inputOf(file))
      .then((answer) => {
        settled = true;
        return answer;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(models(api.seen)).toEqual([HAIKU_MODEL, SONNET_MODEL]);
    await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const answer = await pending;
    expect(answer.result.tries).toEqual([
      { model: "haiku", result: "error" },
      { model: "sonnet", result: "timeout" },
    ]);
    expect(answer.modelCalls.map((call) => [call.model, call.outcome, call.ms])).toEqual([
      [HAIKU_MODEL, "failed", 0],
      [SONNET_MODEL, "timedOut", 2000],
    ]);
    expect(answer.result.read).toBeNull();
    expectK02(answer);
  });
});

describe("no verdict: both tries fail", () => {
  it("returns no verdict at 4 s when both time out, and not a moment before", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "hang" }));
    let settled = false;
    const pending = readerOver(api)
      .read({ eventId: "evt-alex-0210", source: "text", text: textOf("safety-threat.json") })
      .then((answer) => {
        settled = true;
        return answer;
      });

    await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS - 1);
    expect(settled).toBe(false);
    expect(models(api.seen)).toEqual([HAIKU_MODEL, SONNET_MODEL]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const answer = await pending;
    expect(SAFETY_VERDICT_MS).toBe(4000);
    // K-02's marker as safety-timeout-danger-word.json shows it, but plain: the danger words and their Unsure are T-366's.
    const marker = k02("safety-timeout-danger-word.json");
    expect(answer.result).toEqual({
      ...marker,
      dangerWords: [],
      outcomes: [],
      liftedToUnsure: false,
    });
    expect(answer.result).toMatchObject({ read: null, timedOut: true });
    expect(answer.modelCalls.map((call) => [call.model, call.outcome, call.ms])).toEqual([
      [HAIKU_MODEL, "timedOut", 2000],
      [SONNET_MODEL, "timedOut", 2000],
    ]);
    expectK02(answer);

    // Nothing is called after the no-verdict answer.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.seen).toHaveLength(2);
  });

  it("gives no verdict at the 4 s mark too when both tries fail fast, naming each failure as an error", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "status", status: 503 }));
    let settled = false;
    const pending = readerOver(api)
      .read(inputOf("safety-no.json"))
      .then((answer) => {
        settled = true;
        return answer;
      });
    await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS - 1);
    expect(models(api.seen)).toEqual([HAIKU_MODEL, SONNET_MODEL]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const answer = await pending;
    expect(answer.result).toMatchObject({
      read: null,
      timedOut: true,
      tries: [
        { model: "haiku", result: "error" },
        { model: "sonnet", result: "error" },
      ],
      outcomes: [],
      dangerWords: [],
      liftedToUnsure: false,
    });
    expect(answer.modelCalls.map((call) => call.outcome)).toEqual(["failed", "failed"]);
    expectK02(answer);
  });

  it("returns no verdict when Haiku times out and Sonnet refuses", async () => {
    const api = fakeMessagesApi(recorded, (seen) =>
      seen.model === HAIKU_MODEL ? { kind: "hang" } : { kind: "ok", output: {}, stop: "refusal" },
    );
    const answer = await readThrough(readerOver(api), inputOf("safety-no.json"));
    expect(answer.result.tries).toEqual([
      { model: "haiku", result: "timeout" },
      { model: "sonnet", result: "error" },
    ]);
    expect(answer.result.read).toBeNull();
    expectK02(answer);
  });
});

describe("every output validates against K-02", () => {
  it("holds for every answer a read can give: verdicts from either model, every way of failing, every source", async () => {
    const scripts: ((seen: Seen) => Behavior)[] = [
      always({ kind: "double" }),
      (seen) => (seen.model === HAIKU_MODEL ? { kind: "status", status: 500 } : { kind: "double" }),
      always({ kind: "status", status: 500 }),
      always({ kind: "throw", message: "reset" }),
      always({ kind: "ok", output: { labels: "none" } }),
      (seen) => (seen.model === HAIKU_MODEL ? { kind: "text", text: "{" } : { kind: "status", status: 529 }),
    ];
    const sources = ["text", "page", "agent"] as const;
    let checkedAnswers = 0;
    for (const recording of SAFETY_RECORDINGS) {
      for (const [n, script] of scripts.entries()) {
        const source = sources[n % sources.length] ?? "text";
        const api = fakeMessagesApi(recorded, script);
        const answer = await readThrough(readerOver(api), {
          eventId: `evt-${recording.id}-${String(n)}`,
          source,
          text: recording.request.text ?? "",
        });
        expect(answer.result.source).toBe(source);
        expectK02(answer);
        checkedAnswers += 1;
      }
    }
    expect(checkedAnswers).toBe(SAFETY_RECORDINGS.length * scripts.length);
  });
});

describe("what one call sends", () => {
  it("sends the bundle's model, its safety read prompt as the cached system prompt, the text, and K-02's schema", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const input = inputOf("safety-threat.json");
    await readerOver(api).read(input);

    const [sent] = api.seen;
    expect(sent?.url).toBe(API_URL);
    expect(sent?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": API_VERSION,
    });
    const prompt = PROMPTS.layout({ purpose: "safetyRead", turn: safetyReadTurn(input) });
    expect(sent?.body).toEqual({
      model: HAIKU_MODEL,
      max_tokens: 4096,
      ...messagesParams(prompt),
      output_config: { effort: "low", format: { type: "json_schema", schema: SAFETY_READ_SCHEMA } },
    });
    expect(sent?.body.system).toEqual([
      { type: "text", text: SAFETY_READ_PROMPT.text, cache_control: { type: "ephemeral" } },
    ]);
    expect(sent?.body.messages).toEqual([
      { role: "user", content: `<text source="text">${input.text}</text>` },
    ]);
    for (const name of ["temperature", "top_p", "top_k"]) expect(sent?.body).not.toHaveProperty(name);
  });

  it("uses the prompt its own bundle ships, byte for byte, the same on every call", async () => {
    const text = "An older safety read prompt, pinned by its bundle.";
    const pinned = { version: "safety-read-0", sha256: sha256Hex(text), text };
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const reader = createSafetyReader({
      bundle: BUNDLE,
      prompts: createPromptCache(cacheBundleWith(pinned)),
      env: ENV,
      fetch: api.fetch,
    });
    await reader.read(inputOf("safety-no.json"));
    await reader.read(inputOf("safety-threat.json"));
    const systems = api.seen.map((entry) => JSON.stringify(entry.body.system));
    expect(systems[0]).toBe(systems[1]);
    expect(api.seen[0]?.body.system).toEqual([
      { type: "text", text: pinned.text, cache_control: { type: "ephemeral" } },
    ]);
  });

  it("reads free text from a secure page or an outside AI the same way, naming its source", async () => {
    for (const source of ["page", "agent"] as const) {
      const api = fakeMessagesApi(recorded, always({ kind: "double" }));
      const input: SafetyReadInput = { ...inputOf("safety-crisis-words.json"), source };
      const answer = await readerOver(api).read(input);
      expect((api.seen[0]?.body.messages as { content: string }[])[0]?.content).toBe(
        `<text source="${source}">${input.text}</text>`,
      );
      expect(answer.result.source).toBe(source);
      expect(answer.result.outcomes).toEqual(["Crisis words"]);
      expectK02(answer);
    }
  });

  it("reads an email's subject with its body", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "ok", output: k02("safety-no.json").read }));
    await readerOver(api).read({
      eventId: "evt-alex-0304",
      source: "text",
      text: "Can I book a haircut for Saturday at 2?",
      subject: "Saturday",
    });
    expect((api.seen[0]?.body.messages as { content: string }[])[0]?.content).toBe(
      '<subject>Saturday</subject>\n<text source="text">Can I book a haircut for Saturday at 2?</text>',
    );
  });

  it("calls claude-haiku-5-5 and then claude-sonnet-5-5, never another model, at the Messages endpoint only", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "status", status: 500 }));
    await readThrough(readerOver(api), inputOf("safety-no.json"));
    expect(models(api.seen)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(api.seen.map((entry) => entry.url)).toEqual([API_URL, API_URL]);
  });
});

describe("set-up and calls that cannot be made", () => {
  it("refuses a bundle the AI gateway refuses: another model id, swapped ids, or a bundle id that is not K-01's", () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    for (const bundle of [
      { ...BUNDLE, models: { haiku: "claude-opus-4-1", sonnet: SONNET_MODEL } },
      { ...BUNDLE, models: { haiku: SONNET_MODEL, sonnet: HAIKU_MODEL } },
      { ...BUNDLE, bundleId: { hash: "nope", build: 0 } },
    ]) {
      expect(() => createSafetyReader({ bundle, prompts: PROMPTS, env: ENV, fetch: api.fetch })).toThrow(
        GatewayConfigError,
      );
    }
    expect(api.seen).toHaveLength(0);
  });

  it("refuses prompts of another bundle than its models", () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const otherBundle = { ...BUNDLE, bundleId: { hash: "a".repeat(64), build: 2 } };
    expect(() =>
      createSafetyReader({ bundle: otherBundle, prompts: PROMPTS, env: ENV, fetch: api.fetch }),
    ).toThrow(GatewayConfigError);
  });

  it("refuses, at set-up, a bundle whose safety read prompt is empty", () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const empty = { version: "safety-read-0", sha256: sha256Hex(""), text: "" };
    expect(() =>
      createSafetyReader({
        bundle: BUNDLE,
        prompts: createPromptCache(cacheBundleWith(empty)),
        env: ENV,
        fetch: api.fetch,
      }),
    ).toThrow(CacheLayoutError);
    expect(api.seen).toHaveLength(0);
  });

  it("refuses a trace of another bundle before any call", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const other = openTrace({
      openedBy: "textWebhook",
      bundleId: { hash: "a".repeat(64), build: 1 },
      handleRef: "handle-alex",
    });
    await expect(readerOver(api).read(inputOf("safety-no.json"), { trace: other })).rejects.toThrow(
      GatewayConfigError,
    );
    expect(api.seen).toHaveLength(0);
    expect(other.spans).toHaveLength(0);
  });

  it("reads the key from ANTHROPIC_API_KEY at each call, names it when it is missing, and makes no call then", async () => {
    const env: Record<string, string | undefined> = {};
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const reader = readerOver(api, env);
    for (const value of [undefined, ""]) {
      env[KEY_VARIABLE] = value;
      const error = await reader.read(inputOf("safety-no.json")).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(MissingKeyError);
      expect((error as MissingKeyError).message).toContain("ANTHROPIC_API_KEY");
    }
    expect(api.seen).toHaveLength(0);
    env[KEY_VARIABLE] = KEY;
    await reader.read(inputOf("safety-no.json"));
    expect(api.seen[0]?.headers["x-api-key"]).toBe(KEY);
  });
});

describe("spans: one K-08 v1 span per model call, with no message words", () => {
  const trace = (): TraceContext =>
    openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE.bundleId,
      handleRef: "handle-alex",
      incomingTraceId: "6f1f4f0e-8c0a-4a77-9d36-2f5c3a1b9d10",
    });

  it("writes one valid portCall span for Haiku's verdict, with its model call", async () => {
    const context = trace();
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const answer = await readerOver(api).read(inputOf("safety-threat.json"), {
      trace: context,
      businessId: "biz-lees-barbershop",
    });

    expect(context.spans).toHaveLength(1);
    const [span] = context.spans;
    expect(span).toMatchObject({
      hop: "portCall",
      provider: "anthropic",
      call: "messages",
      attempt: 1,
      outcome: "ok",
      error_code: null,
      event_id: "evt-alex-0204",
      business_id: "biz-lees-barbershop",
      bundle_id: BUNDLE.bundleId,
      got: { purpose: "safetyRead", source: "text" },
      decided: { role: "haiku", fallback: false, verdict: true },
    });
    // The model call, field for field: tokens as the fake API reported them (USAGE), cost from the gateway's prices.
    const usage = {
      inputTokens: USAGE.input_tokens as number,
      cachedTokens: USAGE.cache_read_input_tokens as number,
      cacheWriteTokens: USAGE.cache_creation_input_tokens as number,
      outputTokens: USAGE.output_tokens as number,
    };
    expect(span?.model_calls).toEqual([
      {
        model: HAIKU_MODEL,
        role: "haiku",
        purpose: "safetyRead",
        input_tokens: 40,
        cached_tokens: 1800,
        cache_write_tokens: 0,
        output_tokens: 60,
        cost_micro_usd: costMicroUsd(HAIKU_MODEL, usage),
        ms: 0,
        outcome: "ok",
      },
    ]);
    // 40 x $0.10 + 1800 x $0.01 + 60 x $0.50, per million tokens: 4 + 18 + 30 micro-dollars.
    expect(costMicroUsd(HAIKU_MODEL, usage)).toBe(52);
    expect(answer.modelCalls).toEqual(span?.model_calls);
    expect(spanProblems(span)).toEqual([]);
    expect(schemaErrors("span", span)).toEqual([]);
    expect(schemaErrors("trace", context.toTrace())).toEqual([]);
  });

  it("writes a span for each of the two tries, the failed one with its timeout, each valid against K-08", async () => {
    const context = trace();
    const api = fakeMessagesApi(recorded, (seen) =>
      seen.model === HAIKU_MODEL ? { kind: "hang" } : { kind: "double" },
    );
    const pending = readerOver(api).read(inputOf("safety-emergency-now.json"), { trace: context });
    await vi.advanceTimersByTimeAsync(SAFETY_TRY_MS);
    await pending;

    expect(
      context.spans.map((span) => [span.attempt, span.outcome, span.error_code, span.ms, span.decided]),
    ).toEqual([
      [1, "timedOut", "timeout", 2000, { role: "haiku", fallback: false, verdict: false }],
      [2, "ok", null, 0, { role: "sonnet", fallback: true, verdict: true }],
    ]);
    expect(context.spans.map((span) => span.at)).toEqual([
      "2026-11-07T18:00:00.000Z",
      "2026-11-07T18:00:02.000Z",
    ]);
    for (const span of context.spans) {
      expect(span.model_calls).toHaveLength(1);
      expect(spanProblems(span)).toEqual([]);
      expect(schemaErrors("span", span)).toEqual([]);
    }
  });

  it("writes two spans for no verdict, one per timed-out try", async () => {
    const context = trace();
    const api = fakeMessagesApi(recorded, always({ kind: "hang" }));
    const pending = readerOver(api).read(inputOf("safety-crisis-words.json"), { trace: context });
    await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS);
    const answer = await pending;
    expect(context.spans.map((span) => [span.attempt, span.outcome, span.error_code])).toEqual([
      [1, "timedOut", "timeout"],
      [2, "timedOut", "timeout"],
    ]);
    expect(context.spans.flatMap((span) => span.model_calls)).toEqual(answer.modelCalls);
    for (const span of context.spans) expect(schemaErrors("span", span)).toEqual([]);
  });

  it("holds no message words: not the text, a quote, who is at risk, a name, the prompt or a provider's error text", async () => {
    const context = trace();
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const api = fakeMessagesApi(recorded, (seen) =>
      seen.model === HAIKU_MODEL ? { kind: "status", status: 500 } : { kind: "double" },
    );
    const input = inputOf("safety-child-or-elder.json");
    const answer = await readerOver(api).read(input, { trace: context });
    expect(answer.result.read).not.toBeNull();

    const spans = JSON.stringify(context.toTrace());
    const label = k02("safety-child-or-elder.json").read?.labels[0];
    for (const words of [
      input.text,
      "carer",
      "food",
      label?.evidence ?? "evidence",
      label?.atRisk ?? "atRisk",
      label?.writer ?? "writer",
      "Harm to a child",
      "failed on purpose",
      SAFETY_READ_PROMPT.text.slice(0, 40),
    ]) {
      expect(spans).not.toContain(words);
    }
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("writes nothing when no trace is given", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const answer = await readerOver(api).read(inputOf("safety-no.json"));
    expect(answer.modelCalls).toHaveLength(1);
  });

  it("still answers when its span cannot be written (an event id that is not a label is left out of the span)", async () => {
    const context = trace();
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const answer = await readerOver(api).read(
      { ...inputOf("safety-no.json"), eventId: "an event id with spaces" },
      { trace: context, businessId: "not a label" },
    );
    expect(answer.result.read).toEqual(k02("safety-no.json").read);
    expect(answer.result.eventId).toBe("an event id with spaces");
    expect(context.spans).toHaveLength(0);
  });
});

describe("the key", () => {
  it("appears in no answer, span, error or console line, even when the fake API echoes it everywhere", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const context = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE.bundleId,
      handleRef: "handle-alex",
    });
    const script: Behavior[] = [
      { kind: "throw", message: `connection to ${KEY} failed` },
      { kind: "ok", output: { echo: KEY }, stop: "refusal" },
      { kind: "text", text: KEY },
      { kind: "status", status: 401 },
    ];
    const api = fakeMessagesApi(recorded, (_seen, n) => script[n] ?? { kind: "double" });
    const reader = readerOver(api);
    const first = await readThrough(reader, inputOf("safety-no.json"), { trace: context });
    const second = await readThrough(reader, inputOf("safety-no.json"), { trace: context });
    expect(first.result.read).toBeNull();
    expect(second.result.read).toBeNull();

    const everything = JSON.stringify([first, second, context.toTrace()]);
    expect(everything).not.toContain("FAKE-KEY");
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("FAKE-KEY");
      spy.mockRestore();
    }
    for (const entry of api.seen) {
      expect(entry.headers["x-api-key"]).toBe(KEY);
      expect(JSON.stringify(entry.body)).not.toContain("FAKE-KEY");
    }
  });
});

describe("the handle actor's safety-read port (T-246) takes this read as it is", () => {
  it("answers the port's request with the port's SafetyReadAnswer", async () => {
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const reader = readerOver(api);
    // The port's shapes are the runtime's (runtime/src/safety/types.ts); this compiles only if the answer is the port's.
    const port: SafetyReadPort = {
      read: (request) =>
        reader.read({
          eventId: request.eventId,
          source: request.source,
          text: request.words.body ?? "",
          subject: request.words.subject,
        }),
    };
    const fixture = k02("safety-unsafe-at-home.json");
    const answer = await port.read({
      eventId: fixture.eventId,
      source: "text",
      traceId: "6f1f4f0e-8c0a-4a77-9d36-2f5c3a1b9d10",
      bundleId: MANIFEST.bundleId,
      words: { body: textOf("safety-unsafe-at-home.json"), subject: null },
    });
    const result: SafetyResult = answer.result;
    expect(result).toEqual({ ...fixture, dangerWords: [] });
    expect(answer.modelCalls).toHaveLength(1);
  });
});
