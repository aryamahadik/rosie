// Tests of the composer's call (T-373, C-118). Offline, as every AI test (J-02: no live call; CI makes none): each
// model answer is the recorded-model double's (T-004; ai/recordings/composer.v1.json, seeded from K-03 v1's plans),
// sent back through the AI gateway (T-361) by T-364's fake Messages API with its prompt cache; K-03's fixtures come
// through the message-plan contract loader (T-1071), its refused fixtures from fixtures/invalid; the global fetch fails
// the file if anything reaches it. Names and values are the master's sample cast (rule 9).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fakeTokens } from "../cache/test-support";
import { GatewayConfigError, HAIKU_MODEL, SONNET_MODEL } from "../gateway";
import {
  loadPlanContract,
  loadRecordedDouble,
  type JsonObject,
  type PlanContract,
  type RecordedDouble,
} from "../recorded-double";
import { openTrace, spanProblems, type Span } from "../../../runtime/src/trace";
import { schemaErrors } from "../../../runtime/src/trace/test-support";
import {
  COMPOSER_PROMPT,
  PLAN_SCHEMA,
  composeInputText,
  createComposer,
  planProblems,
  type ComposeAnswer,
  type ComposeInput,
  type MessagePlan,
} from "./index";
import {
  ENV,
  GATEWAY_BUNDLE,
  KEY,
  PROMPTS,
  composerOn,
  fakeComposerApi,
  readJson,
  recordedInput,
  type RecordedInput,
  type RowAnswer,
} from "./test-support";

const globalFetch = vi.fn(() => {
  throw new Error("no network in a composer test: the global fetch was called");
});

let contract: PlanContract;
let double: RecordedDouble;

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  contract = loadPlanContract();
  double = await loadRecordedDouble();
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const k03 = (file: string): unknown => contract.fixtures.read(file);
const invalid = (file: string): unknown => readJson(`contracts/message-plan/fixtures/invalid/${file}`);
/** The double's plan for exactly this input (it has no fallback plan). */
const recordedPlan = (input: ComposeInput): Promise<JsonObject> =>
  double.composer(input as unknown as JsonObject);
const newTrace = (): ReturnType<typeof openTrace> =>
  openTrace({ openedBy: "textWebhook", bundleId: GATEWAY_BUNDLE.bundleId, handleRef: "handle-1" });
const callsOf = (spans: readonly Span[]): NonNullable<Span["model_calls"]> =>
  spans.flatMap((span) => span.model_calls ?? []);

/** One row composed, the fake model answering `plan`, or the double's own plan for the row when none is given. */
async function composeRow(
  input: ComposeInput,
  plan?: unknown,
): Promise<{ answer: ComposeAnswer; api: ReturnType<typeof fakeComposerApi> }> {
  const answer = plan ?? (await recordedPlan(input));
  const api = fakeComposerApi([{ input, plan: answer }]);
  return { answer: await composerOn(api.fetch).compose(input), api };
}

function planOf(answer: ComposeAnswer): MessagePlan {
  if (answer.status !== "ok") throw new Error(`expected a plan, got ${answer.status}`);
  return answer.plan;
}

describe("one row's K-03 input gives its plan, through the recorded-model double", () => {
  it.each([
    ["block-readback-poll", "plan-block-readback-poll.json"],
    ["confirmation-a6-14", "plan-confirmation-a6-14.json"],
  ] as const)(
    "the %s row is reproduced as K-03's %s, from one Haiku call with the composer prompt cached and the row as the turn",
    async (name, file) => {
      const input = recordedInput(name);
      const { answer, api } = await composeRow(input);
      expect(answer).toMatchObject({
        status: "ok",
        model: HAIKU_MODEL,
        role: "haiku",
        attempt: 1,
        fallback: false,
      });
      expect(planOf(answer)).toEqual(k03(file));
      expect(api.calls).toHaveLength(1);
      const [call] = api.calls;
      expect(call?.model).toBe(HAIKU_MODEL);
      expect(call?.body.system).toEqual([
        { type: "text", text: COMPOSER_PROMPT.text, cache_control: { type: "ephemeral" } },
      ]);
      expect(call?.body.messages).toEqual([{ role: "user", content: composeInputText(input) }]);
      expect(call?.body.output_config).toEqual({
        effort: "low",
        format: { type: "json_schema", schema: PLAN_SCHEMA },
      });
    },
  );

  it("the double's three other rows come back as their K-03 plans too: the relay with a private part, the sensitive staff plan, the tapback", async () => {
    const rows: [RecordedInput, string][] = [
      ["relay-private-a7-12", "plan-relay-private-a7-12.json"],
      ["sensitive-a6-15", "plan-sensitive.json"],
      ["tapback-thanks", "plan-tapback-thanks.json"],
    ];
    for (const [name, file] of rows) {
      const { answer } = await composeRow(recordedInput(name));
      expect(planOf(answer), name).toEqual(k03(file));
    }
  });

  it("input-s1-02.json with plan-s1-02.json: the double gives K-03's plan, a whole K-03 plan, but its fact line types a price and a number that input-s1-02's facts (none) do not hold, so it is refused, never returned", async () => {
    const input = k03("input-s1-02.json") as ComposeInput;
    const plan = k03("plan-s1-02.json");
    expect(await recordedPlan(input)).toEqual(plan);
    expect(planProblems(plan)).toEqual([]);
    expect(input.facts).toEqual([]);
    const { answer, api } = await composeRow(input);
    expect(api.calls).toHaveLength(1);
    expect(answer).toEqual({
      status: "refused",
      stage: "plan",
      problems: [
        { check: "literalValue", at: "lines[1].text", kind: "price" },
        { check: "literalValue", at: "lines[1].text", kind: "number" },
      ],
      modelCalls: expect.any(Array) as unknown,
    });
  });
});

describe("a typed refusal, never a plan", () => {
  it("an input with a frontier is refused before any call (refuse-frontier-in-input.json)", async () => {
    const input = invalid("refuse-frontier-in-input.json") as ComposeInput;
    expect(contract.validate("composeInput", input)).not.toEqual([]);
    const api = fakeComposerApi([]);
    const answer = await composerOn(api.fetch).compose(input);
    expect(answer).toEqual({
      status: "refused",
      stage: "input",
      problems: [{ check: "frontier", at: "frontier" }],
      modelCalls: [],
    });
    expect(api.calls).toHaveLength(0);
  });

  it("a plan with a format outside allowed_formats is refused (refuse-format-not-allowed.json), and so is a K-03 format this row's phone does not allow", async () => {
    const input = recordedInput("confirmation-a6-14");
    const first = await composeRow(input, invalid("refuse-format-not-allowed.json"));
    expect(first.answer).toMatchObject({
      status: "refused",
      stage: "plan",
      problems: [{ check: "formatNotAllowed", at: "formats[1]" }],
    });
    expect(first.api.calls).toHaveLength(1);
    // The confirmation's own plan, for the same row on a phone that allows text alone.
    const textOnly: ComposeInput = { ...input, allowedFormats: ["text"] };
    const second = await composeRow(textOnly, k03("plan-confirmation-a6-14.json"));
    expect(second.answer).toMatchObject({
      status: "refused",
      stage: "plan",
      problems: [
        { check: "formatNotAllowed", at: "formats[1]" },
        { check: "formatNotAllowed", at: "formats[2]" },
      ],
    });
  });

  it("a 'hold' slot is refused (refuse-hold-slot.json)", async () => {
    const { answer } = await composeRow(
      recordedInput("confirmation-a6-14"),
      invalid("refuse-hold-slot.json"),
    );
    expect(answer).toMatchObject({
      status: "refused",
      stage: "plan",
      problems: [{ check: "holdSlot", at: "lines[1].text" }],
    });
    expect(answer).not.toHaveProperty("plan");
  });

  it("an answer that is not a K-03 plan is refused: not an object, a field missing or too many, a line role or slot K-03 does not have", async () => {
    const input = recordedInput("relay-private-a7-12");
    const plan = (await recordedPlan(input)) as unknown as { lines: { role: string; text: string }[] };
    const answers: [unknown, unknown[]][] = [
      ["a plan", [{ check: "plan", at: "(root)" }]],
      [
        { ...plan, question: undefined },
        [
          { check: "plan", at: "(root)" },
          { check: "plan", at: "question" },
        ],
      ],
      [{ ...plan, frontier: [] }, [{ check: "plan", at: "(root)" }]],
      [{ ...plan, lines: [{ role: "intro", text: "Hello" }] }, [{ check: "plan", at: "lines[0].role" }]],
      [
        { ...plan, lines: [{ role: "first", text: "{{price.total}} asks" }] },
        [{ check: "unknownSlot", at: "lines[0].text" }],
      ],
    ];
    for (const [answer, problems] of answers) {
      const { answer: result } = await composeRow(input, answer);
      expect(result).toMatchObject({ status: "refused", stage: "plan", problems });
    }
  });
});

describe("no plan carries a literal number, date or price the input's facts do not hold as a slot", () => {
  /** The confirmation's plan with one line's words changed, as a model might type them. */
  function confirmationWith(k: number, text: string): unknown {
    const plan = structuredClone(k03("plan-confirmation-a6-14.json")) as {
      lines: { role: string; text: string }[];
    };
    const line = plan.lines[k];
    if (line === undefined) throw new Error(`the confirmation has no line ${String(k)}`);
    line.text = text;
    return plan;
  }

  it.each([
    ["a price", 3, "$45 · {{pay.took}}", "price"],
    ["a date", 1, "{{svc.intext}} · Sun Oct 25 · {{visit.time}} · {{pro.name}}", "date"],
    ["a time", 1, "{{svc.intext}} · {{day}} · 2:00pm · {{pro.name}}", "date"],
    ["a relative day", 4, "Please tell us by tomorrow", "date"],
    [
      "a code",
      0,
      "You're booked at {{biz.name}}. Give this code at the chair when you arrive: 5161",
      "number",
    ],
  ] as const)(
    "%s typed into the words is refused, naming the line and the kind, never the words",
    async (_what, k, text, kind) => {
      const { answer } = await composeRow(recordedInput("confirmation-a6-14"), confirmationWith(k, text));
      expect(answer).toMatchObject({
        status: "refused",
        stage: "plan",
        problems: [{ check: "literalValue", at: `lines[${String(k)}].text`, kind }],
      });
      for (const words of ["$45", "Sun Oct 25", "2:00pm", "tomorrow", "5161"])
        expect(JSON.stringify(answer)).not.toContain(words);
    },
  );

  it("a value a fact holds is not refused here (the Values check after the fill matches it to that fact, arch 07 line 409), nor are a slot's example words", async () => {
    const typed = await composeRow(
      recordedInput("confirmation-a6-14"),
      confirmationWith(0, "You're booked at {{biz.name}}. Give this code at the chair when you arrive: 5160"),
    );
    expect(typed.answer.status).toBe("ok");
    // The read-back's {{visit.time:3:00pm}} and {{change.when:Thu Oct 29, 2–5pm}} are slots with example words.
    const readback = await composeRow(recordedInput("block-readback-poll"));
    expect(planOf(readback.answer).question?.text).toContain("{{change.when:Thu Oct 29, 2–5pm}}");
  });
});

describe("one Haiku call per outbox row, through the AI gateway", () => {
  async function recordedRows(): Promise<RowAnswer[]> {
    const names: RecordedInput[] = [
      "block-readback-poll",
      "confirmation-a6-14",
      "relay-private-a7-12",
      "sensitive-a6-15",
      "tapback-thanks",
    ];
    return Promise.all(
      names.map(async (name) => {
        const input = recordedInput(name);
        return { input, plan: await recordedPlan(input) };
      }),
    );
  }

  it("a turn's rows side by side: five rows, five Haiku calls, each its own row after the same system prompt, each a compose span valid under K-08", async () => {
    const rows = await recordedRows();
    const api = fakeComposerApi(rows);
    const composer = composerOn(api.fetch);
    const trace = newTrace();
    const answers = await Promise.all(rows.map(({ input }) => composer.compose(input, { trace })));
    answers.forEach((answer, k) => {
      expect(planOf(answer)).toEqual(rows[k]?.plan);
    });
    expect(api.calls).toHaveLength(5);
    expect(new Set(api.calls.map((call) => call.model))).toEqual(new Set([HAIKU_MODEL]));
    expect(new Set(api.calls.map((call) => JSON.stringify(call.body.system))).size).toBe(1);
    expect(new Set(api.calls.map((call) => JSON.stringify(call.body.messages))).size).toBe(5);
    expect(callsOf(trace.spans).map((call) => [call.purpose, call.model])).toEqual(
      rows.map(() => ["compose", HAIKU_MODEL]),
    );
    for (const span of trace.spans) {
      expect(spanProblems(span)).toEqual([]);
      expect(schemaErrors("span", span)).toEqual([]);
    }
  });

  it("the next row reads the composer prompt from the cache the first row wrote", async () => {
    const rows = await recordedRows();
    const api = fakeComposerApi(rows);
    const composer = composerOn(api.fetch);
    const trace = newTrace();
    for (const { input } of rows.slice(0, 2)) await composer.compose(input, { trace });
    const prefix = fakeTokens(COMPOSER_PROMPT.text);
    expect(callsOf(trace.spans).map((call) => [call.cached_tokens, call.cache_write_tokens])).toEqual([
      [0, prefix],
      [prefix, 0],
    ]);
  });

  it("Haiku failing twice: the gateway asks Sonnet once, and its plan is checked the same way", async () => {
    const rows = await recordedRows();
    const api = fakeComposerApi(rows, { fail: (_body, n) => (n < 2 ? 529 : null) });
    const input = recordedInput("confirmation-a6-14");
    const answer = await composerOn(api.fetch).compose(input);
    expect(answer).toMatchObject({
      status: "ok",
      model: SONNET_MODEL,
      role: "sonnet",
      attempt: 3,
      fallback: true,
    });
    expect(planOf(answer)).toEqual(k03("plan-confirmation-a6-14.json"));
    expect(api.calls.map((call) => call.model)).toEqual([HAIKU_MODEL, HAIKU_MODEL, SONNET_MODEL]);
    if (answer.status === "ok") expect(answer.modelCalls).toHaveLength(3);
  });

  it("all three attempts failing: modelsDown, with each failure's label and no plan", async () => {
    const rows = await recordedRows();
    const api = fakeComposerApi(rows, { fail: () => 529 });
    const answer = await composerOn(api.fetch).compose(recordedInput("confirmation-a6-14"));
    expect(answer).toMatchObject({ status: "modelsDown" });
    expect(answer).not.toHaveProperty("plan");
    if (answer.status !== "modelsDown") throw new Error("expected modelsDown");
    expect(answer.failures.map((failure) => [failure.role, failure.code])).toEqual([
      ["haiku", "http_529"],
      ["haiku", "http_529"],
      ["sonnet", "http_529"],
    ]);
    expect(answer.modelCalls).toHaveLength(3);
  });

  it("refuses at set-up a layout of another bundle than its models", () => {
    const other = { hash: GATEWAY_BUNDLE.bundleId.hash, build: GATEWAY_BUNDLE.bundleId.build + 1 };
    expect(() =>
      createComposer({ bundle: { ...GATEWAY_BUNDLE, bundleId: other }, prompts: PROMPTS, env: ENV }),
    ).toThrow(GatewayConfigError);
  });
});

describe("never a word of the row or the plan in a span, a refusal or a log line (K-08 README line 75)", () => {
  it("composing a row and refusing another leaves no input words, plan words or key in the trace, the refusal or the console", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method));
    try {
      const confirmation = recordedInput("confirmation-a6-14");
      const relay = recordedInput("relay-private-a7-12");
      const plan = (await recordedPlan(confirmation)) as unknown as MessagePlan;
      const typed = structuredClone(await recordedPlan(relay)) as unknown as {
        lines: { role: string; text: string }[];
      };
      const first = typed.lines[0];
      if (first === undefined) throw new Error("the relay plan has a first line");
      first.text = "{{alex.staff}} asks about Sun Oct 25 at $45";
      const api = fakeComposerApi([
        { input: confirmation, plan },
        { input: relay, plan: typed },
      ]);
      const composer = composerOn(api.fetch);
      const trace = newTrace();
      const ok = await composer.compose(confirmation, { trace });
      const refused = await composer.compose(relay, { trace });
      expect(ok.status).toBe("ok");
      expect(refused).toMatchObject({ status: "refused", stage: "plan" });

      const seen = JSON.stringify(trace.toTrace()) + JSON.stringify(refused);
      const words = [
        ...[confirmation, relay].flatMap((input) => [
          ...input.facts.map((fact) => fact.value),
          ...input.conversation.map((message) => message.text),
          input.masterText.text,
          input.audience.name ?? "",
        ]),
        ...plan.lines.map((line) => line.text),
        first.text,
        "Sun Oct 25",
        "$45",
        KEY,
      ].filter((text) => text.length >= 4);
      expect(words.length).toBeGreaterThan(20);
      for (const text of words) expect(seen).not.toContain(text);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
