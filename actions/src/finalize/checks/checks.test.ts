// Tests of the message checks (T-312, C-092; arch 07 lines 405 to 417): each K-03 v1 check-* fixture gives its stated
// result, then one block per check, each failing and passing on its own. The bundle lists the checks read are K-01 v1's
// samples: keywords.json (msgtext.js's 16 opt-out words, line 29) and fixed-lines.json. Names and values are the
// master's sample cast (SPEC-master section 6; rule 9).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { checksWithoutValues } from "../rewrite/told";
import { filledOf, markOut, withoutInserted } from "./reading";
import { markOutIn, readingOf, withoutInsertedIn } from "./values";
import {
  BLOCKING_CHECKS,
  CHECK_NAMES,
  fixedLinesFaults,
  formatFaults,
  lengthAndReadingFaults,
  neverInMessageFaults,
  oneQuestionFaults,
  runMessageChecks,
  shapeFaults,
  valuesFaults,
  type CheckContext,
  type CheckLists,
  type CheckOutcome,
  type FinalParts,
  type Option,
  type Send,
  type SlotValue,
} from "./index";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

const PLAN = "contracts/message-plan";

/** The bundle's shared lists (K-01 v1 `sharedLists`), as the sample bundle's fixtures hold them. */
const LISTS: CheckLists = {
  keywords: readJson("contracts/bundle/fixtures/keywords.json") as CheckLists["keywords"],
  fixedLines: readJson("contracts/bundle/fixtures/fixed-lines.json") as CheckLists["fixedLines"],
};

/** A check-* fixture: a K-03 v1 `checkResult`. */
interface CheckResultFixture {
  readonly row: string;
  readonly attempt: "composed" | "rewrite" | "fallback";
  readonly checked: FinalParts;
  readonly checks: readonly CheckOutcome[];
  readonly outcome: string;
  readonly questionWithdrawn: boolean;
  readonly teamPaged: boolean;
}

interface IndexEntry {
  readonly file: string;
  readonly expect: string;
  readonly shows: string;
}

const checkEntries = (readJson(`${PLAN}/fixtures/index.json`) as { fixtures: IndexEntry[] }).fixtures.filter(
  (entry) => entry.expect === "accept" && entry.file.startsWith("check-"),
);
const fixture = (file: string): CheckResultFixture =>
  readJson(`${PLAN}/fixtures/${file}`) as CheckResultFixture;
const finalTwoSends = readJson(`${PLAN}/fixtures/final-two-sends.json`) as FinalParts;

// One validator for K-03's documents, set up as the contract tests set it up (strict Ajv 2020-12).
const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const folder of ["contracts/common", "contracts/bundle", PLAN]) {
  for (const name of readdirSync(path.join(REPO_ROOT, folder))) {
    if (name.endsWith(".schema.json")) ajv.addSchema(readJson(`${folder}/${name}`) as object);
  }
}
const planSchema = readJson(`${PLAN}/message-plan.v1.schema.json`) as {
  $id: string;
  $defs: { checkName: { enum: string[] } };
};
const validateCheckResult = ajv.getSchema(`${planSchema.$id}#/$defs/checkResult`);

/**
 * The context of a row like the fixtures' (K-03 composeInput): iMessage in an open chat, so every format is allowed;
 * English; Lee's Barbershop; the step's options are the ones its poll carries; nothing typed; no facts beyond the slot
 * values, none of Rosie's own terms, no reader's name and no master line, so every value must be a slot value.
 */
function contextFor(parts: FinalParts, change: Partial<CheckContext> = {}): CheckContext {
  return {
    lists: LISTS,
    language: "en",
    businessName: "Lee's Barbershop",
    options: parts.sends.flatMap((send) => send.options),
    typedOptions: null,
    allowedFormats: ["text", "poll", "linkCard", "calendarFile", "tapback"],
    facts: [],
    terms: [],
    readerName: null,
    masterText: null,
    ...change,
  };
}

const wordsSend = (text: string): Send => ({
  kind: "words",
  text,
  calendarFile: "none",
  options: [],
  link: null,
});
const pollSend = (labels: readonly string[]): Send => ({
  kind: "poll",
  text: null,
  calendarFile: "none",
  options: labels.map((label, i) => ({ id: `A7-17/${String(i + 1)}`, label })),
  link: null,
});
const TAPBACK: Send = { kind: "tapback", text: null, calendarFile: "none", options: [], link: null };

function partsOf(
  sends: readonly Send[],
  slotValues: readonly SlotValue[] = [],
  fixedLines: readonly string[] = [],
): FinalParts {
  return {
    row: "outbox-a7-17-alex-text",
    channel: "imessage",
    sends,
    fixedLines,
    slotValues,
    threadReplyTo: null,
  };
}
/** One text alone, with its slot values. */
const textOf = (text: string, slotValues: readonly SlotValue[] = []): FinalParts =>
  partsOf([wordsSend(text)], slotValues);
/** The same parts with other words in the words send. */
const withWords = (parts: FinalParts, text: string): FinalParts => ({
  ...parts,
  sends: parts.sends.map((send) => (send.kind === "words" ? { ...send, text } : send)),
});
/** final-two-sends' words: A6-14's confirmation, six lines with every slot filled. */
const confirmation = finalTwoSends.sends.find((send) => send.kind === "words")?.text ?? "";

const RILEY: SlotValue = { slot: "pro.name", value: "Riley" };
const AVERY: SlotValue = { slot: "name.staff", value: "Avery" };
const ALEX: SlotValue = { slot: "alex.staff", value: "Alex M." };
const DAY: SlotValue = { slot: "day", value: "Sat Oct 24" };
const TIME: SlotValue = { slot: "visit.time", value: "11:00am" };
const PRICE: SlotValue = { slot: "price", value: "$40" };
const VISIT: readonly SlotValue[] = [RILEY, DAY, TIME];

const OPENER = "This is Rosie, the automated booking assistant for Lee's Barbershop.";
const OPT_OUT_LINE = "Reply STOP to opt out. Msg & data rates may apply. Reply HELP for help.";
const firstText = partsOf(
  [wordsSend(`${OPENER} Riley says yes.\n${OPT_OUT_LINE}`)],
  [RILEY],
  ["opener", "optOutLine"],
);

/** A sentence of `count` one-syllable words. */
const ONE_SYLLABLE = ["we", "will", "keep", "the", "chair", "for", "you", "at", "the", "shop"];
const sentenceOf = (count: number): string =>
  `${Array.from({ length: count }, (_, i) => ONE_SYLLABLE[i % ONE_SYLLABLE.length] ?? "we").join(" ")}.`;

// ---------------------------------------------------------------------------------------------------------------

/** The fault each fixture's failed check names, in the words the rewrite is told. */
const FAULT_NAMED: Readonly<Record<string, string>> = {
  "check-two-questions.json": "The text asks two questions; ask at most one question per text.",
  "check-raw-price.json": "The price $45 is not a code-supplied fact; write the price as the {{price}} slot.",
  "check-emoji.json": "The text holds an emoji; write it without one.",
  "check-unfilled-slot.json": "The slot {{svc.intext}} has no value, so '{{' is left in the text.",
  "check-optout-only-option.json": "The option 'Cancel' is only an opt-out word",
  "check-fallback.json": "The time 10:30am is not a code-supplied fact",
  "check-passed-on.json": "The slot {{name.staff}} has no value, so '{{' is left in the text.",
};

describe("message checks: each K-03 v1 check-* fixture gives its stated result", () => {
  it("reads every check-* fixture of the index, the card's six among them", () => {
    const files = checkEntries.map((entry) => entry.file);
    for (const file of [
      "check-pass.json",
      "check-two-questions.json",
      "check-raw-price.json",
      "check-emoji.json",
      "check-optout-only-option.json",
      "check-unfilled-slot.json",
    ]) {
      expect(files).toContain(file);
    }
    expect(validateCheckResult, "K-03's checkResult definition").toBeDefined();
  });

  for (const entry of checkEntries) {
    it(`${entry.file}: ${entry.shows}`, () => {
      const stated = fixture(entry.file);
      const result = runMessageChecks(stated.checked, contextFor(stated.checked));

      // Each check passes or fails as the fixture states, each once and in K-03's order.
      expect(result.checks.map((check) => [check.check, check.passed])).toEqual(
        stated.checks.map((check) => [check.check, check.passed]),
      );
      // A detail only where a check failed, naming the fault the rewrite is told.
      for (const check of result.checks) expect(check.detail === null, check.check).toBe(check.passed);
      const failed = result.checks.filter((check) => !check.passed);
      const named = FAULT_NAMED[entry.file] ?? "";
      expect(named === "", "a fault is named for each fixture with a failed check").toBe(failed.length === 0);
      for (const check of failed) expect(check.detail).toContain(named);

      // What happens next follows from the checks (arch 07 line 417): a composed attempt sends when every check
      // passed, else gets its one rewrite; a later attempt falls back or is passed on only on a blocking miss.
      expect(result.passed).toBe(stated.outcome === "send");
      if (stated.attempt === "composed") expect(stated.outcome).toBe(result.passed ? "send" : "rewrite");
      else expect(result.blocked).toBe(stated.outcome === "fallback" || stated.outcome === "passedOn");

      // The checks given are K-03's: the fixture with them in place is still a valid checkResult.
      const valid = validateCheckResult?.({ ...stated, checks: result.checks });
      expect(valid, JSON.stringify(validateCheckResult?.errors)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------

describe("fixedLines: each fixed line and option word for word (arch 07 line 361)", () => {
  it("passes the opener and the opt-out line word for word, outside every other check", () => {
    expect(fixedLinesFaults(firstText, contextFor(firstText))).toEqual([]);
    expect(runMessageChecks(firstText, contextFor(firstText)).passed).toBe(true);
  });

  it("fails a fixed line with a word changed", () => {
    const changed = withWords(
      firstText,
      `${OPENER} Riley says yes.\n${OPT_OUT_LINE.replace("Msg & data", "Message and data")}`,
    );
    expect(fixedLinesFaults(changed, contextFor(changed))).toEqual([
      `The fixed line optOutLine is not in the text word for word: "${OPT_OUT_LINE}"`,
    ]);
  });

  it("fails a fixed line the bundle lacks, one that waits for Jay, and the opener with no business", () => {
    const unknown = partsOf([wordsSend("Riley says yes.")], [RILEY], ["madeUp"]);
    expect(fixedLinesFaults(unknown, contextFor(unknown))).toEqual([
      "The fixed line madeUp is not one of the bundle's fixed lines.",
    ]);
    const pending = partsOf([wordsSend("Riley says yes.")], [RILEY], ["stopReply"]);
    expect(fixedLinesFaults(pending, contextFor(pending))).toEqual([
      "The fixed line stopReply has no words yet: it waits for Jay.",
    ]);
    expect(fixedLinesFaults(firstText, contextFor(firstText, { businessName: null }))).toEqual([
      "The fixed line opener names the business, and there is no business yet.",
    ]);
  });

  it("fills <business> as written, so a name with '$' in it still matches word for word", () => {
    for (const business of ["Ca$$h Cuts", "Fade $& Co", "Lee$'s Cuts"]) {
      const opener = `This is Rosie, the automated booking assistant for ${business}.`;
      const parts = partsOf(
        [wordsSend(`${opener} Riley says yes.\n${OPT_OUT_LINE}`)],
        [RILEY],
        ["opener", "optOutLine"],
      );
      const context = contextFor(parts, { businessName: business });
      expect(fixedLinesFaults(parts, context), business).toEqual([]);
      expect(runMessageChecks(parts, context).passed, business).toBe(true);
    }
  });

  it("reads a fixed line in the reader's language, else in English", () => {
    expect(fixedLinesFaults(firstText, contextFor(firstText, { language: "es" }))).toEqual([]);
    const spanishLine = "Responda STOP para no recibir más.";
    const lists: CheckLists = {
      ...LISTS,
      fixedLines: { lines: [...LISTS.fixedLines.lines, { id: "optOutLine", text: spanishLine, lang: "es" }] },
    };
    expect(fixedLinesFaults(firstText, contextFor(firstText, { language: "es", lists }))).toEqual([
      `The fixed line optOutLine is not in the text word for word: "${spanishLine}"`,
    ]);
  });

  it("fails a poll option or typed options that are not the step's words", () => {
    const parts = partsOf(
      [
        wordsSend("Riley can't be in on Sat Oct 24. Avery can do your visit at 11:00am."),
        pollSend(["Avery instead", "Cancel"]),
      ],
      [RILEY, AVERY, DAY, TIME],
    );
    const step: Option[] = [
      { id: "A7-17/1", label: "Avery instead" },
      { id: "A7-17/2", label: "Cancel visit" },
    ];
    expect(fixedLinesFaults(parts, contextFor(parts, { options: step }))).toEqual([
      "The option 'Cancel' is not the step's words, 'Cancel visit'.",
    ]);
    expect(fixedLinesFaults(parts, contextFor(parts, { options: step.slice(0, 1) }))).toEqual([
      "The option A7-17/2 is not one of the step's options.",
    ]);
    expect(
      fixedLinesFaults(parts, contextFor(parts, { typedOptions: "Reply 1 Avery instead, 2 Cancel." })),
    ).toEqual(['The typed options are not in the text word for word: "Reply 1 Avery instead, 2 Cancel."']);
  });

  it("leaves typed options out of every other check, as code's words", () => {
    const typed = "Reply 1 Avery instead, 2 Cancel visit.";
    const parts = partsOf(
      [
        wordsSend(
          `Riley can't be in on Sat Oct 24. Avery can do your visit at 11:00am. Please reply by 7pm.\n${typed}`,
        ),
        pollSend(["Avery instead", "Cancel visit"]),
      ],
      [RILEY, AVERY, DAY, TIME, { slot: "ask.by", value: "7pm" }],
    );
    expect(runMessageChecks(parts, contextFor(parts, { typedOptions: typed })).checks).toEqual(
      CHECK_NAMES.map((check) => ({ check, passed: true, detail: null })),
    );
    // Not known as code's words, their numbers read as the model's.
    expect(valuesFaults(parts, contextFor(parts))).toContain(
      "The number 1 is not a code-supplied fact; write each number as its slot.",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("values: each value a code-supplied fact (arch 07 line 409; S13-28 rule 51)", () => {
  it("fails a price the model typed and passes the code-supplied one (check-raw-price)", () => {
    const typed = fixture("check-raw-price.json").checked;
    expect(valuesFaults(typed, contextFor(typed))).toEqual([
      "The price $45 is not a code-supplied fact; write the price as the {{price}} slot.",
    ]);
    const right = withWords(typed, "Alex M. booked a Skin fade for Sat Oct 24 at 11:00am. It costs $40.");
    expect(valuesFaults(right, contextFor(right))).toEqual([]);
  });

  it("fails each time, date, phone, link, number, name and day the model wrote that no fact holds", () => {
    const cases: [string, string][] = [
      [
        "Riley can see you Sat Oct 24 at 10:30am.",
        "The time 10:30am is not a code-supplied fact; write the time as the {{visit.time}} slot.",
      ],
      [
        "Riley can see you Sat Oct 25 at 11:00am.",
        "The date Oct 25 is not a code-supplied fact; write the date as the {{day}} slot.",
      ],
      [
        "Riley can see you Sat Oct 24 at 11:00am. Call 555-123-4567 to change it.",
        "The phone number 555-123-4567 is not a code-supplied fact; write each phone number as its slot.",
      ],
      [
        "Riley can see you Sat Oct 24 at 11:00am. Change it at example.com/book.",
        "The link example.com/book is not a code-supplied fact; write each link as its slot.",
      ],
      [
        "Riley can see you Sat Oct 24 at 11:00am for 45 minutes.",
        "The number 45 is not a code-supplied fact; write each number as its slot.",
      ],
      [
        "Riley and Jordan can see you Sat Oct 24 at 11:00am.",
        "The name Jordan is not a code-supplied fact; write each name as its slot.",
      ],
      [
        "Riley can see you tomorrow at 11:00am.",
        '"tomorrow" is filled at send; write it as the {{tomorrow}} slot.',
      ],
    ];
    for (const [text, fault] of cases) {
      const parts = textOf(text, VISIT);
      expect(valuesFaults(parts, contextFor(parts)), text).toEqual([fault]);
    }
  });

  it("passes a value a fact holds, in another form or in part", () => {
    const held: [string, readonly SlotValue[]][] = [
      ["Riley can see you Sat Oct 24 at 11:00 AM.", VISIT],
      ["Your visit is Oct 24 at 11am.", VISIT],
      ["It costs $40.00, paid at the chair.", [PRICE]],
      ["The shop is at 88 Elm St.", [{ slot: "visit.place", value: "88 Elm St, Springfield" }]],
      ["Avery can do it, or ask Alex.", [AVERY, ALEX]],
      ["See you tomorrow.", [{ slot: "tomorrow", value: "tomorrow" }]],
    ];
    for (const [text, values] of held) {
      const parts = textOf(text, values);
      expect(valuesFaults(parts, contextFor(parts)), text).toEqual([]);
    }
  });

  it("counts the master line's own words as code-supplied, never a slot's example words", () => {
    const master = "About 15 minutes for your first kind of work · {{price:$35}} a visit · $2 a booking";
    const own = textOf("It takes about 15 minutes. Rosie's fee is $2 a booking.");
    expect(valuesFaults(own, contextFor(own, { masterText: master }))).toEqual([]);
    expect(valuesFaults(own, contextFor(own))).toEqual([
      "The price $2 is not a code-supplied fact; write each price as its slot.",
      "The number 15 is not a code-supplied fact; write each number as its slot.",
    ]);
    const example = textOf("A visit is $35.");
    expect(valuesFaults(example, contextFor(example, { masterText: master }))).toEqual([
      "The price $35 is not a code-supplied fact; write each price as its slot.",
    ]);

    const line = "I'll set up your business so AI assistants like ChatGPT, Claude and Gemini can book you.";
    const s102 = `Hi! I'm Rosie, an automated assistant. ${line} What kinds of work do you do? Just type them.`;
    expect(valuesFaults(textOf(line), contextFor(textOf(line), { masterText: s102 }))).toEqual([]);
    expect(valuesFaults(textOf(line), contextFor(textOf(line)))).toEqual(
      ["ChatGPT", "Claude", "Gemini"].map(
        (name) => `The name ${name} is not a code-supplied fact; write each name as its slot.`,
      ),
    );
  });

  it("never holds a shortened amount or time by the whole one: '$45' is not in '$45.99', '10' not in '10:30am'", () => {
    const cases: [string, SlotValue, string][] = [
      [
        "It costs $45.",
        { slot: "price", value: "$45.99" },
        "The price $45 is not a code-supplied fact; write the price as the {{price}} slot.",
      ],
      [
        "Your visit is at 10.",
        { slot: "visit.time", value: "10:30am" },
        "The number 10 is not a code-supplied fact; write each number as its slot.",
      ],
      [
        "It costs 45 cents more.",
        { slot: "price", value: "$12.45" },
        "The number 45 is not a code-supplied fact; write each number as its slot.",
      ],
      [
        "It takes 30 minutes.",
        { slot: "visit.ends", value: "11:30" },
        "The number 30 is not a code-supplied fact; write each number as its slot.",
      ],
    ];
    for (const [text, fact, fault] of cases) {
      const parts = textOf(text, [fact]);
      expect(valuesFaults(parts, contextFor(parts)), text).toEqual([fault]);
    }
    // The whole value is still held, here by a fact the composer was given.
    const whole: [string, SlotValue][] = [
      ["It costs $45.99.", { slot: "price", value: "$45.99" }],
      ["Your visit is at 10:30am.", { slot: "visit.time", value: "10:30am" }],
    ];
    for (const [text, fact] of whole) {
      expect(valuesFaults(textOf(text), contextFor(textOf(text), { facts: [fact] })), text).toEqual([]);
    }
  });

  it("reads any word shaped like a domain as a link, with or without https:// and a path", () => {
    const cases: [string, string][] = [
      ["Pay at lees-cuts.shop/pay to keep the time.", "lees-cuts.shop/pay"],
      ["Pay at example.ca/pay before you come.", "example.ca/pay"],
      ["Pay at https://example.ca/pay before you come.", "https://example.ca/pay"],
      ["Pay at www.lees-cuts.shop.", "www.lees-cuts.shop"],
      ["Email riley@example.ca to change it.", "riley@example.ca"],
    ];
    for (const [text, link] of cases) {
      const parts = textOf(text);
      expect(valuesFaults(parts, contextFor(parts)), text).toEqual([
        `The link ${link} is not a code-supplied fact; write each link as its slot.`,
      ]);
    }
    // A link code supplied passes: a slot's value, or a fact the composer was given.
    const slot = textOf("Pay at lees-cuts.shop/pay to keep the time.", [
      { slot: "link.pay", value: "lees-cuts.shop/pay" },
    ]);
    expect(valuesFaults(slot, contextFor(slot))).toEqual([]);
    const fact = textOf("Pay at example.ca/pay before you come.");
    const given = contextFor(fact, { facts: [{ slot: "link.pay", value: "example.ca/pay" }] });
    expect(valuesFaults(fact, given)).toEqual([]);
  });

  it("reads a capitalized word that starts a line or a sentence, follows ':' or ' · ', or opens a quote or a bracket as a name too", () => {
    const service: SlotValue = { slot: "svc.intext", value: "Haircut" };
    for (const text of [
      "Haircut · Sat Oct 24 · 11:00am · Jordan",
      "Jordan can do your visit at 11:00am.",
      "Riley can't come. Jordan can do your visit at 11:00am.",
      "Your pro: Jordan.",
      "Riley is out, so “Jordan” will do it.",
      "Your visit is at 11:00am (Jordan).",
    ]) {
      const parts = textOf(text, [...VISIT, service]);
      expect(valuesFaults(parts, contextFor(parts)), text).toEqual([
        "The name Jordan is not a code-supplied fact; write each name as its slot.",
      ]);
    }
    const held = textOf("Jordan can do your visit at 11:00am.", [
      ...VISIT,
      { slot: "name.staff", value: "Jordan" },
    ]);
    expect(valuesFaults(held, contextFor(held))).toEqual([]);
  });

  it("passes a plain word where a sentence starts: a common word, a fixed line's word or the master line's", () => {
    const common = textOf(
      "Thanks! Your visit is Sat Oct 24 at 11:00am. Check-in opens then. Please bring your card.",
      VISIT,
    );
    expect(valuesFaults(common, contextFor(common))).toEqual([]);

    // "Msg" is a word of the opt-out line, and no common word.
    const fixedWord = textOf("Msg and data rates may apply.");
    expect(valuesFaults(fixedWord, contextFor(fixedWord))).toEqual([]);
    const noLines: CheckLists = { ...LISTS, fixedLines: { lines: [] } };
    expect(valuesFaults(fixedWord, contextFor(fixedWord, { lists: noLines }))).toEqual([
      "The name Msg is not a code-supplied fact; write each name as its slot.",
    ]);

    // "Hi" is no common word (Rosie's lines in the master write it capitalized only): only the master line holds it.
    const greeting = textOf("Hi Sam, your visit is Sat Oct 24 at 11:00am.", VISIT);
    const master = "Hi {{name}}, your visit is {{day}} at {{visit.time}}.";
    expect(valuesFaults(greeting, contextFor(greeting, { readerName: "Sam", masterText: master }))).toEqual(
      [],
    );
    expect(valuesFaults(greeting, contextFor(greeting, { readerName: "Sam" }))).toEqual([
      "The name Hi is not a code-supplied fact; write each name as its slot.",
    ]);
  });

  it("passes the business's own name where a sentence starts, as code supplies it", () => {
    const named = textOf("Lee's Barbershop can see you Sat Oct 24 at 11:00am.", VISIT);
    expect(valuesFaults(named, contextFor(named))).toEqual([]);
    expect(valuesFaults(named, contextFor(named, { businessName: null }))).toEqual([
      "The name Lee is not a code-supplied fact; write each name as its slot.",
      "The name Barbershop is not a code-supplied fact; write each name as its slot.",
    ]);
  });

  it("passes a value the composer was given as a fact, and the reader's name", () => {
    const thanks = textOf("Thanks, Sam. Riley can see you at 11:00am, and the fee is $20.", [RILEY, TIME]);
    const given = contextFor(thanks, { facts: [{ slot: "fee", value: "$20" }], readerName: "Sam" });
    expect(valuesFaults(thanks, given)).toEqual([]);
    expect(valuesFaults(thanks, contextFor(thanks))).toEqual([
      "The price $20 is not a code-supplied fact; write each price as its slot.",
      "The name Sam is not a code-supplied fact; write each name as its slot.",
    ]);
  });

  it("leaves a relay's quote out: its words are the sender's, and never a fact", () => {
    const quote = "Can you do $999 with Jordan at 3pm tomorrow?";
    const relay = textOf(`Alex M. asks: ${quote}`, [ALEX, { slot: "relay.quote", value: quote }]);
    expect(valuesFaults(relay, contextFor(relay))).toEqual([]);
    const unquoted = textOf("Alex M. asks if Jordan can do $999 at 3pm.", [ALEX]);
    const faults = [
      "The price $999 is not a code-supplied fact; write each price as its slot.",
      "The time 3pm is not a code-supplied fact; write each time as its slot.",
      "The name Jordan is not a code-supplied fact; write each name as its slot.",
    ];
    expect(valuesFaults(unquoted, contextFor(unquoted))).toEqual(faults);
    const restated = textOf(`Alex M. asks if Jordan can do $999 at 3pm. ${quote}`, [
      ALEX,
      { slot: "relay.quote", value: quote },
    ]);
    expect(valuesFaults(restated, contextFor(restated))).toEqual(faults);
  });

  it("takes a quote out at its own place only: the model may not repeat its words elsewhere", () => {
    const quote: SlotValue = { slot: "relay.quote", value: "3pm" };
    const alone = textOf("Alex M. asks: 3pm", [ALEX, quote]);
    expect(valuesFaults(alone, contextFor(alone))).toEqual([]);
    const repeated = textOf("Riley can do 3pm.\nAlex M. asks: 3pm", [RILEY, ALEX, quote]);
    expect(valuesFaults(repeated, contextFor(repeated))).toEqual([
      "The time 3pm is not a code-supplied fact; write each time as its slot.",
    ]);
  });

  it("fails '{{', 'null' or 'undefined' left in the words, and a card link no link slot holds", () => {
    const unfilled = fixture("check-unfilled-slot.json").checked;
    expect(valuesFaults(unfilled, contextFor(unfilled))).toEqual([
      "The slot {{svc.intext}} has no value, so '{{' is left in the text.",
    ]);
    const empty = textOf("Your visit with Riley is undefined, and the price is null.", [RILEY]);
    expect(valuesFaults(empty, contextFor(empty))).toEqual([
      'The text says "undefined" where code left a value empty.',
      'The text says "null" where code left a value empty.',
    ]);
    expect(valuesFaults(finalTwoSends, contextFor(finalTwoSends))).toEqual([]);
    const card: FinalParts = {
      ...finalTwoSends,
      sends: finalTwoSends.sends.map((send) =>
        send.kind === "linkCard" ? { ...send, link: "rosfield.com/v/other" } : send,
      ),
    };
    expect(valuesFaults(card, contextFor(card))).toEqual([
      "The card's link rosfield.com/v/other is not a code-supplied fact; give the link as its slot.",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("oneQuestion: at most one question per text (S13-28 rule 50)", () => {
  it("fails two or three questions in a text and passes one (check-two-questions)", () => {
    const two = fixture("check-two-questions.json").checked;
    expect(oneQuestionFaults(two, contextFor(two))).toEqual([
      "The text asks two questions; ask at most one question per text.",
    ]);
    const one = withWords(two, "Your visit is Sat Oct 24 at 11:00am. Does that still work?");
    expect(oneQuestionFaults(one, contextFor(one))).toEqual([]);
    const three = textOf("Does Sat work? Or Sun? Or Mon?");
    expect(oneQuestionFaults(three, contextFor(three))).toEqual([
      "The text asks three questions; ask at most one question per text.",
    ]);
  });

  it("reads '??' as one question, a fixed line's question as none, and a quote's as none", () => {
    const loud = textOf("Does that still work??");
    expect(oneQuestionFaults(loud, contextFor(loud))).toEqual([]);
    // safetyAsk is code's fixed line, so only the composed words' one question counts (T-1178; DL-355).
    const safety = partsOf(
      [wordsSend("Is anyone in danger right now? What time works for you?")],
      [],
      ["safetyAsk"],
    );
    expect(oneQuestionFaults(safety, contextFor(safety))).toEqual([]);
    const twoOwn = partsOf(
      [wordsSend("Is anyone in danger right now? What time works for you? Or should we call you?")],
      [],
      ["safetyAsk"],
    );
    expect(oneQuestionFaults(twoOwn, contextFor(twoOwn))).toEqual([
      "The text asks two questions; ask at most one question per text.",
    ]);
    const quote = "Can you come at 3pm instead?";
    const relay = textOf(`Alex M. asks: ${quote}\nYour answer for Alex M.?`, [
      ALEX,
      { slot: "relay.quote", value: quote },
    ]);
    expect(oneQuestionFaults(relay, contextFor(relay))).toEqual([]);
  });

  it("leaves a quote's question out only at its own place: a repeat of it is the model's", () => {
    const quote = "Can you come at 3pm instead?";
    const repeated = textOf(`Alex M. asks: ${quote}\n${quote}\nYour answer for Alex M.?`, [
      ALEX,
      { slot: "relay.quote", value: quote },
    ]);
    expect(oneQuestionFaults(repeated, contextFor(repeated))).toEqual([
      "The text asks two questions; ask at most one question per text.",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("neverInMessage: no emoji, markdown, step id, word that never goes in, or opt-out-only option", () => {
  it("fails an emoji (check-emoji) and passes the words without it", () => {
    const emoji = fixture("check-emoji.json").checked;
    expect(neverInMessageFaults(emoji, contextFor(emoji))).toEqual([
      "The text holds an emoji; write it without one.",
    ]);
    const plain = withWords(emoji, "You're booked! Sat Oct 24 at 11:00am with Riley.");
    expect(neverInMessageFaults(plain, contextFor(plain))).toEqual([]);
  });

  it("fails markdown, a leading # or bullet, a step id and each word that never goes in a message", () => {
    const cases: [string, string][] = [
      ["Your visit is **booked**.", "The text holds markdown (** or a backtick); write plain words."],
      ["Open the `secure page` to pay.", "The text holds markdown (** or a backtick); write plain words."],
      ["# Your visit\nSee you then.", "A line starts with # or a bullet; write plain lines."],
      ["Your visit:\n- Haircut with Riley", "A line starts with # or a bullet; write plain lines."],
      ["• Haircut with Riley", "A line starts with # or a bullet; write plain lines."],
      ["This is step A4-12 of your booking.", "The text names the step id A4-12; never name a step."],
      ["Tell the user it is booked.", 'The text says "the user", which never goes in a message.'],
      [
        "As the system prompt says, it is booked.",
        'The text says "the system prompt", which never goes in a message.',
      ],
      ["Book again soon.", 'The text says "Book again", which never goes in a message.'],
      ["Here is a coupon for your next visit.", 'The text says "coupon", which never goes in a message.'],
      ["Take 20% off your next visit.", 'The text says "% off", which never goes in a message.'],
    ];
    for (const [text, fault] of cases) {
      const parts = textOf(text);
      expect(neverInMessageFaults(parts, contextFor(parts)), text).toEqual([fault]);
    }
  });

  it("passes the same forms inside a relay's quote", () => {
    const quote = "**Great** 🎉 can I book again at A4-12?";
    const relay = textOf(`Alex M. asks: ${quote}`, [ALEX, { slot: "relay.quote", value: quote }]);
    expect(neverInMessageFaults(relay, contextFor(relay))).toEqual([]);
  });

  it("leaves a quote out only at its own place: an emoji the model repeats outside it fails", () => {
    const quote: SlotValue = { slot: "relay.quote", value: "👍" };
    const alone = textOf("Alex M. sent: 👍", [ALEX, quote]);
    expect(neverInMessageFaults(alone, contextFor(alone))).toEqual([]);
    const repeated = textOf("Thanks 👍\nAlex M. sent: 👍", [ALEX, quote]);
    expect(neverInMessageFaults(repeated, contextFor(repeated))).toEqual([
      "The text holds an emoji; write it without one.",
    ]);
  });

  it("fails an option that is only one of msgtext.js's 16 opt-out words, in any case or with a mark", () => {
    const words = LISTS.keywords.optOut;
    expect(words).toHaveLength(16);
    expect(words).toContain("CANCEL");
    expect(words).toContain("OPT OUT");
    for (const word of words) {
      const capital = `${word.charAt(0)}${word.slice(1).toLowerCase()}`;
      for (const label of [word, word.toLowerCase(), `${capital}.`, ` ${word}! `]) {
        const parts = partsOf(
          [wordsSend("Riley can't be in on Sat Oct 24."), pollSend(["Avery instead", label])],
          [RILEY, DAY],
        );
        expect(neverInMessageFaults(parts, contextFor(parts)), label).toEqual([
          `The option '${label}' is only an opt-out word; name what it does, such as 'Cancel visit'.`,
        ]);
      }
    }
  });

  it("passes an option that names what it does", () => {
    for (const label of ["Cancel visit", "Stop by later", "End of day works", "Para mañana"]) {
      const parts = partsOf(
        [wordsSend("Riley can't be in on Sat Oct 24."), pollSend(["Avery instead", label])],
        [RILEY, DAY],
      );
      expect(neverInMessageFaults(parts, contextFor(parts)), label).toEqual([]);
    }
  });

  /** A words send carrying typed options (msgtext.js line 64), with no poll. */
  const typedIn = (typed: string): FinalParts =>
    partsOf([wordsSend(`Riley can't be in on Sat Oct 24.\n${typed}`)], [RILEY, DAY]);
  const optOutOnly = (label: string): string =>
    `The option '${label}' is only an opt-out word; name what it does, such as 'Cancel visit'.`;
  const STEP_OPTIONS: Option[] = [
    { id: "A7-17/1", label: "Avery instead" },
    { id: "A7-17/2", label: "Cancel" },
  ];

  it("fails an opt-out-only option typed into the words, on every channel (msgtext.js lines 64 and 95)", () => {
    const typed = "Reply 1 Avery instead, 2 Cancel.";
    for (const channel of ["imessage", "rcs", "sms", "email"] as const) {
      const parts: FinalParts = { ...typedIn(typed), channel };
      const context = contextFor(parts, { options: STEP_OPTIONS, typedOptions: typed });
      expect(neverInMessageFaults(parts, context), channel).toEqual([optOutOnly("Cancel")]);
      expect(runMessageChecks(parts, context).blocked, channel).toBe(true);
    }
  });

  it("fails one held by the step's options or by the typed options alone, each of the 16 words alike", () => {
    // The step's options alone, with nothing typed and no poll.
    const plain = typedIn("Does Avery instead work?");
    expect(neverInMessageFaults(plain, contextFor(plain, { options: STEP_OPTIONS }))).toEqual([
      optOutOnly("Cancel"),
    ]);
    // The typed options alone, numbered or lettered, in English or Spanish.
    const typedAlone: [string, string][] = [
      ["Reply 1 Avery instead, 2 Cancel.", "Cancel"],
      ["Reply A Avery instead, B Stop.", "Stop"],
      ["Responda 1 Avery, 2 Cancelar.", "Cancelar"],
    ];
    for (const [typed, label] of typedAlone) {
      const parts = typedIn(typed);
      expect(neverInMessageFaults(parts, contextFor(parts, { typedOptions: typed })), typed).toEqual([
        optOutOnly(label),
      ]);
    }
    for (const word of LISTS.keywords.optOut) {
      const typed = `Reply 1 Avery instead, 2 ${word}.`;
      const parts = typedIn(typed);
      expect(neverInMessageFaults(parts, contextFor(parts, { typedOptions: typed })), word).toEqual([
        optOutOnly(word),
      ]);
    }
  });

  it("passes typed options that name what they do, a label with a comma of its own kept whole", () => {
    for (const typed of [
      "Reply 1 Avery instead, 2 Cancel visit.",
      "Reply 1 Yes, they agreed, 2 Not yet.",
      "Reply 1 Yes, cancel it, 2 No.",
    ]) {
      const parts = typedIn(typed);
      expect(neverInMessageFaults(parts, contextFor(parts, { typedOptions: typed })), typed).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("shape: a first line, at most four fact lines, one action line; at most 5 short options", () => {
  it("passes six lines, then the question, with fixed lines outside the count (final-two-sends)", () => {
    expect(shapeFaults(finalTwoSends, contextFor(finalTwoSends))).toEqual([]);
    const asked = withWords(finalTwoSends, `${confirmation}\nDoes that time still work?`);
    expect(shapeFaults(asked, contextFor(asked))).toEqual([]);
    const first: FinalParts = {
      ...withWords(finalTwoSends, `${OPENER}\n${confirmation}\n${OPT_OUT_LINE}`),
      fixedLines: ["opener", "optOutLine"],
    };
    expect(shapeFaults(first, contextFor(first))).toEqual([]);
  });

  it("fails a fifth fact line, past four fact lines", () => {
    const five = withWords(
      finalTwoSends,
      confirmation.replace("\n88 Elm St", "\nBring the card you booked with\n88 Elm St"),
    );
    expect(shapeFaults(five, contextFor(five))).toEqual([
      "The message has 7 lines before its question, past four fact lines; write one first line, at most four fact lines and one action line.",
    ]);
  });

  it("fails more than five options, and an option over 24 characters", () => {
    const six = partsOf([
      wordsSend("Which time works?"),
      pollSend(["10am", "11am", "noon", "1pm", "2pm", "3pm"]),
    ]);
    expect(shapeFaults(six, contextFor(six))).toEqual(["The poll has 6 options; give at most 5."]);
    const long = partsOf([
      wordsSend("Which works?"),
      pollSend(["Avery instead, same time and price", "Cancel visit"]),
    ]);
    expect(shapeFaults(long, contextFor(long))).toEqual([
      "The option 'Avery instead, same time and price' is over 24 characters.",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("lengthAndReading: 22 words and 4 commas a sentence, 260 or 320 characters, grade 9.5", () => {
  it("fails a sentence of more than 22 words", () => {
    const most = textOf(sentenceOf(22));
    expect(lengthAndReadingFaults(most, contextFor(most))).toEqual([]);
    const over = textOf(sentenceOf(23));
    expect(lengthAndReadingFaults(over, contextFor(over))).toEqual([
      'The sentence "we will keep the ..." has 23 words; keep each sentence to 22 words or fewer.',
    ]);
  });

  it("fails a sentence of more than 4 commas, semicolons or brackets", () => {
    const most = textOf("Bring a towel, a comb, some gel (a bit) and a cap.");
    expect(lengthAndReadingFaults(most, contextFor(most))).toEqual([]);
    const over = textOf("Bring a towel, a comb, some gel, a cap, a hat, and a coat.");
    expect(lengthAndReadingFaults(over, contextFor(over))).toEqual([
      'The sentence "Bring a towel, a ..." has 5 commas, semicolons or brackets; keep it to 4.',
    ]);
  });

  it("fails more than 260 characters of the model's words with a poll or card, and 320 without", () => {
    const plain = (length: number): FinalParts => textOf("a".repeat(length));
    const polled = (length: number): FinalParts =>
      partsOf([wordsSend("a".repeat(length)), pollSend(["Yes", "No"])]);
    expect(lengthAndReadingFaults(plain(320), contextFor(plain(320)))).toEqual([]);
    expect(lengthAndReadingFaults(plain(321), contextFor(plain(321)))).toEqual([
      "The message's own words run 321 characters; keep them to 320.",
    ]);
    expect(lengthAndReadingFaults(polled(260), contextFor(polled(260)))).toEqual([]);
    expect(lengthAndReadingFaults(polled(261), contextFor(polled(261)))).toEqual([
      "The message's own words run 261 characters; keep them to 260 with a poll or card.",
    ]);
  });

  it("counts only the model's words, not fixed lines, slot values, links or quotes (final-two-sends)", () => {
    expect(confirmation.length).toBeGreaterThan(260);
    expect(lengthAndReadingFaults(finalTwoSends, contextFor(finalTwoSends))).toEqual([]);
    const first: FinalParts = {
      ...withWords(finalTwoSends, `${OPENER}\n${confirmation}\n${OPT_OUT_LINE}`),
      fixedLines: ["opener", "optOutLine"],
    };
    expect(lengthAndReadingFaults(first, contextFor(first))).toEqual([]);
    // The same words with no slot values given are all the model's, and run past 260 beside the card.
    const unslotted: FinalParts = { ...finalTwoSends, slotValues: [] };
    expect(
      lengthAndReadingFaults(unslotted, contextFor(unslotted)).some((fault) =>
        fault.startsWith("The message's own words run"),
      ),
    ).toBe(true);
    const quote = `${sentenceOf(30)} ${"a".repeat(400)}`;
    const relay = textOf(`Alex M. asks: ${quote}`, [ALEX, { slot: "relay.quote", value: quote }]);
    expect(lengthAndReadingFaults(relay, contextFor(relay))).toEqual([]);
  });

  it("counts none of Rosie's own fixed terms, like slot values, while Values still reads them (K-03 v1.1; DL-158)", () => {
    // S1-02's four card lines, each naming no slot (K-03 v1.1 input-s1-02-v1.1.json's term facts), and plan-s1-02.json's
    // fact line, which states three of them word for word.
    const input = readJson(`${PLAN}/fixtures/input-s1-02-v1.1.json`) as { facts: { value: string }[] };
    const plan = readJson(`${PLAN}/fixtures/plan-s1-02.json`) as { lines: { text: string }[] };
    const terms = input.facts.map((fact) => fact.value);
    const line = plan.lines[1]?.text ?? "";
    expect(terms).toHaveLength(4);
    const parts = textOf(
      `I'll set up your business so you can be booked.\n${line}\nWhat kinds of work do you do?`,
    );
    const facts: SlotValue[] = terms.map((value) => ({ slot: "term", value }));
    // Read as the model's own words, the fact line is one sentence of 26 words.
    expect(lengthAndReadingFaults(parts, contextFor(parts, { facts }))).toEqual([
      'The sentence "About 15 minutes for ..." has 26 words; keep each sentence to 22 words or fewer.',
    ]);
    // Given as the row's terms, none of their words is counted, and the line is still a line of the shape.
    expect(lengthAndReadingFaults(parts, contextFor(parts, { facts, terms }))).toEqual([]);
    expect(shapeFaults(parts, contextFor(parts, { facts, terms }))).toEqual([]);
    expect(runMessageChecks(parts, contextFor(parts, { facts, terms })).passed).toBe(true);
    // The Values check still reads each of their words: a number in a term stands only where a fact holds it.
    expect(valuesFaults(parts, contextFor(parts, { terms }))).toEqual([
      "The price $2 is not a code-supplied fact; write each price as its slot.",
      "The number 15 is not a code-supplied fact; write each number as its slot.",
    ]);
  });

  it("fails English above grade 9.5, and grades no other language", () => {
    const hard = textOf(
      "Unfortunately, administrative reconfiguration necessitates additional documentation regarding your prospective appointment's eligibility before confirmation.",
    );
    expect(lengthAndReadingFaults(hard, contextFor(hard))).toEqual([
      "The words read at grade 36.7; use shorter words and sentences, to grade 9.5 or lower.",
    ]);
    expect(lengthAndReadingFaults(hard, contextFor(hard, { language: "es" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("format: what this phone allows, in at most two sends (arch 07 lines 365, 367, 391)", () => {
  it("fails a format this phone does not allow now", () => {
    const poll = fixture("check-optout-only-option.json").checked;
    expect(formatFaults(poll, contextFor(poll))).toEqual([]);
    expect(formatFaults(poll, contextFor(poll, { allowedFormats: ["text"] }))).toEqual([
      "A poll is not allowed on this phone now, so the message goes as text alone.",
    ]);
    expect(
      formatFaults(finalTwoSends, contextFor(finalTwoSends, { allowedFormats: ["text", "linkCard"] })),
    ).toEqual(["A calendar file is not allowed on this phone now, so the message goes as text alone."]);
  });

  it("fails a tapback with anything else, a card before the words, and a poll of one option", () => {
    const alone = partsOf([TAPBACK]);
    expect(formatFaults(alone, contextFor(alone))).toEqual([]);
    const both = partsOf([wordsSend("Thanks!"), TAPBACK]);
    expect(formatFaults(both, contextFor(both))).toEqual([
      "A tapback goes alone, never with words, a poll or a card.",
    ]);
    const reversed: FinalParts = { ...finalTwoSends, sends: [...finalTwoSends.sends].reverse() };
    expect(formatFaults(reversed, contextFor(reversed))).toEqual([
      "A message goes as the words, then at most one poll or card.",
    ]);
    const single = partsOf([wordsSend("Does Sat work?"), pollSend(["Yes"])]);
    expect(formatFaults(single, contextFor(single))).toEqual(["A poll carries 2 to 5 options, not 1."]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("runMessageChecks: every check once, and which misses block", () => {
  it("gives each check once in K-03's order, and blocks only on the first four", () => {
    expect(CHECK_NAMES).toEqual(planSchema.$defs.checkName.enum);
    expect([...BLOCKING_CHECKS]).toEqual(["fixedLines", "values", "oneQuestion", "neverInMessage"]);

    const long = textOf(sentenceOf(23));
    const logged = runMessageChecks(long, contextFor(long));
    expect(logged.checks.map((check) => check.check)).toEqual(CHECK_NAMES);
    expect(logged.checks.filter((check) => !check.passed).map((check) => check.check)).toEqual([
      "lengthAndReading",
    ]);
    expect(logged.passed).toBe(false);
    expect(logged.blocked).toBe(false);

    const asked = fixture("check-two-questions.json").checked;
    const blocked = runMessageChecks(asked, contextFor(asked));
    expect(blocked.passed).toBe(false);
    expect(blocked.blocked).toBe(true);

    const sent = runMessageChecks(finalTwoSends, contextFor(finalTwoSends));
    expect(sent.passed).toBe(true);
    expect(sent.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("details: never a piece of a filled value where a scan splits a value glued to a letter or digit (T-1105)", () => {
  // Values the composer never gets (K-09 README default 32; T-310's security note b: visit.code and visit.place never
  // pass through the AI, A6-14). A value glued to a letter or digit is not taken out of the words, and T-312's scans
  // split it: "The number 11:00 ...", "The name Springfieldx ...", "The number 12 ..." and "The name CodeAB ...", pieces
  // the finalize answer's scrub (T-313) cannot see, as it writes only a whole value as its slot.
  const PLACE: SlotValue = { slot: "visit.place", value: "88 Elm St, Springfield" };
  const CODE: SlotValue = { slot: "visit.code", value: "AB12" };

  /** A check's detail on the parts: null when it passed. */
  const detailOf = (parts: FinalParts, check: CheckOutcome["check"]): string | null =>
    runMessageChecks(parts, contextFor(parts)).checks.find((outcome) => outcome.check === check)?.detail ??
    null;
  /** What the Values check says of a slot whose value is glued: the check and the slot, never a piece. */
  const glued = (slot: string): string =>
    `values: the slot {{${slot}}} is glued to the word beside it, so its value is not read whole; put a space between them.`;

  it('"{{visit.time}}x", a right-glued "{{visit.place}}x" and "Code{{visit.code}}" with letters name the check and the slot', () => {
    const cases: [string, readonly SlotValue[], string, readonly string[]][] = [
      ["Riley can see you Sat Oct 24 at 11:00amx.", VISIT, "visit.time", ["11:00", "00am"]],
      ["Your visit is at 88 Elm St, Springfieldx.", [PLACE], "visit.place", ["Springfield"]],
      ["Give CodeAB12 at the chair when you arrive.", [CODE], "visit.code", ["AB", "12"]],
    ];
    for (const [text, values, slot, pieces] of cases) {
      const parts = textOf(text, values);
      // The message still blocks as before (arch 07 line 417): only the detail's words change.
      expect(runMessageChecks(parts, contextFor(parts)).blocked, text).toBe(true);
      expect(detailOf(parts, "values"), text).toBe(glued(slot));
      expect(detailOf(parts, "neverInMessage"), text).toBeNull();
      for (const piece of pieces) expect(detailOf(parts, "values"), text).not.toContain(piece);
    }
  });

  it("names each slot a piece cuts into: a value glued on its left, and two slots glued together", () => {
    const left = textOf("Riley can see you Sat Oct 24 at x11:00am.", VISIT);
    expect(detailOf(left, "values")).toBe(glued("visit.time"));
    const together = textOf("Riley can see you Sat Oct 2411:00am.", VISIT);
    expect(detailOf(together, "values")).toBe(`${glued("visit.time")} ${glued("day")}`);
    for (const piece of ["11", "00am", "24"]) {
      expect(detailOf(left, "values"), piece).not.toContain(piece);
      expect(detailOf(together, "values"), piece).not.toContain(piece);
    }
    // A name is quoted without its "'s", so it holds a value ending "'s" only in part: the slot, never "TheSam".
    const shop = textOf("Your visit is at TheSam's now.", [{ slot: "biz.name", value: "Sam's" }]);
    expect(detailOf(shop, "values")).toBe(glued("biz.name"));
    expect(detailOf(shop, "values")).not.toContain("Sam");
  });

  it("a digit-only code (5160) gives what it gives today: the number is read whole, so no piece is split off", () => {
    const code: SlotValue = { slot: "visit.code", value: "5160" };
    const named = textOf("Give Code5160 at the chair when you arrive.", [code]);
    expect(detailOf(named, "values")).toBe(
      "The name Code is not a code-supplied fact; write each name as its slot.",
    );
    expect(detailOf(named, "neverInMessage")).toBeNull();
    for (const text of ["Code5160 is your check-in code.", "Your check-in code is 5160x."]) {
      const parts = textOf(text, [code]);
      expect(runMessageChecks(parts, contextFor(parts)).passed, text).toBe(true);
    }
  });

  it("a value read whole, glued or not, is quoted as before: the finalize answer writes its slot (T-313)", () => {
    const secure: SlotValue = { slot: "link.secure", value: "rosfield.com/v/s03" };
    const link = textOf("Open rosfield.com/v/s03now to see your visit.", [secure]);
    expect(detailOf(link, "values")).toBe(
      "The link rosfield.com/v/s03now is not a code-supplied fact; write the link as the {{link.secure}} slot.",
    );
  });

  it("cuts a detail that would still hold a piece down to its check's name alone", () => {
    // The model's own "11:00" is quoted, and it is also the piece the glued visit.time gives: the check's name alone.
    const parts = textOf("Come by 11:00. Riley can see you Sat Oct 24 at 11:00amx.", VISIT);
    expect(valuesFaults(parts, contextFor(parts))).toEqual(["values"]);
    expect(detailOf(parts, "values")).toBe("values");
    // Without the glued value, the model's own words are quoted as before.
    const own = textOf("Come by 11:00. Riley can see you Sat Oct 24 at 11:00am.", VISIT);
    expect(detailOf(own, "values")).toBe(
      "The time 11:00 is not a code-supplied fact; write the time as the {{visit.time}} slot.",
    );
  });

  it("Never in a message names the slot where a step id or a word that never goes in is a piece of a filled value", () => {
    const unit: SlotValue = { slot: "visit.place", value: "Unit A4-12, 88 Elm St" };
    const shop: SlotValue = { slot: "svc.intext", value: "Fade with coupon" };
    const cases: [string, SlotValue, string][] = [
      ["Your visit is at Unit A4-12, 88 Elm St.", unit, "A4-12"],
      ["Your Fade with coupons is booked.", shop, "coupon"],
    ];
    for (const [text, value, piece] of cases) {
      const parts = textOf(text, [value]);
      expect(runMessageChecks(parts, contextFor(parts)).blocked, text).toBe(true);
      expect(detailOf(parts, "neverInMessage"), text).toBe(
        `neverInMessage: the slot {{${value.slot}}} reads with the words beside it as words that never go in a message; reword the text around it.`,
      );
      expect(detailOf(parts, "neverInMessage"), text).not.toContain(piece);
    }
    // The model's own step id is quoted first, and it is also the piece the place gives: the check's name alone.
    const own = textOf("This is step A4-12 at Unit A4-12, 88 Elm St.", [unit]);
    expect(neverInMessageFaults(own, contextFor(own))).toEqual(["neverInMessage"]);
  });

  // Round 2 (DL-176; the security reviewer's FAIL 1 and note a). A value that stands whole inside a longer glued value
  // is taken out of the words, and an unclosed "{{foo" takes out the head of the value it is glued to; either way the
  // glued value no longer stands in what is left, so it must keep the place it has in the send text.
  const BIZ_NAME: SlotValue = { slot: "biz.name", value: "Lee's Barbershop" };
  const SHOP_PLACE: SlotValue = { slot: "visit.place", value: "Lee's Barbershop, 88 Elm St, Springfield" };

  /**
   * Every piece a value can be cut into, for the tests to look for: each run of letters or digits in it, of two
   * characters or more or with a digit ("Lee", "Barbershop", "88", "Springfield"; "11" and "00am" of "11:00am").
   */
  const piecesOf = (values: readonly SlotValue[]): string[] =>
    values.flatMap((fact) =>
      [...fact.value.matchAll(/[\p{L}\p{N}]+/gu)]
        .map(([run]) => run)
        .filter((run) => run.length > 1 || /\p{N}/u.test(run)),
    );

  /**
   * Each case's text gives the Values detail `glued(slot)` and no Never-in-a-message detail, and no check's detail holds a
   * piece of any value: as runMessageChecks gives the checks, and as the finalize answer gives them after T-313's scrub
   * (checksWithoutValues, as finalize's index.ts resultOf runs it). The message still blocks.
   */
  const namesOnlyTheSlot = (cases: readonly (readonly [string, readonly SlotValue[], string])[]): void => {
    for (const [text, values, slot] of cases) {
      const parts = textOf(text, values);
      const result = runMessageChecks(parts, contextFor(parts));
      expect(result.blocked, text).toBe(true);
      for (const [when, checks] of [
        ["before the scrub", result.checks],
        ["after the scrub", checksWithoutValues(result.checks, parts.slotValues)],
      ] as const) {
        const detail = (check: CheckOutcome["check"]): string | null =>
          checks.find((outcome) => outcome.check === check)?.detail ?? null;
        expect(detail("values"), `${text} (${when})`).toBe(glued(slot));
        expect(detail("neverInMessage"), `${text} (${when})`).toBeNull();
        for (const outcome of checks) {
          for (const piece of piecesOf(values)) {
            expect(outcome.detail ?? "", `${text} (${when}): ${outcome.check}`).not.toContain(piece);
          }
        }
      }
    }
  };

  it("a value nested in a longer glued value keeps the longer value's place: the detail names its slot, before and after T-313's scrub", () => {
    const chair: SlotValue = { slot: "visit.place", value: "Riley's chair, 88 Elm St, Springfield" };
    const askBy: SlotValue = { slot: "ask.by", value: "11:00am Sat" };
    const change: SlotValue = { slot: "change.when", value: "Sat Oct 24, 2–3pm" };
    namesOnlyTheSlot([
      // biz.name inside visit.place, the place glued on its right (the A6-14 confirmation fills both).
      [
        "Riley can see you Sat Oct 24 at 11:00am. Your visit is at Lee's Barbershop, 88 Elm St, Springfieldx.",
        [...VISIT, BIZ_NAME, SHOP_PLACE],
        "visit.place",
      ],
      // pro.name inside visit.place.
      ["Your visit is at Riley's chair, 88 Elm St, Springfieldx.", [RILEY, chair], "visit.place"],
      // visit.time inside ask.by, glued.
      ["Riley can see you Sat Oct 24 at 11:00am. Please reply by 11:00am Satx.", [...VISIT, askBy], "ask.by"],
      // day inside change.when, glued.
      ["Riley moved your visit to Sat Oct 24, 2–3pmx.", [RILEY, DAY, change], "change.when"],
    ]);
  });

  it("an unclosed '{{foo' glued before a value takes none of its place away: the detail names its slot (note a)", () => {
    namesOnlyTheSlot([
      ["Your visit is at {{foo88 Elm St, Springfieldx.", [PLACE], "visit.place"],
      ["Please reply by {{foo11:00am Satx.", [{ slot: "ask.by", value: "11:00am Sat" }], "ask.by"],
    ]);
  });

  it("reads the same words as before: what is left is withoutInserted's and markOut's, each character where it stood", () => {
    const quote: SlotValue = { slot: "relay.quote", value: "3pm" };
    const cases: [string, readonly string[], readonly SlotValue[]][] = [
      [confirmation, [], finalTwoSends.slotValues],
      [`${OPENER} Riley says yes.\n${OPT_OUT_LINE}`, [OPENER, OPT_OUT_LINE], [RILEY]],
      ["Riley can do 3pm.\nAlex M. asks: 3pm", [], [RILEY, ALEX, quote]],
      ["It costs $40.00, or $40 at the chair.", [], [PRICE]],
      ["Ask Alex M. today. Alex M.x is out.", [], [ALEX]],
      ["Your visit is at Lee's Barbershop, 88 Elm St, Springfieldx.", [], [BIZ_NAME, SHOP_PLACE]],
    ];
    for (const [text, inserted, values] of cases) {
      const filled = filledOf(textOf(text, values));
      const own = markOutIn(withoutInsertedIn(readingOf(text), inserted), filled, " ");
      expect(own.text, text).toBe(markOut(withoutInserted(text, inserted), filled, " "));
      expect(own.at, text).toHaveLength(own.text.length);
      for (let index = 0; index < own.text.length; index += 1) {
        const stood = own.at[index] ?? -1;
        if (stood >= 0)
          expect(text.charAt(stood), `${text} at ${String(index)}`).toBe(own.text.charAt(index));
      }
    }
  });
});
