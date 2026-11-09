// Tests of code's danger-word rules after the safety read (T-366, C-113): npm run test:unit -- ai/src/safety/lift. No
// live call anywhere (J-02; DL-027): every read goes to a fake Messages API whose answers come from the recorded-model
// double (T-004) over K-02 v1's fixtures, or are written here, and the global fetch is stubbed to fail the file if
// anything reaches it. Time is vitest's fake clock. Every answer is held to K-02 v1's own schema (Ajv, through the
// double's contract loader). Texts and names are the master's sample cast and fixture set v1's demo shops (rule 9).
//
// The danger words: no source lists them (K-02 README, open gaps; CQ-24), so the tests match the words K-02's own
// fixtures show (K02_DANGER_WORDS), as the actor's tests do (T-246), and, where a case needs a trade's own word K-02
// does not show, a plumber's words written here from fixture set v1's plumber.json safety_stop.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HAIKU_MODEL, KEY_VARIABLE, SONNET_MODEL, type FetchLike } from "../gateway";
import {
  loadModelContract,
  loadRecordedModel,
  type ModelContract,
  type RecordedModel,
} from "../recorded-double";
import { openTrace } from "../../../runtime/src/trace";
import { matchDangerWords, timeoutResult } from "../../../runtime/src/safety/rules";
import type { BundleSafety, SafetyReadPort } from "../../../runtime/src/safety/types";
import {
  SAFETY_OUTCOMES,
  SAFETY_VERDICT_MS,
  afterVerdict,
  createSafetyReader,
  findDangerWords,
  heldOutcomes,
  outOfDanger,
  quotes,
  timeoutMarker,
  type DangerWordEntry,
  type DangerWordMatch,
  type SafetyLabel,
  type SafetyRead,
  type SafetyReadAnswer,
  type SafetyReadCallOptions,
  type SafetyReadInput,
  type SafetyReader,
  type Tense,
} from "./index";
import {
  BUNDLE,
  K02_DANGER_WORDS,
  MANIFEST,
  PROMPTS,
  REPO_ROOT,
  SAFETY_RESULT_FIXTURES,
  always,
  fakeMessagesApi,
  k02,
  textOf,
} from "./test-support";

// An obviously fake key, without a real key's prefix.
const ENV = { [KEY_VARIABLE]: "FAKE-KEY-FOR-SAFETY-LIFT-TESTS-0123456789" };

const globalFetch = vi.fn(() => {
  throw new Error("no network in a safety lift test: the global fetch was called");
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
  vi.setSystemTime(new Date("2026-11-09T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function readerOver(api: { fetch: FetchLike }): SafetyReader {
  return createSafetyReader({ bundle: BUNDLE, prompts: PROMPTS, env: ENV, fetch: api.fetch });
}

/** The answer is K-02 v1's: its result a `safetyResult`, its read (when there is one) a `safetyRead`. */
function expectK02(answer: SafetyReadAnswer): void {
  expect(contract.validate("safetyResult", answer.result)).toEqual([]);
  if (answer.result.read !== null) expect(contract.validate("safetyRead", answer.result.read)).toEqual([]);
}

const AT_HANDLE = "the person at the handle";

const label = (
  outcome: SafetyLabel["outcome"],
  tense: Tense,
  evidence = "",
  atRisk = "nobody",
): SafetyLabel => ({ outcome, tense, evidence, atRisk, writer: AT_HANDLE });

const text = (eventId: string, words: string, subject?: string): SafetyReadInput => ({
  eventId,
  source: "text",
  text: words,
  ...(subject !== undefined && { subject }),
});

/** A read the model answers with `read` (the fake API's 200), with these danger words; Haiku's verdict, K-02's shape. */
async function readWith(
  read: SafetyRead,
  input: SafetyReadInput,
  dangerWords?: readonly DangerWordEntry[],
): Promise<SafetyReadAnswer> {
  const api = fakeMessagesApi(recorded, always({ kind: "ok", output: read }));
  const options: SafetyReadCallOptions = dangerWords === undefined ? {} : { dangerWords };
  const answer = await readerOver(api).read(input, options);
  expect(api.seen.map((entry) => entry.model)).toEqual([HAIKU_MODEL]);
  expect(answer.result.read).toEqual(read);
  expectK02(answer);
  return answer;
}

/** A read of a K-02 fixture's text, answered by the recorded-model double, with these danger words. */
async function readFixture(
  file: string,
  dangerWords?: readonly DangerWordEntry[],
): Promise<SafetyReadAnswer> {
  const api = fakeMessagesApi(recorded, always({ kind: "double" }));
  const options: SafetyReadCallOptions = dangerWords === undefined ? {} : { dangerWords };
  const answer = await readerOver(api).read(text(k02(file).eventId, textOf(file)), options);
  expect(api.misses).toEqual([]);
  expectK02(answer);
  return answer;
}

/** A read in which neither model answers, with the fake clock run to the 4 s mark; it must not settle a moment before. */
async function readTimingOut(
  input: SafetyReadInput,
  dangerWords?: readonly DangerWordEntry[],
  behave: Parameters<typeof fakeMessagesApi>[1] = always({ kind: "hang" }),
): Promise<SafetyReadAnswer> {
  const api = fakeMessagesApi(recorded, behave);
  const options: SafetyReadCallOptions = dangerWords === undefined ? {} : { dangerWords };
  let settled = false;
  const pending = readerOver(api)
    .read(input, options)
    .then((answer) => {
      settled = true;
      return answer;
    });
  await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  const answer = await pending;
  expect(api.seen.map((entry) => entry.model)).toEqual([HAIKU_MODEL, SONNET_MODEL]);
  expectK02(answer);
  return answer;
}

const plugin = (words: string): DangerWordEntry => ({ words, list: "plugin", kind: "other" });
const general = (words: string, kind: DangerWordEntry["kind"] = "other"): DangerWordEntry => ({
  words,
  list: "general",
  kind,
});

/**
 * A plumber's own danger words, as a list would name them: fixture set v1's plumber.json safety_stop says "A gas smell,
 * hissing, or a carbon monoxide alarm". Written here as words a text holds, as K-02's fixtures write the barbershop's
 * safety_stop ("lips are swelling", "cut won't stop bleeding").
 */
const PLUMBER_WORDS: readonly DangerWordEntry[] = [
  plugin("smell gas"),
  plugin("gas smell"),
  plugin("carbon monoxide alarm"),
];

/** A text with the barbershop's bleeding cut (fixture set v1's barber.json safety_stop: "a deep cut that won't stop bleeding"). */
const BLEEDING_CUT = "Riley nicked my neck and the cut won't stop bleeding";

const VERDICT_FIXTURES = SAFETY_RESULT_FIXTURES.filter((file) => k02(file).read !== null);

describe("the danger words the tests match", () => {
  it("are the five K-02's own safety fixtures show, each once, with their list and kind", () => {
    expect(K02_DANGER_WORDS).toEqual([
      plugin("lips are swelling"),
      general("don't want to be alive", "selfHarm"),
      general("gas leak"),
      general("fire"),
      plugin("cut won't stop bleeding"),
    ]);
  });

  it("include a plumber's, each named by fixture set v1's plumber.json safety_stop", () => {
    const shop = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "fixtures/v1/test-kit/shops/plumber.json"), "utf8"),
    ) as { safety_stop: string[] };
    const stop = shop.safety_stop.join(" ").toLowerCase();
    for (const entry of PLUMBER_WORDS) {
      for (const word of entry.words.split(" ")) expect(stop).toContain(word);
    }
  });
});

describe("each K-02 safety fixture's text, read with K-02's danger words, gives that fixture's whole result", () => {
  it("covers every verdict fixture K-02 holds, the gas leak among them, and the double holds each one's text", () => {
    expect(VERDICT_FIXTURES).toHaveLength(9);
    expect(VERDICT_FIXTURES).toContain("safety-over-gas-leak.json");
    for (const file of VERDICT_FIXTURES) expect(textOf(file)).toMatch(/\S/u);
  });

  it.each(VERDICT_FIXTURES)("%s", async (file) => {
    const answer = await readFixture(file, K02_DANGER_WORDS);
    // The whole K-02 result, the danger words code found included.
    expect(answer.result).toEqual(k02(file));
  });
});

describe("'the gas leak was fixed in March' stays No (safety-over-gas-leak.json)", () => {
  const file = "safety-over-gas-leak.json";

  it("finds the danger word, and with tense over keeps No, not lifted: the fixture", async () => {
    const answer = await readFixture(file, K02_DANGER_WORDS);
    expect(textOf(file)).toBe("the gas leak was fixed in March");
    expect(answer.result.read?.labels.map((entry) => [entry.outcome, entry.tense])).toEqual([["No", "over"]]);
    expect(answer.result).toMatchObject({
      dangerWords: [general("gas leak")],
      outcomes: ["No"],
      liftedToUnsure: false,
    });
    expect(answer.result).toEqual(k02(file));
  });

  it("stays No when the gas leak is a trade's own danger word too: the label that quotes it is over", async () => {
    const answer = await readFixture(file, [plugin("gas leak")]);
    expect(answer.result).toEqual({ ...k02(file), dangerWords: [plugin("gas leak")] });
  });
});

describe("'I smell gas' with tense now becomes Unsure", () => {
  const input = text("evt-alex-0220", "I smell gas");

  it("lifts the model's No to Unsure: a plumber's danger word is in the text, and the read's tense is now", async () => {
    const read = { labels: [label("No", "now")] };
    const answer = await readWith(read, input, PLUMBER_WORDS);
    expect(answer.result).toEqual({
      eventId: "evt-alex-0220",
      source: "text",
      tries: [{ model: "haiku", result: "verdict" }],
      read,
      timedOut: false,
      dangerWords: [plugin("smell gas")],
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
  });

  it.each(["now", "could restart", "unknown"] as const)(
    "lifts it when the label that quotes the words has tense %s",
    async (tense) => {
      const answer = await readWith({ labels: [label("No", tense, "I smell gas")] }, input, PLUMBER_WORDS);
      expect(answer.result).toMatchObject({ outcomes: ["Unsure"], liftedToUnsure: true });
    },
  );

  it("lifts it when the read's only label is a danger that is over, and no label quotes the words", async () => {
    const words = "our dryer caught fire last year and it's all fixed. I smell gas";
    const read = {
      labels: [label("An emergency", "over", "our dryer caught fire last year and it's all fixed")],
    };
    expect(heldOutcomes(read)).toEqual(["No"]);
    const answer = await readWith(read, text("evt-alex-0221", words), PLUMBER_WORDS);
    expect(answer.result).toMatchObject({
      dangerWords: [plugin("smell gas")],
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
  });

  it("lifts it when one label quoting the words is over and another quoting them is now", async () => {
    const words = "we used to smell gas in the kitchen, and now I smell gas in the basement";
    const read = {
      labels: [
        label("No", "over", "we used to smell gas in the kitchen"),
        label("No", "now", "I smell gas in the basement"),
      ],
    };
    const answer = await readWith(read, text("evt-alex-0222", words), PLUMBER_WORDS);
    expect(answer.result).toMatchObject({ outcomes: ["Unsure"], liftedToUnsure: true });
  });
});

describe("a danger word with tense joke or over stays No", () => {
  const TEXTS: Record<"joke" | "over", string> = {
    joke: "lol I smell gas, that's just my brother's chili",
    over: "we used to smell gas in the kitchen, but the gas company fixed it in March",
  };

  it.each(["joke", "over"] as const)(
    "a No label of tense %s that quotes the words keeps No",
    async (tense) => {
      const words = TEXTS[tense];
      const answer = await readWith(
        { labels: [label("No", tense, words)] },
        text("evt-alex-0223", words),
        PLUMBER_WORDS,
      );
      expect(answer.result).toMatchObject({
        dangerWords: [plugin("smell gas")],
        outcomes: ["No"],
        liftedToUnsure: false,
      });
    },
  );

  it.each(["joke", "over"] as const)(
    "a danger label of tense %s that quotes the words is not danger either: No",
    async (tense) => {
      const words = TEXTS[tense];
      const answer = await readWith(
        { labels: [label("An emergency", tense, words, "unknown")] },
        text("evt-alex-0224", words),
        PLUMBER_WORDS,
      );
      expect(answer.result).toMatchObject({ outcomes: ["No"], liftedToUnsure: false });
    },
  );

  it("keeps No when every label that quotes the words is over or joke", async () => {
    const words = `${TEXTS.over}. ${TEXTS.joke}`;
    const read = {
      labels: [label("An emergency", "over", TEXTS.over, "unknown"), label("No", "joke", TEXTS.joke)],
    };
    const answer = await readWith(read, text("evt-alex-0225", words), PLUMBER_WORDS);
    expect(answer.result).toMatchObject({
      dangerWords: [plugin("smell gas")],
      outcomes: ["No"],
      liftedToUnsure: false,
    });
  });
});

describe("no verdict in 4 s", () => {
  it("with a danger word gives safety-timeout-danger-word.json, at 4 s and not a moment before", async () => {
    const marker = k02("safety-timeout-danger-word.json");
    const answer = await readTimingOut(text(marker.eventId, BLEEDING_CUT), K02_DANGER_WORDS);
    expect(answer.result).toEqual(marker);
    expect(answer.result.dangerWords).toEqual([plugin("cut won't stop bleeding")]);
  });

  it("with a self-harm word gives safety-timeout-self-harm-word.json", async () => {
    const marker = k02("safety-timeout-self-harm-word.json");
    const answer = await readTimingOut(
      text(marker.eventId, textOf("safety-crisis-words.json")),
      K02_DANGER_WORDS,
    );
    expect(answer.result).toEqual(marker);
  });

  it("without one gives the plain timeout marker: no read, no outcome, nothing lifted", async () => {
    const answer = await readTimingOut(text("evt-alex-0212", textOf("safety-no.json")), K02_DANGER_WORDS);
    expect(answer.result).toEqual({
      eventId: "evt-alex-0212",
      source: "text",
      tries: [
        { model: "haiku", result: "timeout" },
        { model: "sonnet", result: "timeout" },
      ],
      read: null,
      timedOut: true,
      dangerWords: [],
      outcomes: [],
      liftedToUnsure: false,
    });
  });

  it("counts a general check's word as Unsure too", async () => {
    const answer = await readTimingOut(
      text("evt-alex-0213", textOf("safety-unknown-tense.json")),
      K02_DANGER_WORDS,
    );
    expect(answer.result).toMatchObject({
      read: null,
      timedOut: true,
      dangerWords: [general("fire")],
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
  });

  it("gives the same marker at the 4 s mark when both tries fail fast", async () => {
    const answer = await readTimingOut(
      text("evt-alex-0214", BLEEDING_CUT),
      K02_DANGER_WORDS,
      always({ kind: "status", status: 503 }),
    );
    expect(answer.result).toMatchObject({
      tries: [
        { model: "haiku", result: "error" },
        { model: "sonnet", result: "error" },
      ],
      read: null,
      timedOut: true,
      dangerWords: [plugin("cut won't stop bleeding")],
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
  });

  it("is the actor's own stand-in for a timeout, for the same text and danger words (T-246's timeoutResult)", async () => {
    const texts = [
      BLEEDING_CUT,
      textOf("safety-crisis-words.json"),
      textOf("safety-no.json"),
      textOf("safety-unknown-tense.json"),
    ];
    for (const [n, words] of texts.entries()) {
      const eventId = `evt-alex-023${String(n)}`;
      const answer = await readTimingOut(text(eventId, words), K02_DANGER_WORDS);
      expect(answer.result).toEqual(
        timeoutResult(eventId, matchDangerWords([words, null], K02_DANGER_WORDS)),
      );
    }
  });
});

describe("the lift never lowers a verdict", () => {
  it("keeps An emergency when the barbershop's own danger words are found (safety-emergency-now.json)", async () => {
    const file = "safety-emergency-now.json";
    const answer = await readFixture(file, K02_DANGER_WORDS);
    expect(answer.result).toMatchObject({
      dangerWords: [plugin("lips are swelling")],
      outcomes: ["An emergency"],
      liftedToUnsure: false,
    });
    expect(answer.result).toEqual(k02(file));
  });

  it("keeps the model's own Unsure as the model gave it: code lifted nothing", async () => {
    const answer = await readWith(
      { labels: [label("Unsure", "unknown", "I smell gas", "unknown")] },
      text("evt-alex-0226", "I smell gas"),
      PLUMBER_WORDS,
    );
    expect(answer.result).toMatchObject({ outcomes: ["Unsure"], liftedToUnsure: false });
  });

  it("keeps every danger outcome, alone or several, whatever words are found", () => {
    const matches = [plugin("smell gas"), general("fire")];
    const read = { labels: [label("No", "now")] };
    for (const outcome of SAFETY_OUTCOMES.filter((entry) => entry !== "No")) {
      expect(afterVerdict([outcome], read, matches)).toEqual({
        dangerWords: matches,
        outcomes: [outcome],
        liftedToUnsure: false,
      });
    }
    const several = ["Unsafe at home", "Crisis words"] as const;
    expect(afterVerdict(several, read, matches).outcomes).toEqual(several);
  });
});

describe("which words count", () => {
  it("reports a general check's word on a verdict, but it does not lift No: the model reads the general check", async () => {
    const answer = await readWith({ labels: [label("No", "now")] }, text("evt-alex-0227", "I smell gas"), [
      general("smell gas"),
    ]);
    expect(answer.result).toMatchObject({
      dangerWords: [general("smell gas")],
      outcomes: ["No"],
      liftedToUnsure: false,
    });
  });

  it("finds the words in an email's subject too", async () => {
    const answer = await readWith(
      { labels: [label("No", "now")] },
      text("evt-alex-0228", "Can someone come out today?", "I smell gas"),
      PLUMBER_WORDS,
    );
    expect(answer.result).toMatchObject({
      dangerWords: [plugin("smell gas")],
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
  });

  it("finds words in any case, with curly quotes and odd spacing, never inside another word, each once in the list's order", () => {
    expect(findDangerWords({ text: "MY  CUT WON’T STOP\nBLEEDING" }, K02_DANGER_WORDS)).toEqual([
      plugin("cut won't stop bleeding"),
    ]);
    expect(findDangerWords({ text: "the fireplace guy fired up the gas leaker" }, K02_DANGER_WORDS)).toEqual(
      [],
    );
    expect(
      findDangerWords(
        { text: "fire in the shed, a gas leak, then more fire", subject: null },
        K02_DANGER_WORDS,
      ),
    ).toEqual([general("gas leak"), general("fire")]);
  });

  it("finds nothing and lifts nothing when no danger words are given: the read as T-365 gave it", async () => {
    const verdict = await readFixture("safety-over-gas-leak.json");
    expect(verdict.result).toEqual({ ...k02("safety-over-gas-leak.json"), dangerWords: [] });
    const lifted = await readWith({ labels: [label("No", "now")] }, text("evt-alex-0229", "I smell gas"));
    expect(lifted.result).toMatchObject({ dangerWords: [], outcomes: ["No"], liftedToUnsure: false });
    const marker = await readTimingOut(text("evt-alex-0215", BLEEDING_CUT));
    expect(marker.result).toMatchObject({ dangerWords: [], outcomes: [], liftedToUnsure: false });
  });
});

describe("the person's words stay in the answer", () => {
  it("puts no danger word and no text into a span or the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const context = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE.bundleId,
      handleRef: "handle-alex",
    });

    const liftApi = fakeMessagesApi(
      recorded,
      always({ kind: "ok", output: { labels: [label("No", "now")] } }),
    );
    const lifted = await readerOver(liftApi).read(text("evt-alex-0240", "I smell gas"), {
      trace: context,
      dangerWords: PLUMBER_WORDS,
    });
    expect(lifted.result.liftedToUnsure).toBe(true);

    const hangApi = fakeMessagesApi(recorded, always({ kind: "hang" }));
    const pending = readerOver(hangApi).read(text("evt-alex-0241", BLEEDING_CUT), {
      trace: context,
      dangerWords: K02_DANGER_WORDS,
    });
    await vi.advanceTimersByTimeAsync(SAFETY_VERDICT_MS);
    const marker = await pending;
    expect(marker.result.liftedToUnsure).toBe(true);

    expect(context.spans).toHaveLength(3);
    const spans = JSON.stringify(context.toTrace());
    for (const words of [
      "I smell gas",
      "smell gas",
      BLEEDING_CUT,
      "cut won't stop bleeding",
      "bleeding",
      "Riley",
    ]) {
      expect(spans).not.toContain(words);
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("the actor's danger words feed the read as they are (T-246)", () => {
  it("takes BundleSafety.dangerWords() as the call's list, and answers the port with code's rules applied", async () => {
    // The actor's shapes are the runtime's (runtime/src/safety/types.ts): this compiles only if its entries are the read's.
    const bundleSafety: Pick<BundleSafety, "dangerWords"> = { dangerWords: () => K02_DANGER_WORDS };
    const api = fakeMessagesApi(recorded, always({ kind: "double" }));
    const reader = readerOver(api);
    const port: SafetyReadPort = {
      read: (request) =>
        reader.read(
          {
            eventId: request.eventId,
            source: request.source,
            text: request.words.body ?? "",
            subject: request.words.subject,
          },
          { dangerWords: bundleSafety.dangerWords() },
        ),
    };
    const file = "safety-emergency-now.json";
    const answer = await port.read({
      eventId: k02(file).eventId,
      source: "text",
      traceId: "6f1f4f0e-8c0a-4a77-9d36-2f5c3a1b9d10",
      bundleId: MANIFEST.bundleId,
      words: { body: textOf(file), subject: null },
    });
    expect(answer.result).toEqual(k02(file));
  });
});

describe("code's rules alone (lift.ts)", () => {
  const smellGas: DangerWordMatch = plugin("smell gas");

  it("a label quotes a word by the rule that finds it in the text", () => {
    expect(quotes("I smell gas in here", smellGas)).toBe(true);
    expect(quotes("I SMELL  GAS", smellGas)).toBe(true);
    expect(quotes("I smelled gas", smellGas)).toBe(false);
    expect(quotes("", smellGas)).toBe(false);
  });

  it("a word is out of danger only when labels quote it and every one of them is over or joke", () => {
    expect(outOfDanger({ labels: [label("No", "over", "smell gas")] }, smellGas)).toBe(true);
    expect(outOfDanger({ labels: [label("No", "joke", "smell gas"), label("No", "now")] }, smellGas)).toBe(
      true,
    );
    expect(
      outOfDanger({ labels: [label("No", "over", "smell gas"), label("No", "now", "smell gas")] }, smellGas),
    ).toBe(false);
    expect(outOfDanger({ labels: [label("No", "over", "it was fixed")] }, smellGas)).toBe(false);
    expect(outOfDanger({ labels: [label("No", "now")] }, smellGas)).toBe(false);
  });

  it("afterVerdict lifts No alone, and only for a trade's word the read does not place out of danger", () => {
    const now = { labels: [label("No", "now")] };
    const over = { labels: [label("No", "over", "smell gas")] };
    expect(afterVerdict(["No"], now, [smellGas])).toEqual({
      dangerWords: [smellGas],
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
    expect(afterVerdict(["No"], over, [smellGas])).toEqual({
      dangerWords: [smellGas],
      outcomes: ["No"],
      liftedToUnsure: false,
    });
    expect(afterVerdict(["No"], now, [general("smell gas")])).toMatchObject({
      outcomes: ["No"],
      liftedToUnsure: false,
    });
    expect(afterVerdict(["No"], now, [])).toEqual({
      dangerWords: [],
      outcomes: ["No"],
      liftedToUnsure: false,
    });
    // One trade word placed out of danger, another not: the other lifts.
    expect(afterVerdict(["No"], over, [smellGas, plugin("carbon monoxide alarm")])).toMatchObject({
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
  });

  it("timeoutMarker counts any danger word as Unsure, and with none is the plain marker", () => {
    expect(timeoutMarker([general("don't want to be alive", "selfHarm")])).toEqual({
      dangerWords: [general("don't want to be alive", "selfHarm")],
      outcomes: ["Unsure"],
      liftedToUnsure: true,
    });
    expect(timeoutMarker([smellGas])).toMatchObject({ outcomes: ["Unsure"], liftedToUnsure: true });
    expect(timeoutMarker([])).toEqual({ dangerWords: [], outcomes: [], liftedToUnsure: false });
  });

  it("copies the matches it is given and changes none of them", () => {
    const matches = [smellGas];
    const verdict = afterVerdict(["No"], { labels: [label("No", "now")] }, matches);
    const marker = timeoutMarker(matches);
    expect(verdict.dangerWords).not.toBe(matches);
    expect(marker.dangerWords).not.toBe(matches);
    expect(matches).toEqual([plugin("smell gas")]);
  });
});
