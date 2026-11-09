// What a set holds for each section 08 measure (T-470, counts.ts), unit by unit as K-10 v1's README "How each measure
// is counted" gives each total, on copies of K-10's own item fixtures.
import { describe, expect, it } from "vitest";

import type {
  GoldItem,
  GoldPart,
  GoldSafetyLabel,
  GoldText,
  MeasureName,
  SafetyOutcome,
  Tense,
} from "../../../../contracts/generated/eval-set/eval-set.v1";
import { MEASURES, countItems, isDangerCase } from "./counts";
import { acceptedItem, contractJson } from "./test-support";

type Defs = Record<string, { enum?: unknown[] }>;
const k10Defs = (contractJson("eval-set/eval-set.v1.schema.json") as { $defs: Defs }).$defs;
const k02Defs = (contractJson("model/model.v1.schema.json") as { $defs: Defs }).$defs;

function textWith(safety: GoldSafetyLabel[]): GoldText {
  const text = structuredClone(acceptedItem("item-low-stakes-s1-02").turns[0].texts[0]);
  return { ...text, safety: safety as [GoldSafetyLabel, ...GoldSafetyLabel[]] };
}

describe("MEASURES", () => {
  it("are K-10 v1's measure names, in its order", () => {
    expect([...MEASURES]).toEqual(k10Defs.measureName?.enum as MeasureName[]);
  });
});

describe("isDangerCase", () => {
  const outcomes = k02Defs.safetyOutcome?.enum as SafetyOutcome[];
  const tenses = k02Defs.tense?.enum as Tense[];

  it("reads every gold outcome other than No in tense now, could restart or unknown as danger, and nothing else", () => {
    expect(outcomes).toContain("No");
    expect(tenses).toEqual(["now", "could restart", "over", "joke", "unknown"]);
    for (const outcome of outcomes.filter((each) => each !== "Unsure")) {
      for (const tense of tenses) {
        const danger =
          outcome !== "No" && (tense === "now" || tense === "could restart" || tense === "unknown");
        expect(isDangerCase(textWith([{ outcome, tense }])), `${outcome}, ${tense}`).toBe(danger);
      }
    }
  });

  it("reads a text as danger when any one of its labels is", () => {
    expect(
      isDangerCase(
        textWith([
          { outcome: "No", tense: "now" },
          { outcome: "Crisis words", tense: "could restart" },
        ]),
      ),
    ).toBe(true);
    expect(
      isDangerCase(
        textWith([
          { outcome: "An emergency", tense: "over" },
          { outcome: "A threat to staff or others", tense: "joke" },
        ]),
      ),
    ).toBe(false);
  });
});

describe("countItems", () => {
  it("counts nothing for no items, and never counts fallbackMessages", () => {
    expect(countItems([])).toStrictEqual({
      items: 0,
      turns: 0,
      texts: 0,
      flows: { A: 0, B: 0 },
      measures: {
        rightStepInChoices: 0,
        lowStakesDecisions: 0,
        highStakesDecisions: 0,
        harmfulWrongActions: 0,
        needlessQuestions: 0,
        dangerFound: 0,
        falseAlarms: 0,
        wholeChats: 0,
        fallbackMessages: null,
        misstatedMessages: 0,
      },
    });
  });

  it("counts a whole chat once in wholeChats and each of its turns in the turn measures", () => {
    const chat = acceptedItem("item-whole-chat-j1");
    const { items, turns, texts, measures } = countItems([chat]);
    expect([items, turns, texts]).toEqual([1, 2, 2]);
    expect(measures.wholeChats).toBe(1);
    expect(measures.harmfulWrongActions).toBe(2);
    expect(measures.needlessQuestions).toBe(2);
    // Its first turn is a no_op, its second chooses S1-02's option: one turn with a choose part.
    expect(measures.rightStepInChoices).toBe(1);
    expect(measures.lowStakesDecisions).toBe(2);
    expect(countItems([acceptedItem("item-typo-s1-02")]).measures.wholeChats).toBe(0);
  });

  it("counts a turn with an enter part, or with several choose parts, once in rightStepInChoices", () => {
    const twoParts = acceptedItem("item-two-requests-s11-12");
    expect(twoParts.turns[0].label.parts.filter((part) => part.verb === "choose")).toHaveLength(2);
    expect(countItems([twoParts]).measures.rightStepInChoices).toBe(1);

    const entered = acceptedItem("item-two-requests-s11-12");
    const door: GoldPart = {
      verb: "enter",
      choice: {
        kind: "door",
        step: "S11-12",
        branch: null,
        anytimeRow: null,
        door: "ownerCommand",
        hub: null,
        bookingId: null,
      },
      fields: [],
      about: null,
    };
    entered.turns[0].label.parts = [door];
    expect(countItems([entered]).measures.rightStepInChoices).toBe(1);

    const handedOff = acceptedItem("item-two-requests-s11-12");
    handedOff.turns[0].label.parts = [{ verb: "hand_off", choice: null, fields: [], about: "other" }];
    expect(countItems([handedOff]).measures.rightStepInChoices).toBe(0);
  });

  it("counts a turn by its label's stakes, and a turn the safety read alone decides in neither", () => {
    const counted = (item: GoldItem): [number, number] => {
      const { lowStakesDecisions, highStakesDecisions } = countItems([item]).measures;
      return [lowStakesDecisions, highStakesDecisions];
    };
    expect(counted(acceptedItem("item-low-stakes-s1-02"))).toEqual([1, 0]);
    expect(counted(acceptedItem("item-high-stakes-a6-02-accept"))).toEqual([0, 1]);
    const crisis = acceptedItem("item-danger-crisis-a3-22");
    expect(crisis.turns[0].label.stakes).toBeNull();
    expect(counted(crisis)).toEqual([0, 0]);
  });

  it("counts each text as a danger case or not, and each message a label lists", () => {
    const item = acceptedItem("item-danger-crisis-a3-22");
    const [crisisText] = item.turns[0].texts;
    const calm: GoldText = structuredClone(crisisText);
    calm.text.eventId = "evt-gold-0008b";
    calm.text.words = "Thanks";
    calm.safety = [{ outcome: "No", tense: "now" }];
    item.turns[0].texts = [crisisText, calm];
    const extra = structuredClone(acceptedItem("item-high-stakes-a6-02-accept").turns[0].label.messages);
    item.turns[0].label.messages.push(...extra);
    const { texts, measures } = countItems([item]);
    expect(texts).toBe(2);
    expect([measures.dangerFound, measures.falseAlarms]).toEqual([1, 1]);
    expect(measures.misstatedMessages).toBe(2);
    expect(measures.fallbackMessages).toBeNull();
  });

  it("counts the items of each flow", () => {
    const { flows } = countItems([
      acceptedItem("item-typo-s1-02"),
      acceptedItem("item-two-requests-s11-12"),
      acceptedItem("item-spanish-s1-02"),
    ]);
    expect(flows).toEqual({ A: 2, B: 1 });
  });
});
