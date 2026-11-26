// Tests of T-1555's backstop (DL-1214; K-09 README default 200): before a read leaves the AI layer, so before two reads
// are compared (agree.ts) and before any part reaches the gate, each id-typed field's value is set to its own words;
// every other type is unchanged. Proved on the pure function, then behind the real router, decide's one read, the AI
// gateway, the comparison and the one re-read, with a fake Messages API (no network, no key, no live call: J-02), and
// each value that goes held to limit 6's real id rule (actions/src/values/reparse.ts lines 343 to 345).
//
// The turn is S1-09 as bundle v3 compiles it (three options, each listing `business` of type id, in the card's order:
// c-01 "An owner; the listing matches", c-02 "Helps run it; not an owner", c-03 "No match, or already listed"), laid on
// the sample bundle-mini-a so the test-support decider can read it, with the runbook's text as an iPhone types it
// (DL-1213). Names are the master's sample cast (Sam Lee, Lee's Barbershop, Springfield), never a real business (rule 9).

import { describe, expect, it } from "vitest";

import { reparse } from "../../../actions/src/values/reparse";
import type { Choice, DecideContext } from "../context";
import {
  agreeReads,
  choicesById,
  idValuesAsWords,
  idValuesAsWordsInPart,
  readProblems,
  type DecidePart,
  type DecideRead,
  type DecideTurnAnswer,
  type DecideTurnDecided,
  type RereadAnswer,
  type RereadDecided,
} from "./index";
import {
  MINI_A,
  deciderFor,
  drawFrom,
  fakeTurnApi,
  routeOf,
  twoStep,
  type Raw,
  type TwoReadAnswers,
} from "./test-support";

const SEEDS: readonly number[] = [11, 12];
const REREAD_SEED = 13;

const RUNBOOK = "Lee’s Barbershop in Springfield, I’m the owner";
const DETAILS = "Lee’s Barbershop in Springfield";
const LIMIT6_CONTEXT = { sentAt: "2026-11-23T19:10:00Z", zones: ["America/New_York"] };

const TARGET = {
  businessId: "biz-lees-barbershop",
  businessName: "Lee's Barbershop",
  bookingId: null,
  visitAt: null,
} as const;

/** One option of S1-09's open question, listing `business` (id), its label the branch word for word. */
function s1_09Option(choiceId: string, label: string, definition: string): Choice {
  return {
    choiceId,
    kind: "option",
    label,
    definition,
    step: "S1-09",
    question: "oq-s1-09",
    branch: label,
    anytimeRow: null,
    door: null,
    hub: null,
    target: TARGET,
    fields: [{ name: "business", type: "id" }],
    stakes: "low",
    stakesFrom: [],
  };
}

/** A door whose one field is text: an id rule must leave it alone. */
const TEXT_DOOR: Choice = {
  choiceId: "c-04",
  kind: "door",
  label: "An unclear owner text or HELP",
  definition: "Nothing changes on a text Rosie can't act on for sure.",
  step: "S11-21",
  question: null,
  branch: null,
  anytimeRow: null,
  door: "unclearOwnerOrHelp",
  hub: null,
  target: TARGET,
  fields: [{ name: "note", type: "text" }],
  stakes: "low",
  stakesFrom: [],
};

/** S1-09's turn with `words` as its one text, on bundle-mini-a's flow A. */
function s1_09Context(words: string = RUNBOOK): DecideContext {
  const flow = MINI_A.flows.A;
  if (flow === undefined) throw new Error("bundle-mini-a holds flow A");
  return {
    turnId: "turn-s1-09-sam-details",
    bundleId: MINI_A.manifest.bundleId,
    flow: "A",
    texts: [
      {
        eventId: "evt-sam-0109",
        kind: "text",
        words,
        sentAt: { utc: "2026-11-23T19:10:00Z", zone: "America/New_York" },
        attachments: [],
        poll: null,
        tapback: null,
      },
    ],
    writer: {
      handle: "+15555550100",
      people: [
        {
          personId: "person-sam",
          name: "Sam Lee",
          roles: [{ role: "owner", businessId: TARGET.businessId }],
          language: "en",
        },
      ],
    },
    businessLanguage: "en",
    openQuestions: [
      {
        openQuestionId: "oq-s1-09",
        step: "S1-09",
        target: TARGET,
        sentAt: { utc: "2026-11-23T19:09:06Z", zone: "America/New_York" },
        pollId: null,
        askCount: 1,
      },
    ],
    choices: [
      s1_09Option(
        "c-01",
        "An owner; the listing matches",
        "they say they own it, in any words, and the listing matches what they sent.",
      ),
      s1_09Option("c-02", "Helps run it; not an owner", "a manager, family member or assistant."),
      s1_09Option(
        "c-03",
        "No match, or already listed",
        "the listing shows another name or address, or the business is already on Rosie.",
      ),
      TEXT_DOOR,
    ],
    cards: [],
    facts: [],
    alwaysOn: { flow: "A", prefixSha256: flow.routing.alwaysOn.prefixSha256 },
    recentMessages: [],
    meaningSearch: null,
  };
}

/** A read of S1-09's turn: one part choosing `choice` with the business field's value and words. */
function readOf(value: unknown, words: string = DETAILS, choice = "c-01", quote = RUNBOOK): DecideRead {
  return {
    language: "en",
    parts: [
      {
        verb: "choose",
        quote,
        question: "oq-s1-09",
        choice,
        fields: [{ name: "business", value: value as string, words }],
      },
    ],
  };
}

const businessOf = (part: DecidePart | undefined): { value: unknown; words: string } => {
  if (part?.verb !== "choose") throw new Error("the part chooses");
  const field = part.fields.find((each) => each.name === "business");
  if (field === undefined) throw new Error("the part gives the business field");
  return { value: field.value, words: field.words };
};

/** The values a read's model might write in place of the words, each failing limit 6's id rule as written. */
const WRONG_VALUES: readonly (readonly [string, unknown])[] = [
  ["a slug", "lees-barbershop-springfield"],
  ["name, town", "Lee's Barbershop, Springfield"],
  ["a state added", "Lee's Barbershop in Springfield, IL"],
  ["a company suffix", "Lee's Barbershop LLC"],
  ["the whole quote", RUNBOOK],
  ["a number", 109],
];

describe("idValuesAsWords: an id-typed field's value is its own words; nothing else changes", () => {
  it.each(WRONG_VALUES)(
    "%s as an id value becomes the field's words, which pass limit 6's id rule where the value failed it",
    (_what, wrong) => {
      const context = s1_09Context();
      const read = readOf(wrong);
      if (typeof wrong === "string")
        expect(reparse("id", wrong, DETAILS, LIMIT6_CONTEXT).ok, "the model's value fails limit 6").toBe(
          false,
        );
      const fixed = idValuesAsWords(context, read);
      expect(businessOf(fixed.parts[0])).toEqual({ value: DETAILS, words: DETAILS });
      expect(reparse("id", businessOf(fixed.parts[0]).value as string, DETAILS, LIMIT6_CONTEXT)).toEqual({
        ok: true,
      });
      // The read it came from is not changed, and the fixed read is a K-02 read of the turn.
      expect(businessOf(read.parts[0]).value).toBe(wrong);
      expect(readProblems(context, fixed)).toEqual([]);
    },
  );

  it("changes nothing but the value: the quote, the verb, the question, the choice, the field's name and words stand", () => {
    const fixed = idValuesAsWords(s1_09Context(), readOf("lees-barbershop-springfield"));
    expect(fixed).toEqual(readOf(DETAILS));
  });

  it("gives back the same read when every id value is already its words, or a part carries no id field", () => {
    const context = s1_09Context();
    const already = readOf(DETAILS);
    expect(idValuesAsWords(context, already)).toBe(already);
    const noField: DecideRead = {
      language: "en",
      parts: [{ verb: "choose", quote: RUNBOOK, question: "oq-s1-09", choice: "c-01", fields: [] }],
    };
    expect(idValuesAsWords(context, noField)).toBe(noField);
  });

  it("leaves a text field's value as the model gave it, and every verb that carries no field", () => {
    const context = s1_09Context("please note: back door after 5");
    const text: DecideRead = {
      language: "en",
      parts: [
        {
          verb: "enter",
          quote: "please note: back door after 5",
          choice: "c-04",
          fields: [{ name: "note", value: "Back door after five", words: "back door after 5" }],
        },
        { verb: "no_op", quote: "please note" },
      ],
    };
    expect(idValuesAsWords(context, text)).toBe(text);
    const ask: DecidePart = {
      verb: "ask",
      quote: RUNBOOK,
      questions: ["oq-s1-09"],
      unclear: "Which option?",
    };
    const choices = choicesById(s1_09Context());
    expect(idValuesAsWordsInPart(choices, ask)).toBe(ask);
  });

  it("sets an id field's value on an enter part too, and leaves a part whose choice the context does not offer for the named rules to refuse", () => {
    const context = s1_09Context();
    const choices = choicesById({
      ...context,
      choices: [{ ...TEXT_DOOR, fields: [{ name: "business", type: "id" }] }],
    });
    const enter: DecidePart = {
      verb: "enter",
      quote: RUNBOOK,
      choice: "c-04",
      fields: [{ name: "business", value: "lees-barbershop", words: DETAILS }],
    };
    expect(idValuesAsWordsInPart(choices, enter)).toEqual({
      ...enter,
      fields: [{ name: "business", value: DETAILS, words: DETAILS }],
    });
    const unknown = readOf("lees-barbershop", DETAILS, "c-99");
    expect(idValuesAsWords(context, unknown)).toBe(unknown);
  });

  it("two reads whose id values differ but whose words are the same agree once each is set to its words; on the model's values they did not", () => {
    const context = s1_09Context();
    const first = readOf("lees-barbershop-springfield");
    const check = readOf("Lee's Barbershop, Springfield");
    expect(agreeReads(first, check, "low").parts[0]?.differences).toEqual(["value"]);
    const agreed = agreeReads(idValuesAsWords(context, first), idValuesAsWords(context, check), "low");
    expect(agreed.agreed).toBe(true);
    expect(agreed.parts[0]?.differences).toEqual([]);
  });
});

// ---- Behind the real router, decide's one read, the gateway, the comparison and the re-read ------------------------------

const stepsOf = (read: DecideRead): TwoReadAnswers["first"] => twoStep(read as unknown as Raw);

function decided(answer: DecideTurnAnswer): DecideTurnDecided {
  if (answer.status !== "decided") throw new Error(`the turn is ${answer.status}, not decided`);
  return answer;
}

function rereadDecided(answer: RereadAnswer): RereadDecided {
  if (answer.status !== "decided") throw new Error(`the re-read is ${answer.status}, not decided`);
  return answer;
}

/** S1-09's turn decided by two reads, the model answering each from its read; the decider and its fake for the re-read. */
async function decideS1_09(first: DecideRead, check: DecideRead) {
  const context = s1_09Context();
  const api = fakeTurnApi(routeOf(context, SEEDS), { first: stepsOf(first), check: stepsOf(check) });
  const decider = deciderFor(context, api.fetch);
  const answer = decided(await decider.decide(context, { draw: drawFrom(SEEDS) }));
  return { context, api, decider, answer };
}

describe("the backstop in decide's reads: an id value is compared and gated as its words", () => {
  it("a read whose id value is a slug and a read whose value is 'name, town', both quoting the name and town, agree, and the part that goes carries value = words, which limit 6's id rule passes", async () => {
    const { answer } = await decideS1_09(
      readOf("lees-barbershop-springfield"),
      readOf("Lee's Barbershop, Springfield"),
    );
    expect(answer.agreement.agreed).toBe(true);
    expect(answer.result.agreed).toBe(true);
    expect(answer.result.parts.map((part) => part.outcome)).toEqual(["go"]);
    const going = businessOf(answer.result.parts[0]?.part);
    expect(going).toEqual({ value: DETAILS, words: DETAILS });
    expect(reparse("id", going.value as string, going.words, LIMIT6_CONTEXT)).toEqual({ ok: true });
    // Both reads the result holds carry the words as the value: what the gate re-checks is what was compared.
    for (const read of answer.result.reads) expect(businessOf(read.output.parts[0])).toEqual(going);
  });

  it("the runbook text typed with straight apostrophes: the same, with the straight words as the value", async () => {
    const straight = "Lee's Barbershop in Springfield";
    const quote = "Lee's Barbershop in Springfield, I'm the owner";
    const context = s1_09Context(quote);
    const first = readOf("lees_barbershop_springfield", straight, "c-01", quote);
    const check = readOf("Lee's Barbershop (Springfield)", straight, "c-01", quote);
    const api = fakeTurnApi(routeOf(context, SEEDS), { first: stepsOf(first), check: stepsOf(check) });
    const answer = decided(await deciderFor(context, api.fetch).decide(context, { draw: drawFrom(SEEDS) }));
    expect(answer.result.parts.map((part) => part.outcome)).toEqual(["go"]);
    expect(businessOf(answer.result.parts[0]?.part)).toEqual({ value: straight, words: straight });
    expect(reparse("id", straight, straight, LIMIT6_CONTEXT)).toEqual({ ok: true });
  });

  it("does not hide a difference in the words: two reads that quote different spans still differ on the value, so the span is the prompt's rule (decide-3's span line)", async () => {
    const { answer } = await decideS1_09(readOf(DETAILS), readOf(RUNBOOK, RUNBOOK));
    expect(answer.agreement.agreed).toBe(false);
    expect(answer.agreement.parts[0]?.differences).toEqual(["value"]);
    expect(answer.result.parts.map((part) => part.outcome)).toEqual(["oneQuestion"]);
  });

  it("the one re-read is set the same way: after reads that differ on the span, a re-read with a slug value and the first read's words settles the part with value = words", async () => {
    const run = await decideS1_09(readOf(DETAILS), readOf(RUNBOOK, RUNBOOK));
    run.api.rereadWith(stepsOf(readOf("lees-barbershop-springfield")));
    const reread = rereadDecided(
      await run.decider.reread(
        { why: "disagreed", context: run.context, decide: run.answer.result, failing: [] },
        { draw: drawFrom([REREAD_SEED]) },
      ),
    );
    expect(reread.settlement.map((part) => part.settlement)).toEqual(["settled"]);
    expect(reread.result.parts.map((part) => part.outcome)).toEqual(["go"]);
    expect(businessOf(reread.result.parts[0]?.part)).toEqual({ value: DETAILS, words: DETAILS });
  });
});
