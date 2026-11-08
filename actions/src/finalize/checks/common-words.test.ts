// The common words (T-312 round 2; arch 07 line 409): common-words.json holds each word the master writes in lower case
// in Rosie's own message lines, recorded from the master's two flows by common-words.record.mjs (on
// scratch/master-copy/engine), so the Values check needs no master at run time. A capitalized word that starts a
// sentence reads as a plain word only when it is one of them; any other may be a name, so no name may be one.

import { describe, expect, it } from "vitest";

import COMMON_WORDS from "./common-words.json";

/**
 * The master's sample cast and places (SPEC-master section 6; msgtext.js line 21), and the two names its people's own
 * texts write in lower case ("sort out ben pls", "sort out lin pls"), which only Rosie's lines being read keeps out.
 */
const NAMES = [
  "sam",
  "lee",
  "pat",
  "riley",
  "avery",
  "alex",
  "ben",
  "dee",
  "kim",
  "jordan",
  "casey",
  "morgan",
  "lucia",
  "ana",
  "lin",
  "rosie",
  "springfield",
  "elm",
  "oak",
];

describe("common-words.json: the master's lower-case words, recorded", () => {
  it("was recorded from the master's lines: each word once, in order, in lower case", () => {
    expect(COMMON_WORDS.lines, "Rosie's message lines read").toBeGreaterThan(900);
    expect(COMMON_WORDS.words.length).toBeGreaterThan(800);
    expect(COMMON_WORDS.words).toEqual([...new Set(COMMON_WORDS.words)].sort());
    for (const word of COMMON_WORDS.words) expect(word).toMatch(/^\p{Ll}+(?:'\p{Ll}+)*$/u);
  });

  it("holds the plain words Rosie's sentences start with", () => {
    for (const word of [
      "your",
      "you're",
      "thanks",
      "please",
      "sorry",
      "the",
      "it",
      "we",
      "see",
      "reply",
      "pay",
    ]) {
      expect(COMMON_WORDS.words).toContain(word);
    }
  });

  it("holds no name of the master's sample cast or places", () => {
    for (const name of NAMES) expect(COMMON_WORDS.words, name).not.toContain(name);
  });
});
