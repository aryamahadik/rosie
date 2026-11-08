// grade() parity (T-312 "Proves it with"; arch 07 line 413): Rosie's port of the master's lib.js grade() gives the
// master's own numbers on 30 sample lines within 0.1. The numbers were recorded by running the master's grade() itself
// (grade-parity.record.mjs, on scratch/master-copy/engine) into grade-parity.json, so this test needs no master.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LIMITS, cleanText, grade, ideasIn, longestSentence, sentencesOf, syllables, wordsOf } from "./grade";

interface ParityLine {
  readonly source: string;
  readonly text: string;
  readonly master: number | null;
}

const PARITY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "grade-parity.json");
const parity = JSON.parse(readFileSync(PARITY_FILE, "utf8")) as { lines: ParityLine[] };

describe("grade(): parity with the master's lib.js grade()", () => {
  it("holds 30 sample lines, each with the grade the master gave it", () => {
    expect(parity.lines).toHaveLength(30);
    expect(new Set(parity.lines.map((line) => line.text)).size).toBe(30);
    const graded = parity.lines.filter((line) => line.master !== null);
    expect(graded.length, "most lines have 12 words or more").toBeGreaterThan(25);
    expect(
      parity.lines.some((line) => line.master === null),
      "a line under 12 words has no grade",
    ).toBe(true);
    expect(
      graded.some((line) => (line.master ?? 0) > LIMITS.grade),
      "a line reads above grade 9.5",
    ).toBe(true);
  });

  it("gives the master's grade on every sample line, within 0.1", () => {
    for (const line of parity.lines) {
      const ours = grade(line.text);
      if (line.master === null) {
        expect(ours, line.source).toBeNull();
      } else {
        expect(ours, line.source).not.toBeNull();
        expect(Math.abs((ours ?? Number.NaN) - line.master), line.source).toBeLessThanOrEqual(0.1);
      }
    }
  });
});

describe("grade(): the master's counting, line by line", () => {
  it("counts syllables as lib.js syl does (line 472)", () => {
    expect(syllables("the")).toBe(1);
    expect(syllables("visit")).toBe(2);
    expect(syllables("booked")).toBe(1);
    expect(syllables("price")).toBe(1);
    expect(syllables("yellow")).toBe(2);
    expect(syllables("assistants")).toBe(3);
    expect(syllables("5160")).toBe(1);
    expect(syllables("")).toBe(1);
  });

  it("reads a clock time as one word and a long dash as 'to' (line 480)", () => {
    expect(cleanText("From 11:00am — 2 PM,\n  then  7pm")).toBe("From time to time, then time");
    expect(wordsOf("Sat Oct 24 at 11:00 am · Riley")).toEqual(["Sat", "Oct", "24", "at", "time", "Riley"]);
  });

  it("splits sentences at each line and after . ! or ? before a capital, a digit, a quote or $ (line 481)", () => {
    expect(sentencesOf("You're booked! See you then. 5160 is your code.\nAlex M. booked it? yes")).toEqual([
      "You're booked!",
      "See you then.",
      "5160 is your code.",
      "Alex M. booked it? yes",
    ]);
    expect(sentencesOf("· · ·\n\n")).toEqual([]);
  });

  it("gives no grade under 12 words, and the longest sentence and its ideas (lines 485, 489, 495)", () => {
    expect(grade("One two three four five six seven eight nine ten eleven.")).toBeNull();
    expect(grade("One two three four five six seven eight nine ten eleven twelve.")).not.toBeNull();
    expect(longestSentence("A short one. Then a longer one, with five words more.")).toBe(8);
    expect(ideasIn("Bring this, that; and (maybe) the rest.")).toBe(4);
  });
});
