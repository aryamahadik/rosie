// Compose input's term facts (T-1174; K-09 README v1.6 defaults 137, 138 and 141; K-03 v1.1 termFact; DL-355, DL-359,
// DL-367), through the Tool API base over the fake row reader and K-01 v1's sample bundles. The card's checks: S1-02's
// four card terms, each with its source line word for word (compose-input-s1-02-v1.6.json; the double's recording 4 is
// keyed on them); a card line that names a slot is never a term fact; a card that states no term gives none; the slot
// facts first, then the terms in the card's order. And the lead's: default 137 beyond S1-02 (a card that mixes slotted
// and plain lines, a step with no card), the generic source of gap 126, finalize's `terms` agreeing with compose input
// on S1-02, and the reader addressed by the first word of the name (the seed's "Sam Lee" is "Sam").
// T-1483 (K-09 README v1.11 default 186; DL-999, DL-1048): on bundle v2's S1-08 the term facts are exactly Rosie's four
// fixed lines with their generic sources, each a line of S1-08's card as K-09's rules read a card, and the table is
// K-09's S1_08_TERM_LINES; the agreement line, the first kind's line and the slotted line give none, nor does one of the
// four worded otherwise or at another place; every other step keeps default 137, S1-02's four facts and
// compose-input-s1-02-v1.6.json are unchanged, and K-09's termFactsFromCard and inputIsK03Fixture still pass on it.
// Values come only from the contracts' fixtures, the bundles and the master's sample cast (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { barberSource } from "../finalize/claim-check/test-support";
import { S1_02_TERMS, s102Row as finalizeS102Row } from "../finalize/rewrite/test-support";
import { bundleIdOf, fakeBundles, type BundleDocument } from "../frontier/assemble/test-support";
import { CONTRACTS_DIR } from "../tool-api/validator";
import { S1_02_SOURCES, addressedAs, genericSource, termFactsOf, type ComposeRow } from "./index";
import { S1_08_TERMS, isTermLine, type CardPlace } from "./term-facts";
import {
  a614Step,
  alexRow,
  answerOf,
  bundleV0,
  callComposeInput,
  cardStep,
  inputOf,
  k03Fixture,
  optOutLineOf,
  requestFor,
  s102Exchange,
  s102Row,
  sayOf,
  stepOf,
  withSteps,
} from "./test-support";

type Json = Record<string, unknown>;

/** The facts of the input a call over `row` and `bundle` answers. */
async function factsFor(row: ComposeRow, bundle = bundleV0()): Promise<Json[]> {
  const input = inputOf(
    await callComposeInput(requestFor(row.outboxRowId), { row, bundles: fakeBundles(bundle) }),
  );
  return input.facts as Json[];
}

/** A card's lines as bundle v0 writes them for a step's message at `say`. */
function cardOf(step: Json, say: number): unknown[] {
  const message = sayOf(step)[say] ?? {};
  const elements = (message.elements ?? {}) as { card?: { lines?: unknown[] } };
  return elements.card?.lines ?? [];
}

/** Alex M.'s slot facts on the card step's line: the business, the service and the day, as limit 7 gives them. */
const ALEX_SLOT_FACTS = [
  { slot: "biz.name", value: "Lee's Barbershop" },
  { slot: "svc.intext", value: "Haircut" },
  { slot: "day", value: "Sat Oct 24" },
];

/** bundles/v2/bundle/: bundle v2's parts as card 8 (T-1477) cut them; its flow A holds S1-08's plan card. */
const BUNDLE_V2 = path.join(CONTRACTS_DIR, "..", "bundles", "v2", "bundle");

/** Bundle v2 as one document, its manifest and its flow A graph, freshly parsed (a test may change its copy). */
function bundleV2(): BundleDocument {
  const part = (file: string): Json =>
    JSON.parse(readFileSync(path.join(BUNDLE_V2, ...file.split("/")), "utf8")) as Json;
  return { manifest: part("manifest.json"), flows: { A: part("flow/A.json") } };
}

/** S1-08's plan card as bundle v2 writes it: its seven lines, in order (master-A.json S1-08, compiled). */
const S1_08_CARD = [
  "Your business and your ID: about 3 minutes",
  "Any license or document you want shown (optional)",
  "No extra agreement for your work",
  "Then the barbershop, live in about 15 minutes",
  "Then {{biz.name}}: plumbing, then electrical, about 5 minutes each",
  "Then your people",
  "Nothing you tell me is asked twice",
];

/** S1-08's term facts under default 186: the four fixed lines, each with its generic source (default 138). */
const S1_08_FACTS = [
  {
    value: "Your business and your ID: about 3 minutes",
    source: "S1-08's card, line 1 (K-01 flows.A.steps.S1-08.say[0].elements.card.lines[0])",
  },
  {
    value: "Any license or document you want shown (optional)",
    source: "S1-08's card, line 2 (K-01 flows.A.steps.S1-08.say[0].elements.card.lines[1])",
  },
  {
    value: "Then your people",
    source: "S1-08's card, line 6 (K-01 flows.A.steps.S1-08.say[0].elements.card.lines[5])",
  },
  {
    value: "Nothing you tell me is asked twice",
    source: "S1-08's card, line 7 (K-01 flows.A.steps.S1-08.say[0].elements.card.lines[6])",
  },
];

/**
 * S1-08's row to Sam, the owner, under bundle v2 (the S1-04 ruling's decision (h): S1-08 tells the owner the plan in one
 * row to the turn's own handle, with no question): S1-02's row with S1-08's step, a row and turn of its own and the
 * bundle's id. S1-08's line names no slot and the row is about none, so it has no slot fact.
 */
function s108Row(bundle: BundleDocument): ComposeRow {
  return {
    ...s102Row(),
    outboxRowId: "outbox-s1-08-sam-1",
    turnId: "turn-s1-04-sam",
    bundleId: bundleIdOf(bundle),
    step: "S1-08",
    inbound: null,
  };
}

/** K-09's named rules and tables (tool-api.rules.mjs) this file holds the code to, as `npm run contracts:check` reads them. */
interface ToolApiRules {
  S1_08_TERM_LINES: readonly { index: number; words: string }[];
  cardLinesOf: (bundle: unknown, step: string) => unknown[] | undefined;
  termFactsFromCard: (exchange: unknown) => string[];
  inputIsK03Fixture: (exchange: unknown) => string[];
}

async function toolApiRules(): Promise<ToolApiRules> {
  const file = path.join(CONTRACTS_DIR, "tool-api", "tool-api.rules.mjs");
  return (await import(pathToFileURL(file).href)) as ToolApiRules;
}

describe("S1-02's four card terms, each with its source line word for word (defaults 137, 138; gap 126)", () => {
  it("the fixed table is input-s1-02-v1.1.json's four facts word for word, each S1-02's card line in bundle v0 at its place", () => {
    const facts = (k03Fixture("input-s1-02-v1.1.json") as { facts: unknown[] }).facts;
    expect(S1_02_SOURCES.map((entry) => ({ value: entry.words, source: entry.source }))).toStrictEqual(facts);
    const s102 = stepOf(bundleV0(), "S1-02");
    for (const entry of S1_02_SOURCES) {
      expect([entry.flow, entry.step, entry.say]).toStrictEqual(["A", "S1-02", 0]);
      expect(cardOf(s102, entry.say)[entry.line]).toBe(entry.words);
    }
  });

  it("compose input gives them after S1-02's slot facts (none), in the card's order: the input's facts", async () => {
    const facts = await factsFor(s102Row());
    expect(facts).toStrictEqual((k03Fixture("input-s1-02-v1.1.json") as { facts: unknown }).facts);
    expect(facts.map((fact) => fact.value)).toStrictEqual(cardOf(stepOf(bundleV0(), "S1-02"), 0));
  });

  it("finalize's `terms` for S1-02 are compose input's term values (finalize's Values check reads the same words)", async () => {
    const values = (await factsFor(s102Row())).map((fact) => fact.value);
    expect(values).toStrictEqual([...S1_02_TERMS]);
    expect(values).toStrictEqual([...finalizeS102Row().checks.terms]);
  });

  it("the table stands only for the words it was written for: a line the bundle words otherwise takes the generic source", async () => {
    const bundle = bundleV0();
    const lines = cardOf(stepOf(bundle, "S1-02"), 0);
    lines[0] = "About 20 minutes for your first kind of work";
    const facts = await factsFor(s102Row(), bundle);
    expect(facts[0]).toStrictEqual({
      value: "About 20 minutes for your first kind of work",
      source: "S1-02's card, line 1 (K-01 flows.A.steps.S1-02.say[0].elements.card.lines[0])",
    });
    expect(facts.slice(1)).toStrictEqual(
      (k03Fixture("input-s1-02-v1.1.json") as { facts: unknown[] }).facts.slice(1),
    );
  });
});

describe("default 137 on other steps: a card line with no slot is a term fact, a line with a slot never is", () => {
  it("a card that mixes slotted and plain lines gives the plain lines only, after the slot facts, with the generic source", async () => {
    const bundle = withSteps(
      bundleV0(),
      cardStep("A7-x02", [
        "{{svc.intext:Haircut}} with {{pro.name:Riley}}",
        "Free to change up to a day before",
        "{{price:$35}} at the shop",
        "Good for 7 days",
      ]),
    );
    const facts = await factsFor(alexRow("A7-x02", barberSource()), bundle);
    expect(facts).toStrictEqual([
      ...ALEX_SLOT_FACTS,
      {
        value: "Free to change up to a day before",
        source: "A7-x02's card, line 2 (K-01 flows.A.steps.A7-x02.say[1].elements.card.lines[1])",
      },
      {
        value: "Good for 7 days",
        source: "A7-x02's card, line 4 (K-01 flows.A.steps.A7-x02.say[1].elements.card.lines[3])",
      },
    ]);
    // No value of the sample cast becomes a term fact: Riley and $35 come only as limit 7 gives slots, here none.
    expect(JSON.stringify(facts)).not.toContain("Riley");
    expect(JSON.stringify(facts)).not.toContain("$35");
  });

  it("any `{{` names a slot, a broken one too, as K-09 v1.6's rule termFactsFromCard reads a card line", async () => {
    const bundle = withSteps(bundleV0(), cardStep("A7-x02", ["Bring {{ cash", "{{day}}", "Free to use"]));
    const facts = await factsFor(alexRow("A7-x02", barberSource()), bundle);
    expect(facts.slice(ALEX_SLOT_FACTS.length)).toStrictEqual([
      {
        value: "Free to use",
        source: "A7-x02's card, line 3 (K-01 flows.A.steps.A7-x02.say[1].elements.card.lines[2])",
      },
    ]);
  });

  it("a card whose every line names a slot gives no term fact, and a step with no card gives none", async () => {
    const slotted = withSteps(
      bundleV0(),
      cardStep("A7-x02", ["{{svc.intext:Haircut}}", "{{visit.time:11:00am}} with {{pro.name:Riley}}"]),
    );
    expect(await factsFor(alexRow("A7-x02", barberSource()), slotted)).toStrictEqual(ALEX_SLOT_FACTS);
    const noCard = withSteps(bundleV0(), a614Step(optOutLineOf(bundleV0())));
    const a614 = sayOf(stepOf(noCard, "A6-14"))[0];
    expect(a614?.elements).not.toHaveProperty("card");
    expect(await factsFor(alexRow("A6-14", barberSource()), noCard)).toStrictEqual([]);
    const empty = withSteps(bundleV0(), cardStep("A7-x02", []));
    expect(await factsFor(alexRow("A7-x02", barberSource()), empty)).toStrictEqual(ALEX_SLOT_FACTS);
  });

  it("a line that is not words, is empty or holds the opt-out line is none, and each other line keeps its place", async () => {
    const optOut = optOutLineOf(bundleV0());
    const bundle = withSteps(
      bundleV0(),
      cardStep("A7-x02", [42, "  ", `Free to use. ${optOut}`, "Free to use"]),
    );
    const facts = await factsFor(alexRow("A7-x02", barberSource()), bundle);
    expect(facts.slice(ALEX_SLOT_FACTS.length)).toStrictEqual([
      {
        value: "Free to use",
        source: "A7-x02's card, line 4 (K-01 flows.A.steps.A7-x02.say[1].elements.card.lines[3])",
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain("STOP");
  });

  it("the generic source names the step, the line from 1 and its K-01 path from 0", () => {
    expect(genericSource({ flow: "B", step: "B4-13", say: 2, line: 0 })).toBe(
      "B4-13's card, line 1 (K-01 flows.B.steps.B4-13.say[2].elements.card.lines[0])",
    );
  });
});

describe("S1-08 on bundle v2: only Rosie's four fixed lines are term facts (K-09 v1.11 default 186; T-1483)", () => {
  it("the table is K-09's S1_08_TERM_LINES, each line S1-08's card line in bundle v2 at its place", async () => {
    const { S1_08_TERM_LINES } = await toolApiRules();
    expect(S1_08_TERMS.map((entry) => ({ index: entry.line, words: entry.words }))).toStrictEqual(
      S1_08_TERM_LINES.map((entry) => ({ index: entry.index, words: entry.words })),
    );
    const s108 = stepOf(bundleV2(), "S1-08");
    expect(cardOf(s108, 0)).toStrictEqual(S1_08_CARD);
    for (const entry of S1_08_TERMS) {
      expect([entry.flow, entry.step, entry.say]).toStrictEqual(["A", "S1-08", 0]);
      expect(cardOf(s108, entry.say)[entry.line]).toBe(entry.words);
    }
  });

  it("compose input gives exactly the four lines, in the card's order, each with its generic source", async () => {
    const bundle = bundleV2();
    const input = inputOf(
      await callComposeInput(requestFor("outbox-s1-08-sam-1"), {
        row: s108Row(bundle),
        bundles: fakeBundles(bundle),
      }),
    );
    expect(input.facts).toStrictEqual(S1_08_FACTS);
    expect(S1_08_FACTS.map((fact) => fact.source)).toStrictEqual(
      S1_08_TERMS.map((entry) => genericSource(entry)),
    );
    // The withheld lines reach the composer nowhere: not as facts, nor in the master text (the message's words alone).
    expect(input.masterText).toStrictEqual({
      step: "S1-08",
      text: "Here's the plan. You can stop anytime: text MORE to pick up where you left off.",
    });
    for (const withheld of S1_08_CARD.slice(2, 5)) expect(JSON.stringify(input)).not.toContain(withheld);
    expect(JSON.stringify(input)).not.toContain("{{");
  });

  it("each fact is a line of S1-08's card that names no slot, as K-09's rules read a card, here in bundle v2", async () => {
    const { cardLinesOf } = await toolApiRules();
    const lines = cardLinesOf(bundleV2(), "S1-08");
    expect(lines).toStrictEqual(S1_08_CARD);
    for (const fact of S1_08_FACTS) {
      expect(lines).toContain(fact.value);
      expect(fact.value).not.toContain("{{");
    }
  });

  it("the agreement line, the first kind's line and the slotted line give none, though default 137 alone takes two", () => {
    const facts = S1_08_CARD.map((words, line) =>
      isTermLine({ flow: "A", step: "S1-08", say: 0, line }, words),
    );
    expect(facts).toStrictEqual([true, true, false, false, false, true, true]);
    // The same card on any other step keeps default 137: every line that names no slot, the story's two among them.
    const other = S1_08_CARD.map((words, line) =>
      isTermLine({ flow: "A", step: "A7-x02", say: 0, line }, words),
    );
    expect(other).toStrictEqual([true, true, true, true, false, true, true]);
  });

  it("one of the four worded otherwise gives none, and the other three keep their places and sources", async () => {
    const bundle = bundleV2();
    const card = cardOf(stepOf(bundle, "S1-08"), 0);
    card[0] = "Your business and your ID: about 5 minutes";
    const input = inputOf(
      await callComposeInput(requestFor("outbox-s1-08-sam-1"), {
        row: s108Row(bundle),
        bundles: fakeBundles(bundle),
      }),
    );
    expect(input.facts).toStrictEqual(S1_08_FACTS.slice(1));
    expect(JSON.stringify(input)).not.toContain("about 5 minutes");
  });

  it("one of the four at another place gives none: another line, another message, another flow", async () => {
    const bundle = bundleV2();
    const card = cardOf(stepOf(bundle, "S1-08"), 0);
    [card[5], card[6]] = [card[6], card[5]];
    const input = inputOf(
      await callComposeInput(requestFor("outbox-s1-08-sam-1"), {
        row: s108Row(bundle),
        bundles: fakeBundles(bundle),
      }),
    );
    expect(input.facts).toStrictEqual(S1_08_FACTS.slice(0, 2));
    const fixed = "Then your people";
    expect(isTermLine({ flow: "A", step: "S1-08", say: 0, line: 5 }, fixed)).toBe(true);
    expect(isTermLine({ flow: "A", step: "S1-08", say: 1, line: 5 }, fixed)).toBe(false);
    expect(isTermLine({ flow: "B", step: "S1-08", say: 0, line: 5 }, fixed)).toBe(false);
  });

  it("the rule is exported for finalize: a line that is not words, empty, slotted or holding the opt-out line is none", () => {
    const optOut = optOutLineOf(bundleV0());
    const place: CardPlace = { flow: "A", step: "S1-08", say: 0, line: 5 };
    expect(isTermLine(place, 42)).toBe(false);
    expect(isTermLine(place, null)).toBe(false);
    expect(isTermLine(place, "Then your people")).toBe(true);
    expect(isTermLine(place, "Then your people", [optOut])).toBe(true);
    expect(isTermLine({ ...place, step: "A7-x02" }, `Free to use. ${optOut}`, [optOut])).toBe(false);
    expect(isTermLine({ ...place, step: "A7-x02" }, "   ")).toBe(false);
    expect(isTermLine({ ...place, step: "A7-x02" }, "{{biz.name}}")).toBe(false);
    // termFactsOf reads the same rule: on a master line it gives what isTermLine takes, with its source.
    expect(
      termFactsOf({
        step: "S1-08",
        text: "Here's the plan.",
        pageTypes: [],
        optOutLines: [optOut],
        flow: "A",
        say: 0,
        cardLines: [...S1_08_CARD, null],
      }),
    ).toStrictEqual(S1_08_FACTS);
  });

  it("every other step is unchanged: bundle v2's S1-02 gives input-s1-02-v1.1.json's four facts", async () => {
    const bundle = bundleV2();
    const row: ComposeRow = { ...s102Row(), bundleId: bundleIdOf(bundle) };
    const facts = await factsFor(row, bundle);
    expect(facts).toStrictEqual((k03Fixture("input-s1-02-v1.1.json") as { facts: unknown }).facts);
  });

  it("compose-input-s1-02-v1.6.json is unchanged, and K-09's termFactsFromCard and inputIsK03Fixture pass on it", async () => {
    const { termFactsFromCard, inputIsK03Fixture } = await toolApiRules();
    const exchange = s102Exchange();
    const answer = answerOf(await callComposeInput(exchange.request));
    expect(answer).toStrictEqual(exchange.outcome);
    const answered = { call: "composeInput", request: exchange.request, outcome: answer };
    expect(termFactsFromCard(answered)).toStrictEqual([]);
    expect(inputIsK03Fixture(answered)).toStrictEqual([]);
  });
});

describe("audience.name: the reader is addressed by the first word of the name (T-1141's default; DL-367)", () => {
  it("the seed's \"Sam Lee\" (db/seeds/skeleton.ts persons.name) gives compose-input-s1-02-v1.6.json's input, word for word", async () => {
    const row: ComposeRow = { ...s102Row(), name: "Sam Lee" };
    const called = await callComposeInput(s102Exchange().request, { row });
    expect(answerOf(called)).toStrictEqual(s102Exchange().outcome);
    expect(inputOf(called).audience).toStrictEqual({
      role: "owner",
      name: "Sam",
      way: "texts",
      handlingLine: null,
    });
  });

  it("takes the first word, and no name when none is known", () => {
    expect(addressedAs("Sam Lee")).toBe("Sam");
    expect(addressedAs("  Sam\tLee ")).toBe("Sam");
    expect(addressedAs("Alex M.")).toBe("Alex");
    expect(addressedAs("Riley")).toBe("Riley");
    expect(addressedAs("   ")).toBeNull();
    expect(addressedAs(null)).toBeNull();
  });
});
