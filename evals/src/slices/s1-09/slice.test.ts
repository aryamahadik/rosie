// Tests of the S1-09 eval slice (T-1555 Gives 7), with no live call (build prompt 5.2: main's green never depends on a
// model): the slice's turn is S1-09 as bundle v3 holds it, laid out with decide-3 as bundle cut v3.1 will ship it, routed
// to Haiku twice on low stakes as staging read it; and its scoring calls a right answer right and each way the phone
// test could go wrong wrong, behind the real router, decide's one read, the AI gateway and the comparison, with a fake
// Messages API answering each read.

import { describe, expect, it } from "vitest";

import { createPromptCache, systemText } from "../../../../ai/src/cache";
import { buildContextPrompt } from "../../../../ai/src/context";
import { DECIDE_3_PROMPT, createDecider, type DecideRead } from "../../../../ai/src/decide";
import {
  ENV,
  REPO_ROOT,
  drawFrom,
  fakeTwoReadApi,
  twoStep,
  type Raw,
} from "../../../../ai/src/decide/test-support";
import { createRouter } from "../../../../ai/src/routing";
import {
  LISTING_TRY,
  OPEN_QUESTION,
  OWNER_BRANCH,
  OWNER_OPTION,
  S1_09_ITEMS,
  cacheBundleV31,
  readBundleV3,
  routingBundleV3,
  s1_09Context,
  scoreItem,
  type SliceItem,
} from "./slice";

const V3 = readBundleV3(REPO_ROOT);
const SEEDS: readonly number[] = [21, 22];

const itemOf = (id: string): SliceItem => {
  const item = S1_09_ITEMS.find((each) => each.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
};

/** A read of an item's turn: one part choosing `choice` with the business field's value and words. */
function readOf(
  item: SliceItem,
  words: string = item.details,
  value: unknown = words,
  choice = OWNER_OPTION,
): DecideRead {
  return {
    language: "en",
    parts: [
      {
        verb: "choose",
        quote: item.text,
        question: OPEN_QUESTION,
        choice,
        fields: [{ name: "business", value: value as string, words }],
      },
    ],
  };
}

/** An item's turn decided by two reads on bundle v3 with decide-3, the fake model answering each read from its read. */
async function decideItem(item: SliceItem, first: DecideRead, check: DecideRead = first) {
  const context = s1_09Context(V3, item);
  const route = createRouter(routingBundleV3(V3)).route(context, { draw: drawFrom(SEEDS) });
  const api = fakeTwoReadApi(route, {
    first: twoStep(first as unknown as Raw),
    check: twoStep(check as unknown as Raw),
  });
  const decider = createDecider({
    bundle: routingBundleV3(V3),
    prompts: createPromptCache(cacheBundleV31(V3)),
    env: ENV,
    fetch: api.fetch,
  });
  return decider.decide(context, { draw: drawFrom(SEEDS) });
}

describe("the S1-09 slice's items and turn", () => {
  it("holds the card's three forms: the runbook text in curly and straight apostrophes and a claim-first form, each with the name and town as typed", () => {
    expect(S1_09_ITEMS.map((item) => item.text)).toEqual([
      "Lee’s Barbershop in Springfield, I’m the owner",
      "Lee's Barbershop in Springfield, I'm the owner",
      "I’m the owner of Lee’s Barbershop in Springfield",
    ]);
    for (const item of S1_09_ITEMS) {
      expect(item.text).toContain(item.details);
      expect(item.details).not.toMatch(/owner/u);
    }
  });

  it("is S1-09 as bundle v3 compiles it: three options in the card's order with their Means lines, each listing business:id, then the door and the danger row", () => {
    const context = s1_09Context(V3, itemOf("s1-09-runbook-curly"));
    const options = context.choices.filter((choice) => choice.kind === "option");
    expect(options.map((choice) => [choice.choiceId, choice.label])).toEqual([
      ["c-01", OWNER_BRANCH],
      ["c-02", "Helps run it; not an owner"],
      ["c-03", "No match, or already listed"],
    ]);
    for (const option of options) {
      expect(option.fields).toEqual([{ name: "business", type: "id" }]);
      expect(option.question).toBe(OPEN_QUESTION);
      expect(option.stakes).toBe("low");
    }
    expect(options[0]?.definition).toBe(
      "they say they own it, in any words, and the listing matches what they sent.",
    );
    expect(context.choices.map((choice) => choice.kind)).toEqual([
      "option",
      "option",
      "option",
      "door",
      "anytime",
    ]);
    expect(context.openQuestions.map((question) => [question.step, question.askCount])).toEqual([
      ["S1-09", 1],
    ]);
    expect(context.cards.map((card) => card.step)).toEqual(["S1-09"]);
  });

  it("lays out on bundle cut v3.1 (bundle v3 with decide-3): decide-3 first in the cached prefix, S1-09's card in the turn's cards, the text as data", () => {
    const context = s1_09Context(V3, itemOf("s1-09-runbook-curly"));
    const built = buildContextPrompt(createPromptCache(cacheBundleV31(V3)), context, {
      purpose: "decideFirst",
      seed: 1,
    });
    expect(systemText(built.prompt).startsWith(DECIDE_3_PROMPT.text)).toBe(true);
    expect(systemText(built.prompt)).toContain("An owner, and does the listing match?");
    expect(built.prompt.turn).toContain("Lee’s Barbershop in Springfield, I’m the owner");
    expect(built.prompt.turn).toContain('fields="business:id"');
  });

  it("is routed as staging read it: low stakes, Haiku for both reads", () => {
    const route = createRouter(routingBundleV3(V3)).route(s1_09Context(V3, itemOf("s1-09-claim-first")), {
      draw: drawFrom(SEEDS),
    });
    expect(route.stakes).toBe("low");
    expect(route.reads.map((read) => read.model)).toEqual(["haiku", "haiku"]);
  });
});

describe("the S1-09 slice's scoring", () => {
  it.each(S1_09_ITEMS.map((item) => [item.id, item] as const))(
    "%s: both reads choosing c-01 with the name and town as typed is right, and the settler's first try finds the double's listing",
    async (_id, item) => {
      const score = scoreItem(item, await decideItem(item, readOf(item)));
      expect(score).toMatchObject({
        status: "decided",
        agreed: true,
        onePartGoes: true,
        ownerOption: true,
        wordsAsTyped: true,
        bothReadsWords: true,
        valueIsWords: true,
        limit6Passes: true,
        right: true,
        words: item.details,
        choice: OWNER_OPTION,
        settlerFirstTry: LISTING_TRY,
        settlerFindsListing: true,
      });
      // The fake's answers carry no usage, so the gateway prices them at zero; four calls: two steps, two reads.
      expect(score.calls).toBe(4);
    },
  );

  it("a model value that is a slug or 'name, town' is still right, because the backstop sets it to its words before the reads are compared", async () => {
    const item = itemOf("s1-09-runbook-curly");
    const score = scoreItem(
      item,
      await decideItem(
        item,
        readOf(item, item.details, "lees-barbershop-springfield"),
        readOf(item, item.details, "Lee's Barbershop, Springfield"),
      ),
    );
    expect(score.right).toBe(true);
    expect(score.valueIsWords).toBe(true);
  });

  it("the phone test's failures are wrong: reads that differ on the span, the whole quote as the words, the claim's option missed, or a name with no town", async () => {
    const item = itemOf("s1-09-runbook-curly");
    const differ = scoreItem(item, await decideItem(item, readOf(item), readOf(item, item.text)));
    expect(differ).toMatchObject({ agreed: false, onePartGoes: false, right: false });

    const wholeQuote = scoreItem(item, await decideItem(item, readOf(item, item.text)));
    expect(wholeQuote).toMatchObject({ agreed: true, wordsAsTyped: false, right: false });

    const noMatch = scoreItem(item, await decideItem(item, readOf(item, item.details, item.details, "c-03")));
    expect(noMatch).toMatchObject({ ownerOption: false, right: false, choice: "c-03" });

    const nameOnly = scoreItem(item, await decideItem(item, readOf(item, "Lee’s Barbershop")));
    expect(nameOnly).toMatchObject({ wordsAsTyped: false, right: false, settlerFirstTry: null });
  });
});
