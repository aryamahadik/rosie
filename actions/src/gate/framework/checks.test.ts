// T-298: decide's output checked before any limit runs: each part's verb, its quote word for word in the turn's texts, its
// option offered and every value with its source words (arch 03 line 185; arch 06 line 333; K-02 v1's named rules).
// Each refused case changes one thing of an accepted pair from the contracts' fixtures, and nothing a check returns holds
// a quote's or a value's words.

import { describe, expect, it } from "vitest";

import { checkDecideOutput, findDecideProblems, type DecideProblem } from "./checks";
import {
  DECIDED_GATE_FIXTURES,
  bareTwo,
  becomes,
  changePart,
  copy,
  decidedOf,
  gateExchange,
  modelFixture,
  samKinds,
  twoRequests,
  withRead,
  wordsIn,
  type DecideRead,
} from "./test-support";
import type { Choice, DecidePart, Decided } from "./types";

/** Words of three characters or more: a shorter one ("2") cannot be told from a part's index in a line of JSON. */
function expectNoWords(decided: Decided, value: unknown): void {
  const line = JSON.stringify(value);
  for (const words of wordsIn(decided).filter((each) => each.length >= 3)) {
    expect(line.includes(words), `holds the words "${words}"`).toBe(false);
  }
}

/** The one problem a refused pair has at part `part`, in decide.parts and in every read. */
function onlyProblem(decided: Decided, part: number): Pick<DecideProblem, "check" | "why"> {
  const problems = findDecideProblems(decided);
  expect(problems.length).toBeGreaterThan(0);
  const kinds = new Set(problems.map((problem) => `${String(problem.part)} ${problem.check} ${problem.why}`));
  expect(kinds.size).toBe(1);
  const [first] = problems;
  if (first === undefined) throw new Error("no problem");
  expect(first.part).toBe(part);
  expectNoWords(decided, problems);
  return { check: first.check, why: first.why };
}

/** Part 1 of Sam's two requests (the settings change), changed in decide.parts and every read alike. */
function samsSecondPart(change: (part: DecidePart) => void): Decided {
  return changePart(twoRequests(), 1, change);
}

function asChoose(part: DecidePart): Extract<DecidePart, { verb: "choose" }> {
  if (part.verb !== "choose") throw new Error("not a choose");
  return part;
}

const refusedRead = (file: string): DecideRead => modelFixture(`invalid/${file}`) as DecideRead;

describe("decide's output that holds is accepted", () => {
  const accepted: [string, Decided][] = [
    ["context-s1-02 with decide-s1-02-choose", samKinds()],
    ["context-two-requests with decide-two-requests", twoRequests()],
    ["Alex's bare '2' (decide-bare-2)", bareTwo()],
    ...DECIDED_GATE_FIXTURES.map((file): [string, Decided] => [file, decidedOf(gateExchange(file))]),
  ];
  it.each(accepted)("%s passes every check", (_name, decided) => {
    expect(findDecideProblems(decided)).toEqual([]);
    expect(checkDecideOutput(decided)).toBeNull();
  });
});

describe("K-02 v1's refused fixtures are refused, each for its one fault", () => {
  it("refuse-option-not-offered.json: optionOffered, the choice c-99 is not offered", () => {
    const decided = modelFixture("invalid/refuse-option-not-offered.json") as Decided;
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [0] });
    expect(onlyProblem(decided, 0)).toEqual({ check: "option", why: "notOffered" });
    const fixed = changePart(decided, 0, (part) => {
      asChoose(part).choice = "c-01";
    });
    expect(checkDecideOutput(fixed)).toBeNull();
  });

  it("refuse-quote-not-in-text.json: quoteInText, the quote is not in Sam's text", () => {
    const decided = modelFixture("invalid/refuse-quote-not-in-text.json") as Decided;
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [0] });
    expect(onlyProblem(decided, 0)).toEqual({ check: "quote", why: "quoteNotInText" });
    const fixed = changePart(decided, 0, (part) => {
      part.quote = "Barbershop, plumbing, electrical";
    });
    expect(checkDecideOutput(fixed)).toBeNull();
  });

  it("refuse-unknown-verb.json: the verb book is none of the eight", () => {
    const decided = withRead(bareTwo(), refusedRead("refuse-unknown-verb.json"));
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [0] });
    expect(onlyProblem(decided, 0)).toEqual({ check: "verb", why: "unknownVerb" });
    const fixed = changePart(decided, 0, (part) => {
      (part as { verb: string }).verb = "choose";
    });
    expect(checkDecideOutput(fixed)).toBeNull();
  });

  it("refuse-value-without-words.json: a value whose words are empty", () => {
    const decided = withRead(bareTwo(), refusedRead("refuse-value-without-words.json"));
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [0] });
    expect(onlyProblem(decided, 0)).toEqual({ check: "valueWords", why: "noWords" });
    const fixed = changePart(decided, 0, (part) => {
      for (const field of asChoose(part).fields) field.words = "2";
    });
    expect(checkDecideOutput(fixed)).toBeNull();
  });
});

describe("the quote is exact: word for word in one of the turn's texts", () => {
  it.each([
    ["a quote not in the text", "tile is $12 per foot", "quoteNotInText"],
    ["a quote in another case", "Tile is $12 a foot from now on", "quoteNotInText"],
    ["a quote running past the text", "tile is $12 a foot from now on, ok", "quoteNotInText"],
    ["an empty quote", "", "noQuote"],
    ["a quote of spaces", "   ", "noQuote"],
  ])("%s is refused (quoteInText)", (_name, quote, why) => {
    const decided = samsSecondPart((part) => {
      part.quote = quote;
    });
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [1] });
    expect(onlyProblem(decided, 1)).toEqual({ check: "quote", why });
  });

  it("pass_on's and redact's words are found in the text too", () => {
    for (const verb of ["pass_on", "redact"] as const) {
      const turn = (words: string): Decided =>
        changePart(twoRequests(), 1, (part) => {
          becomes(part, { verb, quote: "tile is $12 a foot from now on", words });
        });
      expect(checkDecideOutput(turn("tile is $12 a foot"))).toBeNull();
      const refused = turn("tile is $14 a foot");
      expect(checkDecideOutput(refused)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [1] });
      expect(onlyProblem(refused, 1)).toEqual({ check: "quote", why: "wordsNotInText" });
    }
  });
});

describe("the option was offered", () => {
  it.each<[string, (part: DecidePart) => void, string]>([
    [
      "a choice the context does not hold",
      (part) => {
        asChoose(part).choice = "c-99";
      },
      "notOffered",
    ],
    [
      "choose naming another question than its choice's",
      (part) => {
        asChoose(part).question = "S11-13";
      },
      "wrongQuestion",
    ],
    [
      "a field the choice does not carry",
      (part) => {
        const [, price] = asChoose(part).fields;
        if (price !== undefined) price.name = "deposit";
      },
      "fieldNotCarried",
    ],
    [
      "enter on a hub case, which only choose takes",
      (part) => {
        const { quote, choice, fields } = asChoose(part);
        becomes(part, { verb: "enter", quote, choice, fields });
      },
      "wrongKind",
    ],
  ])("%s is refused (optionOffered)", (_name, change, why) => {
    const decided = samsSecondPart(change);
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [1] });
    expect(onlyProblem(decided, 1)).toEqual({ check: "option", why });
  });

  it("a choice whose id the context offers twice is refused: which one is meant is not known", () => {
    const decided = twoRequests();
    const second = decided.context.choices[3];
    if (second === undefined) throw new Error("no fourth choice");
    decided.context.choices.push({ ...copy(second), label: "A change to the settings again" });
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [1] });
    expect(onlyProblem(decided, 1)).toEqual({ check: "option", why: "offeredTwice" });
  });

  it("an open question's option is offered only while its question is open to this handle", () => {
    const decided = samKinds();
    decided.context.openQuestions = [];
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [0] });
    expect(onlyProblem(decided, 0)).toEqual({ check: "option", why: "questionNotOpen" });
  });

  it("ask names only questions an offered choice answers", () => {
    const ask = (questions: string[]): Decided =>
      samsSecondPart((part) => {
        becomes(part, { verb: "ask", quote: part.quote, questions, unclear: "Which setting?" });
      });
    expect(checkDecideOutput(ask(["S11-12"]))).toBeNull();
    const refused = ask(["S11-12", "oq-a6-02"]);
    expect(checkDecideOutput(refused)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [1] });
    expect(onlyProblem(refused, 1)).toEqual({ check: "option", why: "askNotOffered" });
  });
});

describe("every value has its source words", () => {
  it.each([
    ["empty words", "", "noWords"],
    ["words of spaces", "  ", "noWords"],
    ["words not in the text", "$12 per foot", "valueNotInText"],
  ])("a value with %s is refused (quoteInText)", (_name, words, why) => {
    const decided = samsSecondPart((part) => {
      const [, price] = asChoose(part).fields;
      if (price !== undefined) price.words = words;
    });
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [1] });
    expect(onlyProblem(decided, 1)).toEqual({ check: "valueWords", why });
  });
});

describe("the quote and the words stand whole in a text, at word edges (T-304 round 2, DL-184)", () => {
  /** Alex's bare "2" (decide-bare-2) with his text's words `words` and part 0's quote `quote`. */
  function bareTwoSaying(words: string, quote: string): Decided {
    const decided = changePart(bareTwo(), 0, (part) => {
      part.quote = quote;
    });
    decided.context.texts[0].words = words;
    return decided;
  }

  it.each([
    ["'yes' cut out of 'yesterday'", "2, like yesterday", "yes", "yesterday"],
    ["'no' cut out of 'know'", "2, you know", "no", "know"],
  ])("a quote %s is refused (quoteNotInText); the whole word is a quote", (_name, words, cut, whole) => {
    expect(words.includes(cut)).toBe(true);
    const refused = bareTwoSaying(words, cut);
    expect(checkDecideOutput(refused)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [0] });
    expect(onlyProblem(refused, 0)).toEqual({ check: "quote", why: "quoteNotInText" });
    expect(checkDecideOutput(bareTwoSaying(words, whole))).toBeNull();
    expect(checkDecideOutput(bareTwoSaying(words, words))).toBeNull();
  });

  it("a value's words cut out of a longer number are refused (valueNotInText): '$1' out of Sam's '$12'", () => {
    const decided = samsSecondPart((part) => {
      const [, price] = asChoose(part).fields;
      if (price !== undefined) price.words = "$1";
    });
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [1] });
    expect(onlyProblem(decided, 1)).toEqual({ check: "valueWords", why: "valueNotInText" });
  });

  it("pass_on's and redact's words cut out of a longer number are refused (wordsNotInText)", () => {
    for (const verb of ["pass_on", "redact"] as const) {
      const refused = changePart(twoRequests(), 1, (part) => {
        becomes(part, { verb, quote: "tile is $12 a foot from now on", words: "tile is $1" });
      });
      expect(checkDecideOutput(refused)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [1] });
      expect(onlyProblem(refused, 1)).toEqual({ check: "quote", why: "wordsNotInText" });
    }
  });
});

describe("the edges are judged on the folded text the readers read (T-304 round 3, DL-189)", () => {
  const ZERO_WIDTH_SPACE = "​";

  /** Alex's bare "2" (decide-bare-2) with his text's words `words` and part 0's quote `quote`. */
  function saying(words: string, quote: string): Decided {
    const decided = changePart(bareTwo(), 0, (part) => {
      part.quote = quote;
    });
    decided.context.texts[0].words = words;
    return decided;
  }

  it.each([
    ["'I can' out of 'I can´t make it'", "2, I can´t make it", "I can", "I can´t make it"],
    ["'no' out of 'no.reply@example.com'", "2, no.reply@example.com", "no", "no.reply@example.com"],
    [
      "'40' out of '1​40' (a zero-width space inside)",
      `2, raise it to 1${ZERO_WIDTH_SPACE}40`,
      "40",
      `1${ZERO_WIDTH_SPACE}40`,
    ],
    ["'$1' out of '$1，200'", "2, raise it to $1，200", "$1", "$1，200"],
    [
      "'tomorrow at 10' out of 'tomorrow at 10：30'",
      "2, tomorrow at 10：30",
      "tomorrow at 10",
      "tomorrow at 10：30",
    ],
    ["'$12' out of '$12．50'", "2, $12．50 a foot", "$12", "$12．50"],
    ["'9' out of 'table for 9：30 tomorrow'", "2, table for 9：30 tomorrow", "9", "table for 9：30"],
  ])("a quote %s is refused (quoteNotInText); the whole is a quote", (_name, words, cut, whole) => {
    expect(words.includes(cut)).toBe(true);
    const refused = saying(words, cut);
    expect(checkDecideOutput(refused)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [0] });
    expect(onlyProblem(refused, 0)).toEqual({ check: "quote", why: "quoteNotInText" });
    expect(checkDecideOutput(saying(words, whole))).toBeNull();
    expect(checkDecideOutput(saying(words, words))).toBeNull();
  });

  it("a value's words cut out of a number behind a fullwidth mark are refused (valueNotInText): '$12' of '$12．50'", () => {
    const text = "block thursday afternoon and also tile is $12．50 a foot from now on";
    const decided = samsSecondPart((part) => {
      part.quote = "tile is $12．50 a foot from now on";
      const [, price] = asChoose(part).fields;
      if (price !== undefined) price.words = "$12";
    });
    decided.context.texts[0].words = text;
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "quoteInText", parts: [1] });
    expect(onlyProblem(decided, 1)).toEqual({ check: "valueWords", why: "valueNotInText" });
  });
});

describe("the order of the checks and what is refused", () => {
  it("a part takes its verb, quote, option and value words in that order: its first failing check is its problem", () => {
    const quoteAndOption = samsSecondPart((part) => {
      part.quote = "tile is $14 a foot";
      asChoose(part).choice = "c-99";
    });
    expect(onlyProblem(quoteAndOption, 1)).toEqual({ check: "quote", why: "quoteNotInText" });
    const optionAndWords = samsSecondPart((part) => {
      const choose = asChoose(part);
      choose.choice = "c-99";
      for (const field of choose.fields) field.words = "";
    });
    expect(onlyProblem(optionAndWords, 1)).toEqual({ check: "option", why: "notOffered" });
  });

  it("names every part that breaks the first problem's rule", () => {
    const decided = changePart(
      changePart(twoRequests(), 0, (part) => {
        asChoose(part).choice = "c-98";
      }),
      1,
      (part) => {
        asChoose(part).choice = "c-99";
      },
    );
    expect(checkDecideOutput(decided)).toEqual({
      error: "decideRefused",
      rule: "optionOffered",
      parts: [0, 1],
    });
  });

  it("answers the rule of the first part that fails, naming only the parts that break it", () => {
    const decided = changePart(
      changePart(twoRequests(), 0, (part) => {
        asChoose(part).choice = "c-98";
      }),
      1,
      (part) => {
        part.quote = "tile is $14 a foot";
      },
    );
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [0] });
  });

  it("holds each read's parts as the named rules do, not only the parts handed to the gate", () => {
    const decided = twoRequests();
    const checkRead = decided.decide.reads[1].output.parts[1];
    if (checkRead === undefined) throw new Error("no second part");
    asChoose(checkRead).choice = "c-99";
    const problems = findDecideProblems(decided);
    expect(problems).toEqual([{ from: "read", read: 1, part: 1, check: "option", why: "notOffered" }]);
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [1] });
  });

  it("checks a choice only against the context's own choices", () => {
    const decided = twoRequests();
    const offered: Choice[] = decided.context.choices.filter((choice) => choice.choiceId !== "c-04");
    const [first, ...rest] = offered;
    if (first === undefined) throw new Error("no choice");
    decided.context.choices = [first, ...rest];
    expect(checkDecideOutput(decided)).toEqual({ error: "decideRefused", rule: "optionOffered", parts: [1] });
  });
});
