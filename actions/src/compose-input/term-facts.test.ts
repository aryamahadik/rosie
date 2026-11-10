// Compose input's term facts (T-1174; K-09 README v1.6 defaults 137, 138 and 141; K-03 v1.1 termFact; DL-355, DL-359,
// DL-367), through the Tool API base over the fake row reader and K-01 v1's sample bundles. The card's checks: S1-02's
// four card terms, each with its source line word for word (compose-input-s1-02-v1.6.json; the double's recording 4 is
// keyed on them); a card line that names a slot is never a term fact; a card that states no term gives none; the slot
// facts first, then the terms in the card's order. And the lead's: default 137 beyond S1-02 (a card that mixes slotted
// and plain lines, a step with no card), the generic source of gap 126, finalize's `terms` agreeing with compose input
// on S1-02, and the reader addressed by the first word of the name (the seed's "Sam Lee" is "Sam"). Values come only
// from the contracts' fixtures and the master's sample cast (rule 9).

import { describe, expect, it } from "vitest";

import { barberSource } from "../finalize/claim-check/test-support";
import { S1_02_TERMS, s102Row as finalizeS102Row } from "../finalize/rewrite/test-support";
import { fakeBundles } from "../frontier/assemble/test-support";
import { S1_02_SOURCES, addressedAs, genericSource, type ComposeRow } from "./index";
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
