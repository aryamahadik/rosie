// Tests of the reader's checks themselves (T-375, C-118): each held to its source, and to every plan the composer's own
// sources hold. Offline: K-03's fixtures through the message-plan contract loader (T-1071), the recorded-model double's
// plans read directly (no model call is made, and the global fetch fails the file if anything reaches it). Names and
// values are the master's sample cast (rule 9).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SECURE_PAGE_WORDS } from "../../../../actions/src/finalize/claim-check";
import {
  loadPlanContract,
  loadRecordedDouble,
  type JsonObject,
  type PlanContract,
  type RecordedDouble,
} from "../../recorded-double";
import { CARD_TAG, SSN_TAG } from "../../../../runtime/src/scrub/scrub";
import { planAgainstInput } from "../check";
import { COMPOSER_EXAMPLES, type ComposeInput, type MessagePlan } from "../prompt";
import { RECORDED_INPUTS, recordedInput, v1dot1Fixture } from "../test-support";
import {
  CODE_READINGS,
  EXCLAMATION,
  LEAST_OTHER_WORDS,
  PERSON_SLOTS,
  PRIVATE_DETAIL,
  PRIVATE_TAGS,
  SECURE_PAGE_READING,
  SERVICE_SLOTS,
  SMALL_WORDS,
  gentleRow,
  isCodeReading,
  quoteProblems,
  readerProblems,
  serviceHidden,
  smallWordCounts,
  withPrivateDetails,
} from "./index";
import { PRIVATE_RELAY, SENSITIVE, SPANISH_TEXT, withLine } from "./test-support";
import { ownWords, planFields, termWords, wordsOf } from "./words";

const globalFetch = vi.fn(() => {
  throw new Error("no network in a reader check test: the global fetch was called");
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

/** One slot of K-03's vocabulary, as slots.json writes it. */
interface Slot {
  readonly name: string;
  readonly sensitiveForm: string;
}

describe("each check is held to its source", () => {
  it("the service and name slots are K-03's own: emptyOrAlternate and initials in slots.json", () => {
    const slots = (contract.fixtures.read("slots.json") as { slots: Slot[] }).slots;
    const withForm = (form: string): string[] =>
      slots.filter((slot) => slot.sensitiveForm === form).map((slot) => slot.name);
    expect([...SERVICE_SLOTS].sort()).toEqual(withForm("emptyOrAlternate").sort());
    expect([...PERSON_SLOTS].sort()).toEqual(withForm("initials").sort());
  });

  it("the secure-page reading is the claim check's own words, and code's readings are never read as a sender's words, with or without their stop", () => {
    expect(SECURE_PAGE_READING).toBe(SECURE_PAGE_WORDS);
    for (const reading of CODE_READINGS) {
      expect(isCodeReading(reading), reading).toBe(true);
      expect(isCodeReading(`${reading}.`), reading).toBe(true);
    }
    expect(isCodeReading("Can I bring my dog to the visit?")).toBe(false);
  });

  it("the private tags are the edge scrub's own (K-06 v1 default 1), and only they change: each reads 'a private detail', the rest as it is", () => {
    expect(PRIVATE_TAGS).toEqual([CARD_TAG, SSN_TAG]);
    expect(withPrivateDetails(`Card ${CARD_TAG}, SSN ${SSN_TAG}, card ${CARD_TAG} 123`)).toBe(
      `Card ${PRIVATE_DETAIL}, SSN ${PRIVATE_DETAIL}, card ${PRIVATE_DETAIL} 123`,
    );
    const plain = "Hi, I want to put my barbershop on Rosie [card]";
    expect(withPrivateDetails(plain)).toBe(plain);
  });

  it("the small words: none is both English and Spanish, each is a word as the checks read words, and the two that both write most ('a', 'no') are in neither", () => {
    for (const word of SMALL_WORDS.en) expect(SMALL_WORDS.es.has(word), word).toBe(false);
    for (const language of ["en", "es"] as const)
      for (const word of SMALL_WORDS[language]) expect(wordsOf(word), word).toEqual([word]);
    for (const shared of ["a", "no", "me", "son", "he", "has", "solo"])
      expect(SMALL_WORDS.en.has(shared) || SMALL_WORDS.es.has(shared), shared).toBe(false);
    expect(LEAST_OTHER_WORDS).toBe(2);
  });

  it("an exclamation mark in each of its forms, a question mark none", () => {
    for (const mark of ["!", "¡", "！", "‼"]) expect(EXCLAMATION.test(`Booked${mark}`), mark).toBe(true);
    for (const mark of ["?", "¿", "."]) expect(EXCLAMATION.test(`Booked${mark}`), mark).toBe(false);
  });

  it("a gentle row is the tag's, or one whose service limit 7 gave as nothing, whatever its tag", () => {
    expect(gentleRow(SENSITIVE)).toBe(true);
    expect(serviceHidden(SENSITIVE)).toBe(true);
    const routine: ComposeInput = { ...SENSITIVE, situation: "routine" };
    expect(gentleRow(routine)).toBe(true);
    const shown: ComposeInput = {
      ...routine,
      facts: routine.facts.map((fact) =>
        "slot" in fact && fact.slot === "svc.intext" ? { ...fact, value: "First session" } : fact,
      ),
    };
    expect(serviceHidden(shown)).toBe(false);
    expect(gentleRow(shown)).toBe(false);
    expect(gentleRow(PRIVATE_RELAY)).toBe(false);
  });
});

describe("every plan the composer's own sources hold keeps to its reader", () => {
  it("the prompt's five worked examples, each against its own input: no problem at any stage", () => {
    for (const example of COMPOSER_EXAMPLES) {
      expect(readerProblems(example.plan, example.input), example.title).toEqual([]);
      expect(planAgainstInput(example.plan, example.input), example.title).toEqual([]);
    }
  });

  it("the recorded double's plans, each against the input it is recorded for, and S1-02's plan against input-s1-02's K-03 v1.1 twin", async () => {
    for (const name of RECORDED_INPUTS) {
      const input = recordedInput(name);
      const plan = await double.composer(input as unknown as JsonObject);
      expect(planAgainstInput(plan, input), name).toEqual([]);
    }
    const twin = v1dot1Fixture("input-s1-02-v1.1.json") as ComposeInput;
    expect(planAgainstInput(contract.fixtures.read("plan-s1-02.json"), twin)).toEqual([]);
  });

  it("each example reads in its own language: the Spanish one has more Spanish small words, the four English ones more English", () => {
    for (const example of COMPOSER_EXAMPLES) {
      const terms = termWords(example.input);
      const words = planFields(example.plan).flatMap((field) => wordsOf(ownWords(field.text, terms)));
      const counts = smallWordCounts(words);
      if (example.input.language === "es") expect(counts.es, example.title).toBeGreaterThan(counts.en);
      else expect(counts.en, example.title).toBeGreaterThanOrEqual(counts.es);
    }
  });
});

describe("the edges of the checks", () => {
  it("Rosie's own terms are never translated, so a Spanish row may state S1-02's English terms word for word; English words of the model's own beside them are refused", () => {
    const twin = v1dot1Fixture("input-s1-02-v1.1.json") as ComposeInput;
    const spanish: ComposeInput = { ...twin, language: "es" };
    const plan: MessagePlan = {
      formats: ["text"],
      lines: [
        { role: "first", text: "Configuraré tu negocio para que los asistentes de IA puedan reservarte." },
        {
          role: "fact",
          text: "About 15 minutes for your first kind of work · Free to use · $2 a booking, counted at its check-in or DONE, explained before you go live",
        },
      ],
      question: { text: "¿Qué tipos de trabajo haces? Escríbelos.", optionIds: [] },
      pageType: null,
      threadReplyTo: null,
    };
    expect(contract.validate("plan", plan)).toEqual([]);
    expect(planAgainstInput(plan, spanish)).toEqual([]);
    const fact = plan.lines[1]?.text ?? "";
    expect(planAgainstInput(withLine(plan, 1, `${fact} · Free setup for you`), spanish)).toEqual([
      { check: "language", at: "lines[1].text" },
    ]);
  });

  it("one small word of the other language, or a field of slots alone, is never read as the other language", () => {
    const plan = withLine(
      contract.fixtures.read("plan-confirmation-a6-14.json") as MessagePlan,
      0,
      "Gracias. You're booked at {{biz.name}}. Give this code at the chair when you arrive: {{visit.code}}",
    );
    expect(readerProblems(plan, recordedInput("confirmation-a6-14"))).toEqual([]);
    const spanishSlots = withLine(plan, 0, "{{biz.name}} · {{visit.code}}");
    expect(
      readerProblems(spanishSlots, { ...recordedInput("confirmation-a6-14"), language: "es" }).filter(
        (problem) => problem.at === "lines[0].text",
      ),
    ).toEqual([]);
  });

  it("a quote of one or two words is too short to tell a copy from the model's own words; one of three is read whole; code's own reading never", () => {
    const relay = (quote: string): ComposeInput => ({
      ...PRIVATE_RELAY,
      masterText: { step: "A7-12", text: "{{alex.staff}} asks: {{relay.quote}}" },
      facts: [
        { slot: "alex.staff", value: "Alex M." },
        { slot: "relay.quote", value: quote },
      ],
    });
    const plan = (first: string): MessagePlan => ({
      formats: ["text"],
      lines: [
        { role: "first", text: first },
        { role: "action", text: "Open the secure page now: {{link.secure}}" },
      ],
      question: null,
      pageType: null,
      threadReplyTo: null,
    });
    expect(
      quoteProblems(plan("{{alex.staff}} says yes please: {{relay.quote}}"), relay("Yes please")),
    ).toEqual([]);
    expect(
      quoteProblems(
        plan("{{alex.staff}} is running late, sorry: {{relay.quote}}"),
        relay("Running late, sorry"),
      ),
    ).toEqual([{ check: "relayQuote", at: "lines[0].text" }]);
    // Crisis words reach staff as code's reading; the plan may point to the secure page in the same words.
    expect(
      quoteProblems(plan("{{alex.staff}}: {{relay.quote}}"), relay("Urgent: open the secure page now")),
    ).toEqual([]);
  });

  it("on a Spanish row the reply's own words are read, never its slots' example words or the quote in its slot", () => {
    const spanish: ComposeInput = {
      ...SPANISH_TEXT,
      masterText: { ...SPANISH_TEXT.masterText, text: "{{biz.name:Lee's Barbershop}} hasn't answered yet." },
    };
    const plan: MessagePlan = {
      formats: ["text"],
      lines: [{ role: "first", text: "{{biz.name:Lee's Barbershop}} aún no ha respondido a tu solicitud." }],
      question: null,
      pageType: null,
      threadReplyTo: null,
    };
    expect(readerProblems(plan, spanish)).toEqual([]);
  });
});
