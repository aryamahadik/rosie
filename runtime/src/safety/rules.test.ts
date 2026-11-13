// checkedLineFor, the actor's direct-path line (T-1143; DL-325, DL-330): every danger outcome gets a line to the person who
// wrote the text. The outcome's own step gives it when the pinned bundle holds that step; otherwise the fixed line the
// sources give that outcome does, and 911 at the last (fails closed). A threat's writer gets no line (S13-10; S13-24 rule
// 11; A3-48), and No gets none. The bundles are doubles over K-01 v1's fixed lines (fixed-lines.json) and the master's words
// for the outcome steps (MASTER-FLOW-A.md A3-24 to A3-26, A3-48 to A3-50). The results are K-02 v1's safety fixtures, or a
// verdict built on safety-no.json's shape. Bundle v0's own run, with the direct path, is partial-bundle.test.ts. Test values
// only (rule 9).

import { describe, expect, it } from "vitest";

import fixedLinesFixture from "../../../contracts/bundle/fixtures/fixed-lines.json";
import safetyBusinessOwnLine from "../../../contracts/model/fixtures/safety-business-own-line.json";
import safetyChildOrElder from "../../../contracts/model/fixtures/safety-child-or-elder.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import safetyTimeoutDangerWord from "../../../contracts/model/fixtures/safety-timeout-danger-word.json";
import safetyTimeoutSelfHarm from "../../../contracts/model/fixtures/safety-timeout-self-harm-word.json";
import safetyUnknownTense from "../../../contracts/model/fixtures/safety-unknown-tense.json";
import safetyUnsafeAtHome from "../../../contracts/model/fixtures/safety-unsafe-at-home.json";
import { present } from "../gateway/test-support";
import { checkedLineFor } from "./rules";
import {
  SAFETY_OUTCOMES,
  type BundleSafety,
  type CheckedLine,
  type SafetyOutcome,
  type SafetyResult,
  type Tense,
} from "./types";

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;

/** K-01 v1's fixed lines with words, by id. */
const K01_LINES: ReadonlyMap<string, string> = new Map(
  (fixedLinesFixture as { lines: { id: string; text: string | null }[] }).lines.flatMap((line) =>
    line.text === null ? [] : [[line.id, line.text] as const],
  ),
);

/** K-01 v1's words for a fixed line, as the line the bundle gives. */
function k01(id: string): CheckedLine {
  const text = K01_LINES.get(id);
  if (text === undefined) throw new Error(`K-01 v1 has no words for ${id}`);
  return { id, text };
}

/** K-01's line followed by the danger question (S13-24 rule 10). */
const withAsk = (line: CheckedLine): CheckedLine => ({
  id: line.id,
  text: `${line.text} ${k01("safetyAsk").text}`,
});

/** A bundle double: K-01 v1's fixed lines (less the ids in `without`) and these outcome steps' checked lines. */
function bundleOf(
  steps: Partial<Record<SafetyOutcome, CheckedLine>>,
  without: readonly string[] = [],
): BundleSafety {
  return {
    fixedLine: (id) => (without.includes(id) || !K01_LINES.has(id) ? null : k01(id)),
    outcomeLine: (outcome) => steps[outcome] ?? null,
    dangerWords: () => [],
  };
}

/** A partial bundle, such as bundle v0: the fixed lines and no outcome step. */
const PARTIAL = bundleOf({});

/**
 * A barbershop's full bundle: each outcome step's checked line under its step id, in the master's words. A3-23 sends nothing
 * for a barbershop ("A barbershop has none, so nothing is sent here"), so it has no line; A3-48's line is Sam's, the owner's.
 */
const BARBERSHOP_STEPS: Partial<Record<SafetyOutcome, CheckedLine>> = {
  "An emergency": {
    id: "A3-24",
    text: "This sounds like an emergency. If anyone is in danger, get to safety and call 911 now.",
  },
  "Crisis words": {
    id: "A3-25",
    text: "If you're thinking about harming yourself, call or text 988 now. If you're in danger right now, call 911.",
  },
  "A threat to staff or others": {
    id: "A3-48",
    text:
      "Urgent: a message to Lee's Barbershop threatened harm to someone on your team. Nothing was booked. Visits with " +
      "this person are paused until you decide. Details on the secure page.",
  },
  "Harm to a child or older adult": {
    id: "A3-49",
    text:
      "I'm sorry you're dealing with this. A hotline can help any time, and a person from Rosie will see this today. If " +
      "anyone is in danger right now, call 911.",
  },
  "Unsafe at home": {
    id: "A3-50",
    text:
      "Thanks for telling me. If you're in danger right now, call 911. A family violence hotline can help any time, free " +
      "and private.",
  },
  "Needs the business's own line": {
    id: "A3-26",
    text:
      "That's a question for the barbers themselves. Riley can go over it at your visit. For anything sooner, call " +
      "Lee's Barbershop at (555) 010-0177. Call 911 if anyone is in danger.",
  },
};
const FULL = bundleOf(BARBERSHOP_STEPS);

/** A verdict with these labels, on K-02's safety-no.json shape: one Haiku verdict and no danger word. */
function verdict(labels: readonly { outcome: SafetyOutcome; tense?: Tense }[]): SafetyResult {
  return {
    ...asResult(safetyNo),
    eventId: "evt-alex-1143",
    read: {
      labels: labels.map(({ outcome, tense = "now" }) => ({
        outcome,
        tense,
        evidence: "x",
        atRisk: "unknown",
        writer: "the person at the handle",
      })),
    },
    outcomes: [...new Set(labels.map((label) => label.outcome))],
  };
}

const SAFETY_STEPS = verdict([{ outcome: "Safety steps, then go on" }]);

describe("a partial bundle (no outcome step): each outcome's line", () => {
  it.each<[string, SafetyResult, string | null]>([
    ["No (safety-no.json) sends nothing", asResult(safetyNo), null],
    ["Safety steps, then go on gets 911", SAFETY_STEPS, "safetyEmergency"],
    ["An emergency (safety-emergency-now.json) gets 911", asResult(safetyEmergencyNow), "safetyEmergency"],
    ["Crisis words (safety-crisis-words.json) get 988 and 911", asResult(safetyCrisisWords), "safetyCrisis"],
    ["A threat (safety-threat.json) sends its writer nothing", asResult(safetyThreat), null],
    [
      "Harm to a child or older adult (safety-child-or-elder.json) gets 911",
      asResult(safetyChildOrElder),
      "safetyEmergency",
    ],
    ["Unsafe at home (safety-unsafe-at-home.json) gets 911", asResult(safetyUnsafeAtHome), "safetyEmergency"],
    [
      "The business's own line (safety-business-own-line.json) gets 911",
      asResult(safetyBusinessOwnLine),
      "safetyEmergency",
    ],
    [
      "Unsure on a danger word (safety-timeout-danger-word.json) gets 911",
      asResult(safetyTimeoutDangerWord),
      "safetyEmergency",
    ],
    [
      "Unsure on a self-harm word (safety-timeout-self-harm-word.json) gets 988 and 911",
      asResult(safetyTimeoutSelfHarm),
      "safetyCrisis",
    ],
  ])("%s", (_name, result, lineId) => {
    expect(checkedLineFor(result, PARTIAL)).toEqual(lineId === null ? null : k01(lineId));
  });

  it("every danger outcome but a threat gets a line, and only No and a threat get none", () => {
    const sent = SAFETY_OUTCOMES.filter(
      (outcome) => checkedLineFor(verdict([{ outcome }]), PARTIAL) !== null,
    );
    expect(sent).toEqual(
      SAFETY_OUTCOMES.filter((outcome) => outcome !== "No" && outcome !== "A threat to staff or others"),
    );
  });

  it("the read's own Unsure with no danger word gets 911", () => {
    expect(checkedLineFor(verdict([{ outcome: "Unsure" }]), PARTIAL)).toEqual(k01("safetyEmergency"));
  });
});

describe("a full bundle: the outcome step's own line wins over the fallback", () => {
  it.each<[string, SafetyResult, SafetyOutcome]>([
    ["An emergency gets A3-24's line", asResult(safetyEmergencyNow), "An emergency"],
    ["Crisis words get A3-25's line", asResult(safetyCrisisWords), "Crisis words"],
    [
      "Harm to a child or older adult gets A3-49's line",
      asResult(safetyChildOrElder),
      "Harm to a child or older adult",
    ],
    ["Unsafe at home gets A3-50's line", asResult(safetyUnsafeAtHome), "Unsafe at home"],
    [
      "The business's own line gets A3-26's line",
      asResult(safetyBusinessOwnLine),
      "Needs the business's own line",
    ],
  ])("%s", (_name, result, outcome) => {
    const step = present(BARBERSHOP_STEPS[outcome], outcome);
    expect(checkedLineFor(result, FULL)).toEqual(step);
    expect(checkedLineFor(result, FULL)?.id).not.toBe(checkedLineFor(result, PARTIAL)?.id);
  });

  it("a step with no line of its own (A3-23 for a barbershop) still gets 911", () => {
    expect(checkedLineFor(SAFETY_STEPS, FULL)).toEqual(k01("safetyEmergency"));
  });

  it("a threat's writer gets nothing, even where the bundle holds A3-48's line (Sam's, never the writer's)", () => {
    expect(FULL.outcomeLine("A threat to staff or others")?.id).toBe("A3-48");
    expect(checkedLineFor(asResult(safetyThreat), FULL)).toBeNull();
  });

  it("Unsure has no step: it takes the danger words' fixed line", () => {
    expect(checkedLineFor(asResult(safetyTimeoutSelfHarm), FULL)).toEqual(k01("safetyCrisis"));
    expect(checkedLineFor(asResult(safetyTimeoutDangerWord), FULL)).toEqual(k01("safetyEmergency"));
  });
});

describe("several outcomes: the first in line order chooses the line", () => {
  it("crisis words and a threat: the crisis path runs, 988 and 911 (A3-48: 'unless they're in crisis too')", () => {
    const result = verdict([{ outcome: "A threat to staff or others" }, { outcome: "Crisis words" }]);
    expect(checkedLineFor(result, PARTIAL)).toEqual(k01("safetyCrisis"));
    expect(checkedLineFor(result, FULL)?.id).toBe("A3-25");
  });

  it("an emergency and a threat: 911 comes first", () => {
    const result = verdict([{ outcome: "A threat to staff or others" }, { outcome: "An emergency" }]);
    expect(checkedLineFor(result, PARTIAL)).toEqual(k01("safetyEmergency"));
  });

  it("a threat with harm to a child or older adult: the writer still gets nothing (S13-10)", () => {
    const result = verdict([
      { outcome: "Harm to a child or older adult" },
      { outcome: "A threat to staff or others" },
    ]);
    expect(checkedLineFor(result, PARTIAL)).toBeNull();
    expect(checkedLineFor(result, FULL)).toBeNull();
  });

  it("harm and unsafe at home: harm's line; the business's own line before safety steps; any outcome before Unsure", () => {
    const harm = verdict([{ outcome: "Unsafe at home" }, { outcome: "Harm to a child or older adult" }]);
    expect(checkedLineFor(harm, FULL)?.id).toBe("A3-49");
    expect(checkedLineFor(harm, PARTIAL)).toEqual(k01("safetyEmergency"));
    const ownLine = verdict([
      { outcome: "Safety steps, then go on" },
      { outcome: "Needs the business's own line" },
    ]);
    expect(checkedLineFor(ownLine, FULL)?.id).toBe("A3-26");
    const unsure = verdict([{ outcome: "Unsure" }, { outcome: "Unsafe at home" }]);
    expect(checkedLineFor(unsure, FULL)?.id).toBe("A3-50");
  });
});

describe("a label of unknown tense adds the danger question (S13-24 rule 10)", () => {
  it("safety-unknown-tense.json: 911 and 'Is anyone in danger right now?'", () => {
    expect(checkedLineFor(asResult(safetyUnknownTense), PARTIAL)).toEqual(withAsk(k01("safetyEmergency")));
  });

  it("the question follows a fallback line and a step's own line alike", () => {
    const harm = verdict([{ outcome: "Harm to a child or older adult", tense: "unknown" }]);
    expect(checkedLineFor(harm, PARTIAL)).toEqual(withAsk(k01("safetyEmergency")));
    const home = verdict([{ outcome: "Unsafe at home", tense: "unknown" }]);
    const step = present(BARBERSHOP_STEPS["Unsafe at home"], "A3-50's line");
    expect(checkedLineFor(home, FULL)).toEqual(withAsk(step));
    expect(checkedLineFor(verdict([{ outcome: "Unsure", tense: "unknown" }]), PARTIAL)).toEqual(
      withAsk(k01("safetyEmergency")),
    );
  });

  it("no question without a line: a threat's writer and No get nothing; a No label of unknown tense adds none", () => {
    expect(
      checkedLineFor(verdict([{ outcome: "A threat to staff or others", tense: "unknown" }]), PARTIAL),
    ).toBeNull();
    expect(checkedLineFor(verdict([{ outcome: "No", tense: "unknown" }]), PARTIAL)).toBeNull();
    const harm = verdict([
      { outcome: "Harm to a child or older adult" },
      { outcome: "No", tense: "unknown" },
    ]);
    expect(checkedLineFor(harm, PARTIAL)).toEqual(k01("safetyEmergency"));
  });

  it("a bundle with no danger question sends the line alone", () => {
    expect(checkedLineFor(asResult(safetyUnknownTense), bundleOf({}, ["safetyAsk"]))).toEqual(
      k01("safetyEmergency"),
    );
  });
});

describe("a bundle missing the outcome's fixed line: 911, the strictest", () => {
  it("crisis words with no 988 line get 911", () => {
    const noCrisis = bundleOf({}, ["safetyCrisis"]);
    expect(checkedLineFor(asResult(safetyCrisisWords), noCrisis)).toEqual(k01("safetyEmergency"));
    expect(checkedLineFor(asResult(safetyTimeoutSelfHarm), noCrisis)).toEqual(k01("safetyEmergency"));
  });

  it("a bundle with no safety line at all gives nothing to send: the runtime holds no words of its own", () => {
    const none = bundleOf({}, ["safetyEmergency", "safetyCrisis"]);
    expect(checkedLineFor(asResult(safetyChildOrElder), none)).toBeNull();
    expect(checkedLineFor(asResult(safetyCrisisWords), none)).toBeNull();
  });
});
