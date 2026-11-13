// Tests of the composer's relays, translation, sensitive work, tone tags and language (T-375, C-118). Offline, as every
// AI test (J-02: no live call; CI makes none). K-03's plans come through the message-plan contract loader (T-1071, the
// composer's side of T-004's fixture loader), and each model answer is the recorded-model double's where it holds one
// (A7-12's relay with a private part, A6-15's sensitive work), else a K-03 v1 plan written in test-support.ts and
// accepted by the same loader; each is sent back through the AI gateway (T-361) by T-364's fake Messages API with its
// prompt cache. The global fetch fails the file if anything reaches it. What a reader would read is the action layer's
// own slot filler (T-310) over the plan, with the facts the record would give it. Names and values are the master's
// sample cast and fixture set v1's therapist demo shop (rule 9).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SECURE_PAGE_WORDS } from "../../../../actions/src/finalize/claim-check";
import { fillPlan, initials, type SlotSource } from "../../../../actions/src/finalize/slots";
import type { FakeCachingApi } from "../../cache/test-support";
import { HAIKU_MODEL } from "../../gateway";
import {
  loadPlanContract,
  loadRecordedDouble,
  type JsonObject,
  type PlanContract,
  type RecordedDouble,
} from "../../recorded-double";
import { openTrace } from "../../../../runtime/src/trace";
import type { ComposeAnswer, ComposeInput, MessagePlan } from "../index";
import { COMPOSER_PROMPT_TEXT, COMPOSER_PROMPT_VERSION } from "../prompt";
import { GATEWAY_BUNDLE, KEY, composerOn, fakeComposerApi, recordedInput } from "../test-support";
import {
  PRIVATE_DETAIL,
  PRIVATE_TAGS,
  QUOTE_SLOT,
  SECURE_PAGE_READING,
  quoteOf,
  quoteProblems,
  sensitiveProblems,
} from "./index";
import {
  DELETED_PLAN,
  ENGLISH_PLAN,
  ENGLISH_QUOTE,
  ENGLISH_TEXT,
  PRIVATE_RELAY,
  PRIVATE_WORDS_REPLY,
  RELAY_INTO_ENGLISH,
  RELAY_INTO_SPANISH,
  SENSITIVE,
  SENSITIVE_REMINDER,
  SENSITIVE_SOURCE,
  SENSITIVE_WITH_SAMPLES,
  SPANISH_PLAN,
  SPANISH_QUOTE,
  SPANISH_TEXT,
  STORED_SPANISH,
  TRANSLATED_INTO_ENGLISH,
  TRANSLATED_INTO_SPANISH,
  YOUR_VISIT_PLAN,
  withLine,
  withQuestion,
} from "./test-support";

const globalFetch = vi.fn(() => {
  throw new Error("no network in a relay test: the global fetch was called");
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

const k03 = (file: string): MessagePlan => contract.fixtures.read(file) as MessagePlan;

/** One row composed, the fake model answering `plan`, or the recorded double's own plan for the row when none is given. */
async function composeRow(
  input: ComposeInput,
  plan?: MessagePlan,
): Promise<{ answer: ComposeAnswer; api: FakeCachingApi }> {
  const answer = plan ?? (await double.composer(input as unknown as JsonObject));
  const api = fakeComposerApi([{ input, plan: answer }]);
  return { answer: await composerOn(api.fetch).compose(input), api };
}

function planOf(answer: ComposeAnswer): MessagePlan {
  if (answer.status !== "ok") throw new Error(`expected a plan, got ${answer.status}`);
  return answer.plan;
}

/** The row's tagged input as the model read it: the first call's user message. */
function turnOf(api: FakeCachingApi): string {
  const messages = api.calls[0]?.body.messages as { content: string }[] | undefined;
  return messages?.[0]?.content ?? "";
}

/** The plan refused before it leaves the AI layer, for exactly these problems. */
const refusedFor = (problems: { check: string; at: string }[]): unknown => ({
  status: "refused",
  stage: "plan",
  problems,
  modelCalls: expect.any(Array) as unknown,
});

/** The value a row gives a slot fact. */
function factOf(input: ComposeInput, slot: string): string | undefined {
  for (const fact of input.facts) if ("slot" in fact && fact.slot === slot) return fact.value;
  return undefined;
}

/** How many {{relay.quote}} slots each words field of a plan writes, by place, where there is one. */
function quoteSlotsOf(plan: MessagePlan): string[] {
  const fields = [
    ...plan.lines.map((line, k) => [`lines[${String(k)}].text`, line.text] as const),
    ...(plan.question === null ? [] : [["question.text", plan.question.text] as const]),
  ];
  return fields.flatMap(([at, text]) =>
    text
      .split(`{{${QUOTE_SLOT}`)
      .slice(1)
      .map(() => at),
  );
}

/** What the reader would read: the plan's words filled by the action layer's own slot filler (T-310). */
function readerReads(plan: MessagePlan, source: SlotSource): string[] {
  const filled = fillPlan(plan, source);
  if (!filled.ok) throw new Error(`the plan does not fill: ${filled.problems.map((p) => p.slot).join(", ")}`);
  return [
    ...filled.lines.map((line) => line.text),
    ...(filled.question === null ? [] : [filled.question.text]),
  ];
}

/** The filler's source for a relay to staff: Alex's name and the quote as limit 7 gave it. */
const relaySource = (quote: string): SlotSource => ({
  ...SENSITIVE_SOURCE,
  sensitive: false,
  facts: { customerName: "Alex M.", relayQuote: quote, links: { secure: "https://rosfield.com/v/s03" } },
});

describe("a relayed sender is quoted in a code-filled slot (arch 07 line 359; A7-12; CQ-109)", () => {
  it("plan-relay-private-a7-12.json is reproduced with the quote in a slot: the double's plan for A7-12's relay to Riley comes back word for word, quoting Alex only through {{relay.quote}}, once, which the row gives as limit 7's 'Read it on the secure page'; no word of the sample quote is typed, and Riley reads the private part only as that reading", async () => {
    const { answer, api } = await composeRow(PRIVATE_RELAY);
    expect(answer).toMatchObject({
      status: "ok",
      model: HAIKU_MODEL,
      role: "haiku",
      attempt: 1,
      fallback: false,
    });
    const plan = planOf(answer);
    expect(plan).toEqual(k03("plan-relay-private-a7-12.json"));
    expect(api.calls).toHaveLength(1);

    // The quote is in its slot, once, in the first line beside the sender's slot.
    expect(quoteSlotsOf(plan)).toEqual(["lines[0].text"]);
    expect(plan.lines[0]?.text).toBe("{{alex.staff}} asks: {{relay.quote}}");
    expect(quoteProblems(plan, PRIVATE_RELAY)).toEqual([]);
    // The row gives the quote as limit 7's reading of a private part: the claim check's own words.
    expect(SECURE_PAGE_READING).toBe(SECURE_PAGE_WORDS);
    expect(quoteOf(PRIVATE_RELAY)).toBe(SECURE_PAGE_WORDS);
    expect(turnOf(api)).toContain(`<fact slot="relay.quote">${SECURE_PAGE_WORDS}</fact>`);

    // The master line's sample quote (a child's details: private) is an example code replaces; the plan types none of it.
    const sample = "Can my son wait in the shop during my cut?";
    expect(PRIVATE_RELAY.masterText.text).toContain(`{{relay.quote:${sample}}}`);
    const planWords = JSON.stringify(plan);
    for (const words of ["my son", "wait in the shop", "during my cut"])
      expect(planWords).not.toContain(words);

    // What Riley reads, filled by the action layer's own filler: the sender named, the private part only as the reading.
    const read = readerReads(plan, relaySource(SECURE_PAGE_WORDS));
    expect(read[0]).toBe(`Alex M. asks: ${SECURE_PAGE_WORDS}`);
    expect(read.join("\n")).not.toMatch(/my son|wait in the shop|during my cut/u);
  });

  it("a plan that does not quote the sender through the slot, once, is refused before it leaves the AI layer, naming the check and the place, never the words", async () => {
    const plan = await double.composer(PRIVATE_RELAY as unknown as JsonObject);
    const recorded = plan as unknown as MessagePlan;
    const cases: [string, ComposeInput, MessagePlan, { check: string; at: string }[]][] = [
      [
        "the sample quote typed in place of the slot",
        PRIVATE_RELAY,
        withLine(recorded, 0, "{{alex.staff}} asks: Can my son wait in the shop during my cut?"),
        [
          { check: "relayQuote", at: "lines[0].text" },
          { check: "relayQuote", at: "(root)" },
        ],
      ],
      [
        "a part of it typed beside the slot",
        PRIVATE_RELAY,
        withLine(recorded, 0, "{{alex.staff}} asks if my son can wait in the shop: {{relay.quote}}"),
        [{ check: "relayQuote", at: "lines[0].text" }],
      ],
      [
        "the quote left out",
        PRIVATE_RELAY,
        withLine(recorded, 0, "{{alex.staff}} has a question."),
        [{ check: "relayQuote", at: "(root)" }],
      ],
      [
        "the quote twice (CQ-109)",
        PRIVATE_RELAY,
        withQuestion(recorded, "Your answer for {{alex.staff}}: {{relay.quote}}?"),
        [{ check: "relayQuote", at: "question.text" }],
      ],
      [
        "a quote slot on a row whose reader may see no quote",
        { ...PRIVATE_RELAY, facts: [{ slot: "alex.staff", value: "Alex M." }] },
        recorded,
        [{ check: "relayQuote", at: "lines[0].text" }],
      ],
    ];
    for (const [what, input, variant, problems] of cases) {
      expect(contract.validate("plan", variant), what).toEqual([]);
      const { answer, api } = await composeRow(input, variant);
      expect(answer, what).toEqual(refusedFor(problems));
      expect(api.calls, what).toHaveLength(1);
      expect(JSON.stringify(answer), what).not.toMatch(/son|shop|cut|Alex/u);
    }
  });
});

describe("translated, with the original kept (S13-37: 'Messages to and from staff are translated, with the original kept')", () => {
  it("a relay into English keeps the original quote: Alex's Spanish words reach Riley through {{relay.quote}}, as written, with the model's English beside them; a plan that drops the original, types it, or gives it again as the translation is refused", async () => {
    expect(contract.validate("composeInput", RELAY_INTO_ENGLISH)).toEqual([]);
    expect(contract.validate("plan", TRANSLATED_INTO_ENGLISH)).toEqual([]);
    const { answer, api } = await composeRow(RELAY_INTO_ENGLISH, TRANSLATED_INTO_ENGLISH);
    const plan = planOf(answer);
    expect(plan).toEqual(TRANSLATED_INTO_ENGLISH);
    expect(quoteSlotsOf(plan)).toEqual(["lines[0].text"]);

    // The model read the quote as Alex wrote it, and the reader's language as code chose it.
    const turn = turnOf(api);
    expect(turn).toContain(`<fact slot="relay.quote">${SPANISH_QUOTE}</fact>`);
    expect(turn).toContain("<language>en</language>");

    // What Riley reads: the original, word for word, in its slot, and the translation in the model's own words.
    const read = readerReads(plan, relaySource(SPANISH_QUOTE));
    expect(read).toEqual([
      `Alex M. asks, in Spanish: ${SPANISH_QUOTE}`,
      "In English, they ask whether there is parking near the shop.",
      "Your answer for Alex M.?",
    ]);

    const cases: [string, MessagePlan, { check: string; at: string }[]][] = [
      [
        "the translation alone, the original dropped",
        {
          ...TRANSLATED_INTO_ENGLISH,
          lines: [{ role: "first", text: "{{alex.staff}} asks whether there is parking near the shop." }],
        },
        [{ check: "relayQuote", at: "(root)" }],
      ],
      [
        "the original typed in place of its slot",
        withLine(TRANSLATED_INTO_ENGLISH, 0, `{{alex.staff}} asks, in Spanish: ${SPANISH_QUOTE}`),
        [
          { check: "relayQuote", at: "lines[0].text" },
          { check: "relayQuote", at: "(root)" },
          { check: "language", at: "lines[0].text" },
        ],
      ],
      [
        "the original given again as the translation",
        withLine(TRANSLATED_INTO_ENGLISH, 1, `In English: ${SPANISH_QUOTE}`),
        [
          { check: "relayQuote", at: "lines[1].text" },
          { check: "language", at: "lines[1].text" },
        ],
      ],
    ];
    for (const [what, variant, problems] of cases) {
      expect(contract.validate("plan", variant), what).toEqual([]);
      const refused = await composeRow(RELAY_INTO_ENGLISH, variant);
      expect(refused.answer, what).toEqual(refusedFor(problems));
      expect(JSON.stringify(refused.answer), what).not.toMatch(/estacionamiento|parking|tienda/u);
    }
  });

  it("a relay into Spanish keeps the English original the same way: the model's Spanish beside it, and a 'translation' left in English is refused for its language", async () => {
    expect(contract.validate("composeInput", RELAY_INTO_SPANISH)).toEqual([]);
    expect(contract.validate("plan", TRANSLATED_INTO_SPANISH)).toEqual([]);
    const { answer, api } = await composeRow(RELAY_INTO_SPANISH, TRANSLATED_INTO_SPANISH);
    const plan = planOf(answer);
    expect(plan).toEqual(TRANSLATED_INTO_SPANISH);
    expect(turnOf(api)).toContain("<language>es</language>");
    const read = readerReads(plan, relaySource(ENGLISH_QUOTE));
    expect(read[0]).toBe(`Alex M. pregunta, en inglés: ${ENGLISH_QUOTE}`);
    expect(read[1]).toBe("En español: pregunta si puede llevar a su perro a la visita.");

    const untranslated = withLine(plan, 1, "In English, they ask if they can bring their dog.");
    const refused = await composeRow(RELAY_INTO_SPANISH, untranslated);
    expect(refused.answer).toEqual(refusedFor([{ check: "language", at: "lines[1].text" }]));
  });
});

describe("the language of the text, else the stored language (arch 06 line 341; S13-24 rule 12)", () => {
  it("a Spanish text gets a Spanish plan: Alex's Spanish text reaches the model as <inbound> with <language>es</language>, the Spanish plan passes, and the same row answered in English is refused for its language, line by line", async () => {
    expect(contract.validate("composeInput", SPANISH_TEXT)).toEqual([]);
    expect(SPANISH_TEXT.language).toBe("es");
    const { answer, api } = await composeRow(SPANISH_TEXT, SPANISH_PLAN);
    expect(planOf(answer)).toEqual(SPANISH_PLAN);
    const turn = turnOf(api);
    expect(turn).toContain("<language>es</language>");
    expect(turn.endsWith("<inbound>¿Ya respondió la barbería?</inbound>")).toBe(true);

    const english = await composeRow(SPANISH_TEXT, ENGLISH_PLAN);
    expect(english.answer).toEqual(
      refusedFor([
        { check: "language", at: "lines[0].text" },
        { check: "language", at: "lines[2].text" },
      ]),
    );
    expect(english.api.calls).toHaveLength(1);
  });

  it("else the stored language: a row that answers no text is in the reader's stored language (the prompt's own Spanish row, Alex having written in Spanish twice), held the same way", async () => {
    expect(STORED_SPANISH.inbound).toBeNull();
    expect(STORED_SPANISH.conversation.filter((message) => message.from === "reader")).toHaveLength(2);
    const { answer } = await composeRow(STORED_SPANISH, SPANISH_PLAN);
    expect(planOf(answer)).toEqual(SPANISH_PLAN);
    const english = await composeRow(STORED_SPANISH, ENGLISH_PLAN);
    expect(english.answer).toEqual(
      refusedFor([
        { check: "language", at: "lines[0].text" },
        { check: "language", at: "lines[2].text" },
      ]),
    );
  });

  it("an English text gets an English plan: the same wait texted in English refuses the Spanish plan the same way, whatever was written before", async () => {
    expect(contract.validate("composeInput", ENGLISH_TEXT)).toEqual([]);
    const { answer } = await composeRow(ENGLISH_TEXT, ENGLISH_PLAN);
    expect(planOf(answer)).toEqual(ENGLISH_PLAN);
    const spanish = await composeRow(ENGLISH_TEXT, SPANISH_PLAN);
    expect(spanish.answer).toEqual(
      refusedFor([
        { check: "language", at: "lines[0].text" },
        { check: "language", at: "lines[2].text" },
      ]),
    );
  });
});

describe("sensitive work: 'your visit', no service, initials (S13-22; RULES 4.6)", () => {
  it("plan-sensitive.json: no service name appears; staff see initials. The double's plan for A6-15's new booking to Maya comes back word for word; the row gives Alex as initials and the service as nothing, so the model reads neither, the plan names them only through their slots, and Maya reads 'A.M.' and no service, filled with the switch on from a record that holds both", async () => {
    const { answer, api } = await composeRow(SENSITIVE);
    const plan = planOf(answer);
    expect(plan).toEqual(k03("plan-sensitive.json"));
    expect(SENSITIVE.situation).toBe("gentle");

    // Limit 7's sensitive forms (K-03 slots.json): initials for alex.staff, nothing for svc.intext.
    expect(factOf(SENSITIVE, "alex.staff")).toBe(initials("Alex M."));
    expect(factOf(SENSITIVE, "alex.staff")).toBe("A.M.");
    expect(factOf(SENSITIVE, "svc.intext")).toBe("");
    const turn = turnOf(api);
    for (const words of ["First session", "Alex", "session"]) expect(turn).not.toContain(words);

    // The plan names the service and the customer only through their slots.
    expect(plan.lines[0]?.text).toBe(
      "New booking: {{alex.staff}} · {{svc.intext:First session}} · {{day}} · {{visit.time}}",
    );
    expect(sensitiveProblems(plan, SENSITIVE)).toEqual([]);

    // What Maya reads, filled by the action layer's own filler with the sensitive switch on.
    const read = readerReads(plan, SENSITIVE_SOURCE).join("\n");
    expect(SENSITIVE_SOURCE.facts.serviceName).toBe("First session");
    expect(read).toContain("A.M.");
    for (const words of ["First session", "session", "Alex"]) expect(read).not.toContain(words);
  });

  it("on sensitive work a plan that names the service or the customer outside their slots is refused: the sample service typed, the whole name or the first name typed, or a service slot given words of its own after '|', which the filler would write in place of the service; the master line's own words after '|' are kept", async () => {
    const recorded = k03("plan-sensitive.json");
    const ok = await composeRow(SENSITIVE_WITH_SAMPLES, recorded);
    expect(planOf(ok.answer)).toEqual(recorded);

    const cases: [string, string][] = [
      ["the sample service typed", "New booking: {{alex.staff}} · First session · {{day}} · {{visit.time}}"],
      ["the whole name typed", "New booking: Alex M. · {{svc.intext}} · {{day}} · {{visit.time}}"],
      ["the first name typed", "New booking for Alex: {{svc.intext}} · {{day}} · {{visit.time}}"],
      [
        "words of its own after '|'",
        "New booking: {{alex.staff}} · {{svc.intext|therapy}} · {{day}} · {{visit.time}}",
      ],
    ];
    for (const [what, text] of cases) {
      const variant = withLine(recorded, 0, text);
      expect(contract.validate("plan", variant), what).toEqual([]);
      const { answer } = await composeRow(SENSITIVE_WITH_SAMPLES, variant);
      expect(answer, what).toEqual(refusedFor([{ check: "sensitiveWork", at: "lines[0].text" }]));
      expect(JSON.stringify(answer), what).not.toMatch(/session|therapy|Alex/u);
    }
    // Why the words after '|' matter: under the switch the filler writes them in place of the service.
    const own = withLine(
      recorded,
      0,
      "New booking: {{alex.staff}} · {{svc.intext|therapy}} · {{day}} · {{visit.time}}",
    );
    expect(readerReads(own, SENSITIVE_SOURCE)[0]).toContain("therapy");
    // The master line's own words after '|' ("visit") are the step's, so they stand.
    const masters = withLine(
      recorded,
      0,
      "New booking: {{alex.staff}} · {{svc.intext|visit}} · {{day}} · {{visit.time}}",
    );
    const kept = await composeRow(SENSITIVE_WITH_SAMPLES, masters);
    expect(planOf(kept.answer)).toEqual(masters);
    expect(readerReads(masters, SENSITIVE_SOURCE)[0]).toContain("· visit ·");
  });

  it("writes sensitive work as 'your visit': A7-01's reminder to Alex on sensitive work says 'your visit' and names no service, and a plan that types the shop's sample service there is refused", async () => {
    expect(contract.validate("composeInput", SENSITIVE_REMINDER)).toEqual([]);
    expect(contract.validate("plan", YOUR_VISIT_PLAN)).toEqual([]);
    const { answer } = await composeRow(SENSITIVE_REMINDER, YOUR_VISIT_PLAN);
    expect(planOf(answer)).toEqual(YOUR_VISIT_PLAN);
    const read = readerReads(YOUR_VISIT_PLAN, SENSITIVE_SOURCE);
    expect(read[0]).toContain("your visit");
    expect(read.join("\n")).not.toContain("First session");

    const named = withLine(
      YOUR_VISIT_PLAN,
      0,
      "Reminder: your First session is {{day}} at {{visit.time}} with {{pro.name}}.",
    );
    const refused = await composeRow(SENSITIVE_REMINDER, named);
    expect(refused.answer).toEqual(refusedFor([{ check: "sensitiveWork", at: "lines[0].text" }]));
  });
});

describe("tone follows code's situation tag (arch 07 line 357)", () => {
  it("a 'grief or safety' tag gives no '!': the gentle tag reaches the model as code set it, the double's gentle plan has none, and a '!' or '¡' in the model's own words on a gentle row is refused, field by field; the same '!' on a money-or-consent row is that tag's to allow", async () => {
    const gentle = await composeRow(SENSITIVE);
    expect(turnOf(gentle.api)).toContain("<situation>gentle</situation>");
    const sensitivePlan = planOf(gentle.answer);
    expect(JSON.stringify(sensitivePlan)).not.toMatch(/[!¡]/u);

    const sensitiveCases: [MessagePlan, string][] = [
      [withLine(sensitivePlan, 0, `${sensitivePlan.lines[0]?.text ?? ""}!`), "lines[0].text"],
      [withLine(sensitivePlan, 1, "The details are on the secure page! {{link.secure}}"), "lines[1].text"],
    ];
    for (const [variant, at] of sensitiveCases) {
      const { answer } = await composeRow(SENSITIVE, variant);
      expect(answer, at).toEqual(refusedFor([{ check: "tone", at }]));
    }

    // A6-14's confirmation row as C-090 tags it in a turn with a safety outcome other than No: gentle.
    const confirmation = recordedInput("confirmation-a6-14");
    expect(confirmation.situation).toBe("moneyOrConsent");
    const grief: ComposeInput = { ...confirmation, situation: "gentle" };
    const plan = k03("plan-confirmation-a6-14.json");
    expect(planOf((await composeRow(grief, plan)).answer)).toEqual(plan);
    const exclaimed = withLine(
      plan,
      0,
      "You're booked at {{biz.name}}! Give this code at the chair when you arrive: {{visit.code}}",
    );
    expect((await composeRow(grief, exclaimed)).answer).toEqual(
      refusedFor([{ check: "tone", at: "lines[0].text" }]),
    );
    expect(planOf((await composeRow(confirmation, exclaimed)).answer)).toEqual(exclaimed);

    // In Spanish, "¡" opens one.
    const gentleSpanish: ComposeInput = { ...SPANISH_TEXT, situation: "gentle" };
    expect(planOf((await composeRow(gentleSpanish, SPANISH_PLAN)).answer)).toEqual(SPANISH_PLAN);
    const opened = withLine(SPANISH_PLAN, 0, "¡{{biz.name}} aún no ha respondido a tu solicitud.");
    expect((await composeRow(gentleSpanish, opened)).answer).toEqual(
      refusedFor([{ check: "tone", at: "lines[0].text" }]),
    );
  });
});

describe("private words reach the model only as 'a private detail' (arch 07 line 397; RULES 4.5)", () => {
  it("a reply to its sender: <inbound> and <conversation> give each private part as 'a private detail', the row read's own and the edge scrub's [card number] and [SSN] alike, and nothing else of them changes; the row's input keeps its words", async () => {
    expect(contract.validate("composeInput", PRIVATE_WORDS_REPLY)).toEqual([]);
    expect(contract.validate("plan", DELETED_PLAN)).toEqual([]);
    const { answer, api } = await composeRow(PRIVATE_WORDS_REPLY, DELETED_PLAN);
    expect(planOf(answer)).toEqual(DELETED_PLAN);

    const turn = turnOf(api);
    expect(turn).toContain(`<inbound>Here's my card for Saturday: ${PRIVATE_DETAIL}</inbound>`);
    expect(turn).toContain(
      `<message from="reader">My SSN is ${PRIVATE_DETAIL} if the shop needs it.</message>`,
    );
    expect(turn).toContain(`<message from="reader">Is ${PRIVATE_DETAIL} a problem for my cut?</message>`);
    expect(turn).toContain('<message from="rosie">Riley will go over it at your visit.</message>');
    expect(PRIVATE_TAGS).toEqual(["[card number]", "[SSN]"]);
    for (const tag of PRIVATE_TAGS) expect(JSON.stringify(api.calls)).not.toContain(tag);
    // Only what the model reads changes: the row's input keeps the row read's words.
    expect(PRIVATE_WORDS_REPLY.inbound?.text).toBe("Here's my card for Saturday: [card number]");
  });

  it("a relay's quote too: a tagged part of the quote reads 'a private detail' to the model, and the plan still quotes it only through its slot", async () => {
    const quote = "Can I pay with [card number] at the visit?";
    const tagged: ComposeInput = {
      ...RELAY_INTO_ENGLISH,
      facts: [
        { slot: "alex.staff", value: "Alex M." },
        { slot: "relay.quote", value: quote },
      ],
    };
    const plan: MessagePlan = {
      ...TRANSLATED_INTO_ENGLISH,
      lines: [{ role: "first", text: "{{alex.staff}} asks: {{relay.quote}}" }],
    };
    const { answer, api } = await composeRow(tagged, plan);
    expect(planOf(answer)).toEqual(plan);
    expect(turnOf(api)).toContain(
      `<fact slot="relay.quote">Can I pay with ${PRIVATE_DETAIL} at the visit?</fact>`,
    );
    expect(JSON.stringify(api.calls)).not.toContain("[card number]");
  });
});

describe("the composer prompt says what these checks hold a plan to (composer-4)", () => {
  it("rule 8: no '!' or '¡' when gentle; rule 9: a relay quoted once through its slot, translated into <language> beside the original; rule 11: no words after '|' in a service slot but the master line's; the language rule: every word of the model's own in <language>; <conversation>: private words as 'a private detail'", () => {
    expect(COMPOSER_PROMPT_VERSION).toBe("composer-4");
    const rule = (n: number): string =>
      COMPOSER_PROMPT_TEXT.split("\n").find((line) => line.startsWith(`${String(n)}. `)) ?? "";
    expect(rule(8)).toContain(
      'gentle, for grief, safety or sensitive work: soft and plain, with no "!" or "¡"',
    );
    expect(rule(9)).toContain("quotes them only through {{relay.quote}}, once");
    expect(rule(9)).toContain(
      "keep {{relay.quote}} as the original and add a fact line with your translation of them into <language>",
    );
    expect(rule(11)).toContain('In a service slot, write words after "|" only as <master_text> gives them');
    expect(COMPOSER_PROMPT_TEXT).toContain(
      "Every word of your own is in <language>; only slots, <term>s and a relay's original quote keep their own words.",
    );
    expect(COMPOSER_PROMPT_TEXT).toContain(`Private words in them read "${PRIVATE_DETAIL}".`);
  });
});

describe("never a word of the row or the plan in a refusal, a span or a log line (K-08 README line 75)", () => {
  it("the reader's refusals name the check and the place: no quote, service, name or plan words, and no key, reach a refusal, the trace or the console", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method));
    try {
      const trace = openTrace({
        openedBy: "textWebhook",
        bundleId: GATEWAY_BUNDLE.bundleId,
        handleRef: "handle-1",
      });
      const rows: [ComposeInput, MessagePlan][] = [
        [RELAY_INTO_ENGLISH, withLine(TRANSLATED_INTO_ENGLISH, 0, `{{alex.staff}} asks: ${SPANISH_QUOTE}`)],
        [
          SENSITIVE_WITH_SAMPLES,
          withLine(k03("plan-sensitive.json"), 0, "New booking: Alex M. · First session"),
        ],
        [SPANISH_TEXT, ENGLISH_PLAN],
        [
          SENSITIVE,
          withLine(k03("plan-sensitive.json"), 1, "The details are on the secure page! {{link.secure}}"),
        ],
      ];
      const answers: ComposeAnswer[] = [];
      for (const [input, plan] of rows) {
        const api = fakeComposerApi([{ input, plan }]);
        answers.push(await composerOn(api.fetch).compose(input, { trace }));
      }
      for (const answer of answers) expect(answer.status).toBe("refused");
      const seen = JSON.stringify(trace.toTrace()) + JSON.stringify(answers);
      const words = [
        SPANISH_QUOTE,
        "estacionamiento",
        "Alex M.",
        "First session",
        "hasn't answered your request",
        "The details are on the secure page",
        ...rows.flatMap(([, plan]) => plan.lines.map((line) => line.text)),
        KEY,
      ];
      for (const text of words) expect(seen).not.toContain(text);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
