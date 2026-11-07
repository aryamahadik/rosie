// Tests of the prompt layout (T-364, C-122): byte-identical cached prefixes per bundle, the per-turn part after the last
// cache breakpoint, static card text from the bundle, and what is refused. Offline: inputs are K-01 v1's sample bundles,
// K-02 v1's contexts, the recorded double's contexts and K-03 v1's composer inputs (the master's sample cast; rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CACHE_MARKER,
  CACHE_PURPOSES,
  CACHE_RULES,
  CARDS_OPEN,
  CONTEXT_PURPOSES,
  CacheLayoutError,
  RULES_CLOSE,
  RULES_OPEN,
  createPromptCache,
  isContextPurpose,
  messagesParams,
  sha256Hex,
  systemText,
  type CacheBundle,
  type CachePurpose,
  type CachedPrompt,
  type PromptCache,
  type StepCard,
  type TurnContext,
} from "./index";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A K-02 v1 context, with the per-turn fields these tests read, to change in a test. */
interface Context extends Mutable<TurnContext> {
  turnId: string;
  texts: { eventId: string; words: string; sentAt: { utc: string; zone: string } }[];
  writer: { handle: string; people: { personId: string }[] };
  choices: { choiceId: string; kind: string; label: string; definition: string }[];
  facts: { name: string; value: unknown }[];
  recentMessages: { words: string; sentAt: { utc: string } }[];
}

/** A bundle as plain JSON, to change in a test. */
interface MutableBundle {
  manifest: {
    bundleId: { hash: string; build: number };
    prompts: Record<string, { version: string; sha256: string; text: string }>;
    partial?: boolean;
  };
  flows: Record<
    string,
    | {
        flow: string;
        steps: Record<string, { card?: StepCard }>;
        routing: { alwaysOn: { steps: string[]; prefixText: string; prefixSha256: string } };
      }
    | undefined
  >;
}

const sample = (file: string): CacheBundle => readJson(`contracts/bundle/fixtures/${file}`) as CacheBundle;
const k02 = (file: string): Context => readJson(`contracts/model/fixtures/${file}`) as Context;
const recorded = (file: string): Context => readJson(`ai/recordings/contexts/${file}`) as Context;
const mutable = (bundle: CacheBundle): MutableBundle => structuredClone(bundle) as unknown as MutableBundle;
const asBundle = (bundle: MutableBundle): CacheBundle => bundle as unknown as CacheBundle;

/** The per-turn part as these tests write it; C-114 writes the real one. */
function perTurn(context: Context): string {
  return [
    "<choices>",
    ...context.choices.map(
      (choice) => `${choice.choiceId} (${choice.kind}): ${choice.label}. ${choice.definition}`,
    ),
    "</choices>",
    "<facts>",
    ...context.facts.map((fact) => `${fact.name}: ${JSON.stringify(fact.value)}`),
    "</facts>",
    "<turn>",
    ...context.texts.map((text) => text.words),
    "</turn>",
  ].join("\n");
}

const V0 = sample("bundle-v0-skeleton.json");
const S1_02 = k02("context-s1-02.json");
const PLANNER_ANSWER = recorded("planner-answer.json");
const PLANNER_LOG_GAP = recorded("planner-log-gap.json");
const RULES_A = V0.flows.A?.routing.alwaysOn.prefixText ?? "";

/** Lays out one call of a purpose for a turn: a context purpose from the context, the others from the text alone. */
function layoutOf(cache: PromptCache, purpose: CachePurpose, context: Context, turn: string): CachedPrompt {
  return isContextPurpose(purpose)
    ? cache.forContext(context, purpose, turn)
    : cache.layout({ purpose, turn });
}

const encoder = new TextEncoder();

/** The same bytes, compared as UTF-8, not only as equal strings. */
function sameBytes(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** A later turn on the same open question: new texts, times, ids, facts and messages; the same card, listed twice. */
function laterTurnOn(context: Context): Context {
  const later = structuredClone(context);
  later.turnId = "turn-s1-02-sam-kinds-again";
  later.texts = later.texts.map((text) => ({
    ...text,
    eventId: "evt-sam-0002",
    words: "Actually just the barbershop for now",
    sentAt: { utc: "2026-10-19T14:09:30Z", zone: "America/New_York" },
  }));
  later.facts = [{ name: "pf.services", value: "Haircut, $35, 30 minutes" }];
  later.recentMessages = [];
  later.choices.reverse();
  later.cards = [...later.cards, ...later.cards];
  return later;
}

describe("two turns on one bundle id produce byte-identical prefixes", () => {
  const cache = createPromptCache(V0);

  it("decide, the re-read and the planner: three turns' static segments are the same bytes, the prompt then the rules", () => {
    for (const purpose of CONTEXT_PURPOSES) {
      const prompts = [S1_02, PLANNER_ANSWER, PLANNER_LOG_GAP].map((context) =>
        cache.forContext(context, purpose, perTurn(context)),
      );
      const kind = purpose === "planner" ? "planner" : "decide";
      const expected = `${V0.manifest.prompts[kind].text}${RULES_OPEN}${RULES_A}${RULES_CLOSE}`;
      for (const prompt of prompts) {
        expect(prompt.segments[0]?.kind).toBe("static");
        expect(sameBytes(prompt.segments[0]?.text ?? "", expected)).toBe(true);
      }
      expect(new Set(prompts.map((prompt) => prompt.turn)).size).toBe(3);
    }
    // The 50 rules: the flow's whole prefix text, about 80,000 characters, once.
    expect(RULES_A.length).toBeGreaterThan(70000);
    expect(systemText(cache.forContext(S1_02, "decideFirst", "turn")).split(RULES_A)).toHaveLength(2);
  });

  it("two turns showing the same cards have the same cards segment too, whatever order and however often the context lists them", () => {
    const later = laterTurnOn(S1_02);
    for (const purpose of CONTEXT_PURPOSES) {
      const first = cache.forContext(S1_02, purpose, perTurn(S1_02));
      const second = cache.forContext(later, purpose, perTurn(later));
      expect(first.segments.map((segment) => segment.kind)).toEqual(["static", "cards"]);
      expect(second.segments).toEqual(first.segments);
      expect(sameBytes(systemText(second), systemText(first))).toBe(true);
      expect(second.turn).not.toBe(first.turn);
    }
  });

  it("the safety read and the composer: the prompt alone, the same bytes for every text and every outbox row", () => {
    const texts = ["Can I book a haircut for Saturday at 2?", "there was a fire in the back room"];
    for (const turn of texts) {
      expect(cache.layout({ purpose: "safetyRead", turn }).segments).toEqual([
        { kind: "static", text: V0.manifest.prompts.safetyRead.text },
      ]);
    }
    const rows = [
      readJson("contracts/message-plan/fixtures/input-s1-02.json"),
      readJson("ai/recordings/composer-inputs/block-readback-poll.json"),
    ].map((input) => `<input>${JSON.stringify(input)}</input>`);
    for (const purpose of ["compose", "rewrite"] as const) {
      const prompts = rows.map((turn) => cache.layout({ purpose, turn }));
      for (const prompt of prompts) {
        expect(prompt.segments).toEqual([{ kind: "static", text: V0.manifest.prompts.composer.text }]);
      }
      expect(prompts.map((prompt) => prompt.turn)).toEqual(rows);
    }
  });

  it("holds no time, id or value of a turn: not its ids, words, times, handle, people, facts or messages, nor the bundle id", () => {
    for (const context of [S1_02, laterTurnOn(S1_02), PLANNER_ANSWER, PLANNER_LOG_GAP]) {
      const values = [
        context.turnId,
        context.writer.handle,
        ...context.writer.people.map((person) => person.personId),
        ...context.texts.flatMap((text) => [text.eventId, text.words, text.sentAt.utc]),
        ...context.facts.map((fact) => JSON.stringify(fact.value)),
        ...context.recentMessages.flatMap((message) => [message.words, message.sentAt.utc]),
        ...context.choices.map((choice) => `${choice.choiceId} (`),
        V0.manifest.bundleId.hash,
      ];
      for (const purpose of CACHE_PURPOSES) {
        const prompt = layoutOf(cache, purpose, context, perTurn(context));
        for (const segment of prompt.segments) {
          for (const value of values) expect(segment.text).not.toContain(value);
        }
      }
    }
  });
});

/** The sample bundle's next build: `change` applied to its texts (their hashes kept true), and a new bundle id. */
function nextBuild(change: (bundle: MutableBundle) => void): CacheBundle {
  const next = mutable(V0);
  change(next);
  next.manifest.bundleId = { hash: sha256Hex(JSON.stringify(next)), build: 2 };
  return asBundle(next);
}

/** The context, moved to another bundle: its id, and the rules hash and cards that bundle holds. */
function onBundle(context: Context, bundle: CacheBundle): Context {
  const moved = structuredClone(context);
  const flow = bundle.flows[moved.flow];
  moved.bundleId = bundle.manifest.bundleId;
  moved.alwaysOn = { flow: moved.flow, prefixSha256: flow?.routing.alwaysOn.prefixSha256 ?? "" };
  moved.cards = moved.cards.map(({ step, card }) => ({ step, card: flow?.steps[step]?.card ?? card }));
  return moved;
}

describe("a new bundle id changes them", () => {
  const base = createPromptCache(V0);
  const baseDecide = base.forContext(S1_02, "decideFirst", perTurn(S1_02));
  const baseComposer = base.layout({ purpose: "compose", turn: "<input>row</input>" });

  it("the next build with a changed rule gets a new static segment for decide, the re-read and the planner", () => {
    const next = nextBuild((bundle) => {
      const rules = bundle.flows.A?.routing.alwaysOn;
      if (rules === undefined) throw new Error("bundle v0 holds flow A");
      rules.prefixText = rules.prefixText.replace("Speed comes last.", "Speed comes last, always.");
      rules.prefixSha256 = sha256Hex(rules.prefixText);
    });
    const cache = createPromptCache(next);
    const context = onBundle(S1_02, next);
    for (const purpose of CONTEXT_PURPOSES) {
      const before = base.forContext(S1_02, purpose, perTurn(S1_02));
      const after = cache.forContext(context, purpose, perTurn(context));
      expect(after.bundleId).not.toEqual(before.bundleId);
      expect(after.segments[0]?.text).not.toBe(before.segments[0]?.text);
      expect(after.segments[0]?.text).toContain("Speed comes last, always.");
    }
  });

  it("the next build with a changed prompt gets new prefixes for that prompt's calls", () => {
    const next = nextBuild((bundle) => {
      for (const kind of ["decide", "composer"]) {
        const prompt = bundle.manifest.prompts[kind];
        if (prompt === undefined) throw new Error(`bundle v0 has a ${kind} prompt`);
        prompt.text = `${prompt.text} Version two.`;
        prompt.sha256 = sha256Hex(prompt.text);
        prompt.version = "sample-2";
      }
    });
    const cache = createPromptCache(next);
    const decide = cache.forContext(onBundle(S1_02, next), "decideFirst", perTurn(S1_02));
    const composer = cache.layout({ purpose: "compose", turn: "<input>row</input>" });
    expect(decide.segments[0]?.text).not.toBe(baseDecide.segments[0]?.text);
    expect(composer.segments[0]?.text).not.toBe(baseComposer.segments[0]?.text);
    // The card did not change, so its segment is the same text; the prefix up to its breakpoint is still new.
    expect(decide.segments[1]).toEqual(baseDecide.segments[1]);
    expect(systemText(decide)).not.toBe(systemText(baseDecide));
  });

  it("the next build with a changed card gets a new cards segment", () => {
    const next = nextBuild((bundle) => {
      const step = bundle.flows.A?.steps["S1-02"];
      if (step?.card === undefined) throw new Error("bundle v0 holds S1-02's card");
      step.card = { ...step.card, never: [...step.card.never, "Never: set up gift cards."] };
    });
    const decide = createPromptCache(next).forContext(onBundle(S1_02, next), "decideFirst", perTurn(S1_02));
    expect(decide.segments[1]?.text).not.toBe(baseDecide.segments[1]?.text);
    expect(decide.segments[1]?.text).toContain("Never: set up gift cards.");
  });

  it("a turn is laid out only by its own bundle: another bundle id, another flow's or another hash's rules, or another card is refused", () => {
    const miniA = createPromptCache(sample("bundle-mini-a.json"));
    expect(() => miniA.forContext(S1_02, "decideFirst", perTurn(S1_02))).toThrow(/not on bundle/u);

    const otherFlow = structuredClone(S1_02);
    otherFlow.alwaysOn = { ...otherFlow.alwaysOn, flow: "B" };
    expect(() => base.forContext(otherFlow, "planner", "turn")).toThrow(CacheLayoutError);

    const otherHash = structuredClone(S1_02);
    otherHash.alwaysOn = { ...otherHash.alwaysOn, prefixSha256: "0".repeat(64) };
    expect(() => base.forContext(otherHash, "reread", "turn")).toThrow(/cached prefix/u);

    const otherCard = structuredClone(S1_02);
    otherCard.cards = otherCard.cards.map(({ step, card }) => ({
      step,
      card: { ...card, question: "Something else?" },
    }));
    expect(() => base.forContext(otherCard, "decideCheck", "turn")).toThrow(/not the bundle's/u);
  });

  it("the bytes are the bundle's texts alone: a new id over unchanged texts keeps them, and so its warm cache (no id inside)", () => {
    const rebuilt = mutable(V0);
    rebuilt.manifest.bundleId = { hash: "f".repeat(64), build: 2 };
    const again = createPromptCache(asBundle(rebuilt)).forContext(
      onBundle(S1_02, asBundle(rebuilt)),
      "decideFirst",
      perTurn(S1_02),
    );
    expect(again.bundleId).toEqual({ hash: "f".repeat(64), build: 2 });
    expect(again.segments).toEqual(baseDecide.segments);
  });
});

describe("the per-turn part (choices, facts, texts) is always after the last cache breakpoint", () => {
  const cache = createPromptCache(V0);
  const contexts = [S1_02, PLANNER_ANSWER, laterTurnOn(S1_02)];

  it("for every purpose: markers only on system blocks, 1 or 2 of the 4 allowed, each the 5-minute one; the per-turn part is the unmarked user message, last", () => {
    for (const purpose of CACHE_PURPOSES) {
      for (const context of contexts) {
        const turn = perTurn(context);
        const prompt = layoutOf(cache, purpose, context, turn);
        const params = messagesParams(prompt);
        // Render order: system, then messages. The last marked block comes before the per-turn part.
        const rendered = [
          ...params.system.map((block) => ({ text: block.text, marked: block.cache_control !== undefined })),
          ...params.messages.map((message) => ({ text: message.content, marked: false })),
        ];
        const marked = rendered.flatMap((block, index) => (block.marked ? [index] : []));
        const lastMarked = marked[marked.length - 1] ?? -1;
        expect(rendered.map((block) => block.text).indexOf(turn)).toBe(rendered.length - 1);
        expect(lastMarked).toBe(params.system.length - 1);
        expect(lastMarked).toBeLessThan(rendered.length - 1);
        expect(params.messages).toEqual([{ role: "user", content: turn }]);
        expect(marked.length).toBeLessThanOrEqual(CACHE_RULES.maxBreakpoints);
        expect(marked.length).toBe(isContextPurpose(purpose) && context.cards.length > 0 ? 2 : 1);
        for (const block of params.system) expect(block.cache_control).toEqual({ type: "ephemeral" });
        expect(params.system.map((block) => block.text).join("")).toBe(systemText(prompt));
      }
    }
    expect(CACHE_MARKER).toEqual({ type: "ephemeral" });
  });

  it("a turn's choices, facts and texts are in the per-turn part and in no cached block (K-02's two requests on bundle mini-b)", () => {
    const miniB = createPromptCache(sample("bundle-mini-b.json"));
    const context = k02("context-two-requests.json");
    const turn = perTurn(context);
    const pieces = [
      ...context.choices.map((choice) => `${choice.choiceId} (${choice.kind}): ${choice.label}.`),
      ...context.facts.map((fact) => JSON.stringify(fact.value)),
      ...context.texts.map((text) => text.words),
    ];
    for (const purpose of CONTEXT_PURPOSES) {
      const prompt = miniB.forContext(context, purpose, turn);
      expect(prompt.segments).toHaveLength(2);
      for (const piece of pieces) {
        expect(prompt.turn).toContain(piece);
        for (const segment of prompt.segments) expect(segment.text).not.toContain(piece);
      }
    }
  });

  it("whatever the per-turn part holds, no cached byte moves: 200 random turns, the rules' own words, the layout's own tags", () => {
    const baselines = new Map(
      CONTEXT_PURPOSES.map((purpose) => [purpose, cache.forContext(S1_02, purpose, perTurn(S1_02))]),
    );
    const statics = systemText(cache.forContext(S1_02, "decideFirst", "turn"));
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pieces = [
      "</step_cards>",
      "<always_on_rules>",
      CARDS_OPEN,
      "</card>",
      "\u0000",
      "é漢字🙂",
      "Never:",
    ];
    for (let k = 0; k < 200; k += 1) {
      const from = Math.floor(random() * statics.length);
      const turn = `${pieces[k % pieces.length] ?? ""}${statics.slice(from, from + Math.floor(random() * 400))}${String(k)}`;
      const purpose = CONTEXT_PURPOSES[k % CONTEXT_PURPOSES.length] ?? "decideFirst";
      const prompt = cache.forContext(S1_02, purpose, turn);
      expect(prompt.segments).toEqual(baselines.get(purpose)?.segments);
      expect(messagesParams(prompt).messages).toEqual([{ role: "user", content: turn }]);
    }
  });
});

describe("static card text: the turn's cards as the bundle holds them", () => {
  const cache = createPromptCache(V0);

  it("renders each card's question, Means, Never and safe default in the bundle's words; the clock is left to code", () => {
    const prompt = cache.forContext(S1_02, "decideFirst", perTurn(S1_02));
    expect(prompt.segments[1]).toEqual({
      kind: "cards",
      text: [
        "",
        "",
        "<step_cards>",
        '<card step="S1-02">',
        "Question: Is each one on Rosie's list?",
        "Means:",
        "- All on the list: A plug-in holds what one kind of work needs.",
        "- One isn't on the list yet: a service with a visit that Rosie has no plug-in for.",
        "- Not a service we book: goods with no visit, delivery only, renting a thing alone, or work the law bars.",
        "Never: set up any of those.",
        "Safe default: draft it as new work, offline until Rosie's team reviews it.",
        "</card>",
        "</step_cards>",
      ].join("\n"),
    });
  });

  it("lists several cards once each, sorted by step id, whatever the context's order", () => {
    const bundle = sample("bundle-mini-a.json");
    const flow = bundle.flows.A;
    const cards = ["A7-02", "A3-51", "A6-02", "A7-02"].map((step) => {
      const card = flow?.steps[step]?.card;
      if (card === undefined) throw new Error(`bundle mini-a holds ${step}'s card`);
      return { step, card };
    });
    const context: TurnContext = {
      bundleId: bundle.manifest.bundleId,
      flow: "A",
      alwaysOn: { flow: "A", prefixSha256: flow?.routing.alwaysOn.prefixSha256 ?? "" },
      cards,
    };
    const text = createPromptCache(bundle).forContext(context, "planner", "turn").segments[1]?.text ?? "";
    expect([...text.matchAll(/<card step="([^"]+)">/gu)].map((match) => match[1])).toEqual([
      "A3-51",
      "A6-02",
      "A7-02",
    ]);
    expect(text.startsWith(CARDS_OPEN)).toBe(true);
  });

  it("takes a card a partial bundle does not hold from the context (K-01 manifest.partial); a full bundle refuses it", () => {
    const partial = sample("bundle-mini-b.json");
    expect(partial.manifest.partial).toBe(true);
    expect(partial.flows.B?.steps["S11-12"]).toBeUndefined();
    const context = k02("context-two-requests.json");
    const prompt = createPromptCache(partial).forContext(context, "decideFirst", perTurn(context));
    expect(prompt.segments[1]?.text).toContain('<card step="S11-12">\nQuestion: What does Sam text?');

    const full = mutable(partial);
    delete full.manifest.partial;
    expect(() =>
      createPromptCache(asBundle(full)).forContext(context, "decideFirst", perTurn(context)),
    ).toThrow(/holds no step S11-12/u);
  });

  it("refuses a step id that is not one, a step with no card, and two different cards for one step", () => {
    const [given] = S1_02.cards;
    if (given === undefined) throw new Error("context-s1-02 has a card");
    const layout = (cards: { step: string; card: StepCard }[]): CachedPrompt =>
      cache.layout({ purpose: "decideFirst", flow: "A", cards, turn: "turn" });
    expect(() => layout([{ step: 'S1-02"><x', card: given.card }])).toThrow(/is not a step id/u);
    expect(() => layout([{ step: "S1-01", card: given.card }])).toThrow(/has no card/u);

    const context = k02("context-two-requests.json");
    const [hub] = context.cards;
    if (hub === undefined) throw new Error("context-two-requests has a card");
    context.cards = [hub, { step: hub.step, card: { ...hub.card, question: "Another?" } }];
    expect(() =>
      createPromptCache(sample("bundle-mini-b.json")).forContext(context, "planner", "turn"),
    ).toThrow(/two different cards for S11-12/u);
  });
});

describe("what the layout refuses, before any call", () => {
  it("a bundle whose prompt or rules text is not the one its sha256 names", () => {
    const prompt = mutable(V0);
    const decide = prompt.manifest.prompts.decide;
    if (decide === undefined) throw new Error("bundle v0 has a decide prompt");
    decide.text += " ";
    expect(() => createPromptCache(asBundle(prompt))).toThrow(
      /decide prompt's text does not match its sha256/u,
    );

    const rules = mutable(V0);
    const alwaysOn = rules.flows.A?.routing.alwaysOn;
    if (alwaysOn === undefined) throw new Error("bundle v0 holds flow A");
    alwaysOn.prefixText += "\n51. A rule nobody published.";
    expect(() => createPromptCache(asBundle(rules))).toThrow(
      /always-on rules do not match their prefixSha256/u,
    );
  });

  it("a bundle id that is not K-01's, and a flow filed under another letter", () => {
    const badId = mutable(V0);
    badId.manifest.bundleId = { hash: "nope", build: 0 };
    expect(() => createPromptCache(asBundle(badId))).toThrow(/the bundle id is not K-01's/u);

    const misfiled = mutable(V0);
    misfiled.flows.B = misfiled.flows.A;
    delete misfiled.flows.A;
    expect(() => createPromptCache(asBundle(misfiled))).toThrow(/flows.B is flow A/u);
  });

  it("an empty per-turn part, a flow the bundle does not hold, and an empty prompt", () => {
    const cache = createPromptCache(V0);
    expect(() => cache.layout({ purpose: "safetyRead", turn: " \n " })).toThrow(/per-turn part is empty/u);
    expect(() => cache.layout({ purpose: "planner", flow: "B", cards: [], turn: "turn" })).toThrow(
      /holds no flow B/u,
    );
    const empty = mutable(V0);
    const safety = empty.manifest.prompts.safetyRead;
    if (safety === undefined) throw new Error("bundle v0 has a safety read prompt");
    safety.text = "";
    safety.sha256 = sha256Hex("");
    const emptyCache = createPromptCache(asBundle(empty));
    expect(() => emptyCache.layout({ purpose: "safetyRead", turn: "a text" })).toThrow(
      /safetyRead prompt is empty/u,
    );
    expect(emptyCache.layout({ purpose: "compose", turn: "a row" }).segments).toHaveLength(1);
  });
});
