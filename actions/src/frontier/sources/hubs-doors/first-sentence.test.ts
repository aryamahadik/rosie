// A door's definition is the first sentence of its step (K-02 v1 README default 3), cut the way K-01's own stand-in is
// (compiler/src/cards/lines.ts firstSentence, T-144). The action layer keeps its own copy of that cut (first-sentence.ts);
// this test holds the two to the same answer on every step of fixture set v1's two master flows as the emitter compiles
// them, and on the cases the master's words show.

import { beforeAll, describe, expect, it } from "vitest";

import { firstSentence as compilersFirstSentence } from "../../../../../compiler/src/cards/lines";
import type { BundleDocument } from "../../assemble/test-support";
import { firstSentence } from "./first-sentence";
import { masterBundle } from "./test-support";

let MASTER: BundleDocument;

beforeAll(async () => {
  MASTER = await masterBundle();
}, 120_000);

/** Every step's `does` in both compiled flows. */
function everyDoes(document: BundleDocument): string[] {
  return Object.values(document.flows).flatMap((graph) => {
    const steps = (graph as { steps: Record<string, { does?: unknown }> }).steps;
    return Object.values(steps).flatMap((step) => (typeof step.does === "string" ? [step.does] : []));
  });
}

describe("the first sentence of a step's does", () => {
  it("is the compiler's cut on every step of both master flows", () => {
    const texts = everyDoes(MASTER);
    expect(texts.length).toBeGreaterThan(700);
    const differ = texts.filter((text) => firstSentence(text) !== compilersFirstSentence(text));
    expect(differ).toEqual([]);
  });

  it("cuts at a stop followed by a capital, never after an abbreviation or inside a quotation", () => {
    expect(
      firstSentence(
        "Nothing changes on a text Rosie can't act on for sure. AGENT reaches a person at Rosie.",
      ),
    ).toBe("Nothing changes on a text Rosie can't act on for sure.");
    expect(firstSentence("Back to Alex's Saturday, Sat Oct 24: at 8am, Riley gets the day's bookings.")).toBe(
      "Back to Alex's Saturday, Sat Oct 24: at 8am, Riley gets the day's bookings.",
    );
    expect(firstSentence("Meet at 12 Main St. Bring the papers.")).toBe(
      "Meet at 12 Main St. Bring the papers.",
    );
    expect(
      firstSentence("The page asks 'Sorry to hear that. What went wrong?', with no text. Then more."),
    ).toBe("The page asks 'Sorry to hear that. What went wrong?', with no text.");
    expect(firstSentence("  One   line with no stop  ")).toBe("One line with no stop");
  });
});
