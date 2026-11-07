// Tests of the card and SSN scrub (T-242, C-045; widened to K-06 v1.1 by T-1070). Test values only: the public test
// card numbers and the printed sample Social Security number K-06's fixtures use (rule 9). The contract's own named
// rules `scrubbed` (v1) and `scrubbedV1dot1` decide what an unscrubbed body is, so they are loaded from
// contracts/inbound-event and run on the scrub's output.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { CARD_TAG, SSN_TAG, digitValueOf, passesLuhn, scrub, scrubInbound } from "./scrub";

// ---------------------------------------------------------------------------------------------------------------
// K-06 v1 and v1.1: their fixtures and their named rules

const CONTRACT_DIR = fileURLToPath(new URL("../../../contracts/inbound-event/", import.meta.url));

interface InboundEventFixture {
  body: string | null;
  scrubbed: { cards: number; ssns: number };
  email: { subject: string } | null;
}

interface RulesModule {
  CARD_TAG: string;
  SSN_TAG: string;
  scrubbed: (event: unknown) => string[];
  scrubbedV1dot1: (event: unknown) => string[];
  hasSsn: (words: string) => boolean;
  cardNumbersIn: (words: string) => string[];
  toAsciiDigits: (words: string) => string;
  cardRunsInV1dot1: (words: string) => number[];
  hasSsnV1dot1: (words: string) => boolean;
}

const rules = (await import(pathToFileURL(`${CONTRACT_DIR}inbound-event.rules.mjs`).href)) as RulesModule;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(`${CONTRACT_DIR}${file}`, "utf8")) as unknown;
}

const fixtureIndex = readJson("fixtures/index.json") as { fixtures: { file: string; expect: string }[] };
const fixture = (file: string): InboundEventFixture => readJson(`fixtures/${file}`) as InboundEventFixture;

/** The event with its body and subject scrubbed, as the gateway builds it. */
function gatewayOutput(event: InboundEventFixture): InboundEventFixture {
  const result = scrubInbound({ body: event.body, subject: event.email?.subject ?? null });
  return {
    ...event,
    body: result.body,
    scrubbed: { cards: result.cards, ssns: result.ssns },
    email: event.email === null ? null : { ...event.email, subject: result.subject ?? "" },
  };
}

describe("K-06 v1 tags", () => {
  it("are the contract's", () => {
    expect(CARD_TAG).toBe(rules.CARD_TAG);
    expect(SSN_TAG).toBe(rules.SSN_TAG);
  });
});

describe("K-06 v1 fixtures", () => {
  it("text-with-card-number.json is exactly what the scrub makes of the refused unscrubbed card", () => {
    const unscrubbed = fixture("invalid/refuse-unscrubbed-card.json");
    const expected = fixture("text-with-card-number.json");
    expect(rules.scrubbed(unscrubbed).length).toBeGreaterThan(0);
    expect(unscrubbed.body).toContain("4242 4242 4242 4242");
    const result = scrub(unscrubbed.body ?? "");
    expect(result).toEqual({ text: expected.body, cards: 1, ssns: 0 });
    expect(gatewayOutput(unscrubbed)).toEqual({ ...unscrubbed, ...expected, scrubbed: expected.scrubbed });
  });

  it("text-with-ssn.json is exactly what the scrub makes of the refused unscrubbed SSN", () => {
    const unscrubbed = fixture("invalid/refuse-unscrubbed-ssn.json");
    const expected = fixture("text-with-ssn.json");
    expect(rules.scrubbed(unscrubbed).length).toBeGreaterThan(0);
    expect(unscrubbed.body).toContain("123-45-6789");
    const result = scrub(unscrubbed.body ?? "");
    expect(result).toEqual({ text: expected.body, cards: 0, ssns: 1 });
    expect(gatewayOutput(unscrubbed)).toEqual({ ...unscrubbed, ...expected, scrubbed: expected.scrubbed });
  });

  it("the scrub's output passes the scrubbed rule for every fixture, refused ones included", () => {
    expect(fixtureIndex.fixtures.length).toBeGreaterThan(15);
    for (const entry of fixtureIndex.fixtures) {
      const event = fixture(entry.file);
      const output = gatewayOutput(event);
      expect(rules.scrubbed(output), entry.file).toEqual([]);
    }
  });
});

describe("K-06 v1.1 fixtures", () => {
  /** Each refused raw fixture and the accepted fixture that is its scrubbed twin (README, v1.1 fixtures). */
  const twins = [
    ["invalid/refuse-unscrubbed-card.json", "text-with-card-number.json"],
    ["invalid/refuse-unscrubbed-ssn.json", "text-with-ssn.json"],
    ["invalid/refuse-unscrubbed-card-next-to-digits.json", "text-with-card-next-to-digits.json"],
    ["invalid/refuse-unscrubbed-card-wide-spaces.json", "text-with-card-wide-spaces.json"],
    ["invalid/refuse-unscrubbed-card-non-ascii-digits.json", "text-with-card-non-ascii-digits.json"],
    ["invalid/refuse-unscrubbed-ssn-wide-form.json", "text-with-ssn-wide-form.json"],
  ] as const;

  it("the scrub's output passes scrubbedV1dot1, and v1's scrubbed, for every fixture, refused ones included", () => {
    expect(fixtureIndex.fixtures.length).toBeGreaterThan(25);
    for (const entry of fixtureIndex.fixtures) {
      const output = gatewayOutput(fixture(entry.file));
      expect(rules.scrubbedV1dot1(output), entry.file).toEqual([]);
      expect(rules.scrubbed(output), entry.file).toEqual([]);
    }
  });

  it("changes no fixture the contract accepts, and swaps something in a refused one exactly when scrubbedV1dot1 refuses it", () => {
    for (const entry of fixtureIndex.fixtures) {
      const event = fixture(entry.file);
      const output = gatewayOutput(event);
      if (entry.expect === "accept") {
        // Already scrubbed upstream of this call, so nothing is left to swap: the words stay as they are.
        expect({ ...output, scrubbed: event.scrubbed }, entry.file).toEqual(event);
        expect(output.scrubbed, entry.file).toEqual({ cards: 0, ssns: 0 });
      } else {
        expect(output.scrubbed.cards + output.scrubbed.ssns > 0, entry.file).toBe(
          rules.scrubbedV1dot1(event).length > 0,
        );
        // Whatever v1's rule refuses, v1.1's refuses too, so the scrub swapped it.
        if (rules.scrubbed(event).length > 0) {
          expect(output.scrubbed.cards + output.scrubbed.ssns, entry.file).toBeGreaterThan(0);
        }
      }
    }
  });

  it("each tagged fixture is exactly the scrub of its raw twin, with the contract's counts", () => {
    for (const [rawFile, taggedFile] of twins) {
      const raw = fixture(rawFile);
      const tagged = fixture(taggedFile);
      expect(rules.scrubbedV1dot1(raw).length, rawFile).toBeGreaterThan(0);
      expect(rules.scrubbedV1dot1(tagged), taggedFile).toEqual([]);
      const result = scrubInbound({ body: raw.body, subject: raw.email?.subject ?? null });
      expect(result.body, taggedFile).toBe(tagged.body);
      expect({ cards: result.cards, ssns: result.ssns }, taggedFile).toEqual(tagged.scrubbed);
    }
  });

  it("keeps the nine bare digits fixture as it is", () => {
    const event = fixture("text-with-nine-bare-digits.json");
    expect(event.body).toContain("123456789");
    expect(scrub(event.body ?? "")).toEqual({ text: event.body, cards: 0, ssns: 0 });
  });

  it("reads digits as K-06's reference does: every Unicode decimal digit has the value toAsciiDigits gives it", () => {
    let seen = 0;
    for (let point = 0; point <= 0x10ffff; point += 1) {
      const char = String.fromCodePoint(point);
      if (!/\p{Nd}/u.test(char)) continue;
      seen += 1;
      expect(String(digitValueOf(point)), point.toString(16)).toBe(rules.toAsciiDigits(char));
    }
    expect(seen).toBeGreaterThan(600);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Examples

describe("card numbers", () => {
  // Public test numbers published by the card networks and processors; none is a real account.
  const publicTestNumbers = [
    "4242424242424242", // Visa, 16
    "4111111111111111", // Visa, 16
    "4222222222222", // Visa, 13
    "5555555555554444", // Mastercard, 16
    "378282246310005", // American Express, 15
    "6011111111111117", // Discover, 16
    "3530111333300000", // JCB, 16
    "6200000000000047", // UnionPay, 16
  ];

  it("passesLuhn knows the public test numbers and refuses a changed last digit", () => {
    for (const number of publicTestNumbers) {
      expect(passesLuhn(number), number).toBe(true);
      const last = Number(number.slice(-1));
      expect(passesLuhn(`${number.slice(0, -1)}${String((last + 1) % 10)}`), number).toBe(false);
    }
  });

  it("tags each public test number whether typed bare, with spaces or with dashes", () => {
    for (const number of publicTestNumbers) {
      const spaced = number.replace(/(\d{4})(?=\d)/g, "$1 ");
      const dashed = number.replace(/(\d{4})(?=\d)/g, "$1-");
      for (const typed of [number, spaced, dashed]) {
        expect(scrub(`My card is ${typed}, thanks`), typed).toEqual({
          text: `My card is ${CARD_TAG}, thanks`,
          cards: 1,
          ssns: 0,
        });
      }
    }
  });

  it("tags two cards in one text and a card at either end of the text", () => {
    expect(scrub("4242 4242 4242 4242 or 5555-5555-5555-4444")).toEqual({
      text: `${CARD_TAG} or ${CARD_TAG}`,
      cards: 2,
      ssns: 0,
    });
    expect(scrub("4242424242424242")).toEqual({ text: CARD_TAG, cards: 1, ssns: 0 });
  });

  it("keeps prices, order numbers, phone numbers, dates, a Luhn-valid run too short, and runs split by a letter or a line break", () => {
    const kept = [
      "The fee is $20 and the deposit $1,250.00",
      "Order 4242424242424 is late", // 13 digits, fails Luhn: its only window
      "Call +1 555 555 0100 or 555-0104",
      "It was 2026-10-23 at 14:10",
      "Account 424242424242", // 12 digits, passes Luhn, too short
      "4242 4242\n4242 4242", // a line break ends a run (README default 2): two runs of 8 digits
      "4242 4242 a 4242 4242", // so does a letter
      "4242.4242.4242.4242", // and a dot (README open gaps)
      "",
    ];
    for (const text of kept) expect(scrub(text), text).toEqual({ text, cards: 0, ssns: 0 });
  });

  it("is rule-clean: what it leaves holds no card number by the contract's own readings, v1 and v1.1", () => {
    const result = scrub("a 4242 4242 4242 4242 b 4111-1111-1111-1111 c 4242424242424");
    expect(rules.cardNumbersIn(result.text)).toEqual([]);
    expect(rules.cardRunsInV1dot1(result.text)).toEqual([]);
    expect(result.cards).toBe(2);
  });
});

describe("card numbers, K-06 v1.1's wider reading", () => {
  it("a run of spaces, tabs, no-break spaces or dashes of any kind between groups is part of the card", () => {
    const separators = ["  ", "   ", "\t", " \t ", " ", "　", "–", "—", " – ", "--", "－"];
    for (const separator of separators) {
      const typed = ["4242", "4242", "4242", "4242"].join(separator);
      expect(scrub(`card ${typed} ok`), JSON.stringify(separator)).toEqual({
        text: `card ${CARD_TAG} ok`,
        cards: 1,
        ssns: 0,
      });
    }
  });

  it("a card next to other digits: the longest passing window at the leftmost start is the tag, the rest stays", () => {
    // README "Where the tag goes": the tag, then " 123" (fixture text-with-card-next-to-digits.json).
    expect(scrub("4111111111111111 123")).toEqual({ text: `${CARD_TAG} 123`, cards: 1, ssns: 0 });
    // Digits before a card join its run, and the leftmost window that passes wins even over the card itself: the
    // 16-digit window starting at the second digit is swapped (the convention, held by the reference test below).
    expect(scrub("123 4111111111111111")).toEqual({ text: `1${CARD_TAG}111`, cards: 1, ssns: 0 });
    expect(scrub("4111111111111111 and 4242424242424242")).toEqual({
      text: `${CARD_TAG} and ${CARD_TAG}`,
      cards: 2,
      ssns: 0,
    });
    // Two cards in one run without a gap: 32 digits, the first 19-digit window or shorter that passes goes first.
    const twoInARun = scrub("42424242424242424242424242424242");
    expect(twoInARun.cards).toBeGreaterThan(0);
    expect(rules.cardRunsInV1dot1(twoInARun.text)).toEqual([]);
  });

  it("a card number in non-ASCII digits: fullwidth, Arabic-Indic, Devanagari, and mathematical digits outside the BMP", () => {
    const shift = (digits: string, zero: number): string =>
      Array.from(digits, (d) => (/\d/.test(d) ? String.fromCodePoint(zero + Number(d)) : d)).join("");
    const card = "4242 4242 4242 4242";
    for (const zero of [0xff10, 0x0660, 0x06f0, 0x0966, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6]) {
      expect(scrub(`card ${shift(card, zero)} ok`), zero.toString(16)).toEqual({
        text: `card ${CARD_TAG} ok`,
        cards: 1,
        ssns: 0,
      });
    }
    // Mixed scripts in one card, and a digit outside the window keeps its own script.
    expect(scrub(`４242 ٤242 4242 4242 ١٢٣`)).toEqual({
      text: `${CARD_TAG} ١٢٣`,
      cards: 1,
      ssns: 0,
    });
    // A superscript two or a fraction is not a digit (not Nd): the run ends there.
    expect(scrub("4242²4242 4242 4242")).toEqual({
      text: "4242²4242 4242 4242",
      cards: 0,
      ssns: 0,
    });
  });

  it("a card number in an email subject, and in the body, are counted together", () => {
    expect(scrub("Re: my card 4242  4242  4242  4242")).toEqual({
      text: `Re: my card ${CARD_TAG}`,
      cards: 1,
      ssns: 0,
    });
    expect(
      scrubInbound({ body: "ok 4111-1111-1111-1111 123", subject: "card ４２４２４２４２４２４２４２４２" }),
    ).toEqual({
      body: `ok ${CARD_TAG} 123`,
      subject: `card ${CARD_TAG}`,
      cards: 2,
      ssns: 0,
    });
  });

  it("a run of 20 or more digits holds a window the scrub swaps, and what is left passes the rule", () => {
    // 20 digits of 4s and 2s: windows of 13 to 19 digits; a Luhn-valid window exists, so the scrub swaps one.
    const twenty = "42424242424242424242";
    const once = scrub(`Number ${twenty}`);
    expect(once.cards).toBeGreaterThan(0);
    expect(rules.cardRunsInV1dot1(once.text)).toEqual([]);
    expect(rules.scrubbedV1dot1({ body: once.text, email: null })).toEqual([]);
    // 25 and 40 digits, valid and not: whatever remains passes, and a second scrub changes nothing.
    for (const length of [20, 21, 22, 25, 30, 40, 100]) {
      for (let seed = 0; seed < 20; seed += 1) {
        const digits = Array.from({ length }, (_, k) => String((seed * 7 + k * 3 + (k % 5)) % 10)).join("");
        const result = scrub(`x ${digits} y`);
        expect(rules.cardRunsInV1dot1(result.text), digits).toEqual([]);
        expect(scrub(result.text), digits).toEqual({ text: result.text, cards: 0, ssns: 0 });
      }
    }
  });
});

describe("Social Security numbers", () => {
  it("tags the dashed and the spaced form, and counts them", () => {
    expect(scrub("It's 123-45-6789.")).toEqual({ text: `It's ${SSN_TAG}.`, cards: 0, ssns: 1 });
    expect(scrub("It's 123 45 6789.")).toEqual({ text: `It's ${SSN_TAG}.`, cards: 0, ssns: 1 });
    expect(scrub("123-45-6789 and 987 65 4321")).toEqual({
      text: `${SSN_TAG} and ${SSN_TAG}`,
      cards: 0,
      ssns: 2,
    });
  });

  it("keeps what is not one: nine bare digits, a digit next to a group, longer runs, phone numbers", () => {
    const kept = [
      "123456789",
      "1123-45-6789",
      "123-45-67890",
      "123456 45 6789", // six digits then 45 6789: the first group is not three digits
      "123 45 678", // a short last group
      "123\n45\n6789", // a line break is not a separator (README default 2)
      "123.45.6789",
      "555-0104",
      "+1 555 555 0100",
    ];
    for (const text of kept) expect(scrub(text), text).toEqual({ text, cards: 0, ssns: 0 });
  });

  it("tags the wider forms K-06 v1.1 names: mixed or repeated separators, a tab, an en dash, any script", () => {
    const wide = [
      "123-45 6789", // v1 kept it as mixed separators
      "123 45-6789",
      "123 - 45 - 6789",
      "123  45  6789",
      "123\t45\t6789",
      "123–45–6789", // en dash
      "123 — 45 — 6789", // em dash
      "123 45 6789", // no-break space
      "１２３-４５-６７８９", // fullwidth digits
      "١٢٣ ٤٥ ٦٧٨٩", // Arabic-Indic digits
      "𝟏𝟐𝟑-𝟒𝟓-𝟔𝟕𝟖𝟗", // mathematical digits (outside the BMP)
      "1２٣-४5-6789", // mixed scripts
    ];
    for (const text of wide) {
      expect(scrub(`It's ${text}.`), JSON.stringify(text)).toEqual({
        text: `It's ${SSN_TAG}.`,
        cards: 0,
        ssns: 1,
      });
    }
  });

  it("an SSN next to a dash or a separator but not to a digit is still one (v1.1 looks only at digits)", () => {
    expect(scrub("123-45-6789-1")).toEqual({ text: `${SSN_TAG}-1`, cards: 0, ssns: 1 });
    expect(scrub("-123-45-6789")).toEqual({ text: `-${SSN_TAG}`, cards: 0, ssns: 1 });
    expect(scrub("123-45-6789\n123-45-6789")).toEqual({ text: `${SSN_TAG}\n${SSN_TAG}`, cards: 0, ssns: 2 });
  });

  it("an SSN in an email subject is tagged too", () => {
    expect(scrubInbound({ body: null, subject: "Re: ssn 123 – 45 – 6789" })).toEqual({
      body: null,
      subject: `Re: ssn ${SSN_TAG}`,
      cards: 0,
      ssns: 1,
    });
  });

  it("tags a card and an SSN together", () => {
    expect(scrub("card 4242 4242 4242 4242 ssn 123-45-6789")).toEqual({
      text: `card ${CARD_TAG} ssn ${SSN_TAG}`,
      cards: 1,
      ssns: 1,
    });
  });
});

describe("scrubInbound", () => {
  it("scrubs the body and an email's subject, counts both together, and keeps a null null", () => {
    expect(scrubInbound({ body: "card 4242424242424242", subject: "re: ssn 123-45-6789" })).toEqual({
      body: `card ${CARD_TAG}`,
      subject: `re: ssn ${SSN_TAG}`,
      cards: 1,
      ssns: 1,
    });
    expect(scrubInbound({ body: null, subject: null })).toEqual({
      body: null,
      subject: null,
      cards: 0,
      ssns: 0,
    });
    expect(scrubInbound({ body: "hello", subject: null })).toEqual({
      body: "hello",
      subject: null,
      cards: 0,
      ssns: 0,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Property tests, seeded so a failure repeats

/** mulberry32: a small seeded generator, so every run draws the same cases. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const int = (random: Random, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));
const pick = <T>(random: Random, items: readonly T[]): T => items[int(random, 0, items.length - 1)] as T;

function randomDigits(random: Random, count: number): string {
  let digits = "";
  for (let k = 0; k < count; k += 1) digits += String(int(random, 0, 9));
  return digits;
}

/** The payload with the one check digit that makes it pass Luhn. */
function withCheckDigit(payload: string): string {
  for (let check = 0; check <= 9; check += 1) {
    const candidate = `${payload}${String(check)}`;
    if (passesLuhn(candidate)) return candidate;
  }
  throw new Error("no check digit found");
}

/** A string of digits of this length that passes the Luhn check. */
const luhnValid = (random: Random, length: number): string =>
  withCheckDigit(randomDigits(random, length - 1));

/** A string of digits of this length that fails the Luhn check. */
function luhnInvalid(random: Random, length: number): string {
  const valid = luhnValid(random, length);
  const last = Number(valid.slice(-1));
  return `${valid.slice(0, -1)}${String((last + int(random, 1, 9)) % 10)}`;
}

/** The digits cut into groups of this size range, one space or dash between two groups, or none at all. */
function typed(random: Random, digits: string, minGroup: number, maxGroup: number): string {
  const separator = pick(random, ["", " ", "-"] as const);
  const mixed = random() < 0.3;
  let out = "";
  let at = 0;
  while (at < digits.length) {
    const size = int(random, minGroup, maxGroup);
    out +=
      (at === 0 ? "" : mixed ? pick(random, [" ", "-", ""] as const) : separator) +
      digits.slice(at, at + size);
    at += size;
  }
  return out;
}

const BEFORE = ["", "My card is ", "card: ", "pay with ", "Number\n", "ok, "] as const;
const AFTER = ["", ", thanks", ".", " ok?", "\nbye", " (exp soon)"] as const;

describe("properties", () => {
  const CASES = 3000;

  it("any Luhn-valid 13 to 19 digit run, bare or with single spaces or dashes, is tagged", () => {
    const random = seeded(242);
    for (let k = 0; k < CASES; k += 1) {
      const digits = luhnValid(random, int(random, 13, 19));
      const run = typed(random, digits, 1, 8);
      const before = pick(random, BEFORE);
      const after = pick(random, AFTER);
      const result = scrub(`${before}${run}${after}`);
      expect(result, run).toEqual({ text: `${before}${CARD_TAG}${after}`, cards: 1, ssns: 0 });
    }
  });

  it("a digit run under 13 digits, or of 13 digits that fails Luhn (its only window), is kept as it was", () => {
    const random = seeded(2420);
    for (let k = 0; k < CASES; k += 1) {
      const length = pick(random, [3, 6, 9, 10, 12, 13] as const);
      const digits = length === 13 ? luhnInvalid(random, length) : luhnValid(random, length);
      // Groups of 4 or more: no group of 3, 2 and 4 digits, so the run is never also a Social Security number.
      const run = typed(random, digits, 4, 8);
      const text = `${pick(random, BEFORE)}${run}${pick(random, AFTER)}`;
      expect(scrub(text), text).toEqual({ text, cards: 0, ssns: 0 });
    }
  });

  it("a text with several runs tags exactly the Luhn-valid ones of 13 to 19 digits, and keeps a failing 13 digit run", () => {
    const random = seeded(24200);
    for (let k = 0; k < 1000; k += 1) {
      const parts: string[] = [];
      const expected: string[] = [];
      let cards = 0;
      for (let n = int(random, 1, 5); n > 0; n -= 1) {
        const valid = random() < 0.5;
        const length = valid ? int(random, 13, 19) : 13;
        const run = typed(random, valid ? luhnValid(random, length) : luhnInvalid(random, length), 4, 8);
        parts.push(run);
        expected.push(valid ? CARD_TAG : run);
        if (valid) cards += 1;
      }
      const text = parts.join(" and ");
      expect(scrub(text), text).toEqual({ text: expected.join(" and "), cards, ssns: 0 });
    }
  });

  /** Random text of digits (ASCII, fullwidth and Arabic-Indic), every kind of separator, letters and line breaks. */
  function randomText(random: Random): string {
    const pieces = [
      ...Array.from({ length: 24 }, (_, k) => String(k % 10)),
      "４",
      "２",
      "٤",
      "٢",
      " ",
      " ",
      "  ",
      "\t",
      "-",
      "-",
      "–",
      "—",
      " ",
      "　",
      "ab",
      "$",
      ".",
      ",",
      "[",
      "]",
      "\n",
    ];
    let text = "";
    for (let n = int(random, 0, 120); n > 0; n -= 1) text += pick(random, pieces);
    // Some random text also carries a number the scrub must find, next to digits that may join it.
    const joiners = ["", " ", "  ", "-", " – ", "\t"] as const;
    if (random() < 0.5) {
      const card = luhnValid(random, int(random, 13, 19));
      const joined = Array.from(card).reduce(
        (out, d, at) => out + (at === 0 ? "" : pick(random, joiners)) + d,
        "",
      );
      text += `${pick(random, [" ", "", "\n"] as const)}${joined}${pick(random, joiners)}${randomDigits(random, int(random, 0, 4))}`;
    }
    if (random() < 0.5)
      text += ` ${randomDigits(random, 3)}${pick(random, joiners)}${randomDigits(random, 2)}${pick(random, joiners)}${randomDigits(random, 4)}`;
    return text;
  }

  it("whatever text comes in, what goes out passes scrubbedV1dot1 and v1's scrubbed, and scrubbing it again changes nothing", () => {
    const random = seeded(242000);
    for (let k = 0; k < 4000; k += 1) {
      const text = randomText(random);
      const once = scrub(text);
      expect(rules.scrubbedV1dot1({ body: once.text, email: null }), text).toEqual([]);
      expect(rules.scrubbed({ body: once.text, email: null }), text).toEqual([]);
      expect(scrub(once.text), text).toEqual({ text: once.text, cards: 0, ssns: 0 });
    }
  });

  /**
   * The README's convention read literally and slowly: from the left, the first window that passes, the longest at
   * its start, goes for the tag; repeat until no window passes; then each Social Security number in turn. Digits are
   * read through the rule's toAsciiDigits, which keeps every position for the digits this test draws (all in the BMP).
   */
  function referenceScrub(text: string): { text: string; cards: number; ssns: number } {
    const separator = String.raw`[\p{Zs}\t\p{Pd}]`;
    let current = text;
    let cards = 0;
    for (let again = true; again;) {
      again = false;
      const ascii = rules.toAsciiDigits(current);
      for (const match of ascii.matchAll(new RegExp(String.raw`[0-9](?:${separator}*[0-9])*`, "gu"))) {
        const positions: number[] = [];
        for (let k = 0; k < match[0].length; k += 1) {
          if (/[0-9]/.test(match[0].charAt(k))) positions.push(match.index + k);
        }
        let hit: { at: number; length: number } | null = null;
        for (let at = 0; at < positions.length && hit === null; at += 1) {
          for (let length = Math.min(19, positions.length - at); length >= 13; length -= 1) {
            const digits = positions
              .slice(at, at + length)
              .map((position) => ascii.charAt(position))
              .join("");
            if (passesLuhn(digits)) {
              hit = { at, length };
              break;
            }
          }
        }
        if (hit !== null) {
          const first = positions[hit.at] ?? 0;
          const last = positions[hit.at + hit.length - 1] ?? 0;
          current = `${current.slice(0, first)}${CARD_TAG}${current.slice(last + 1)}`;
          cards += 1;
          again = true;
          break;
        }
      }
    }
    const ssnForm = new RegExp(
      String.raw`(?<![0-9])[0-9]{3}${separator}+[0-9]{2}${separator}+[0-9]{4}(?![0-9])`,
      "u",
    );
    let ssns = 0;
    for (;;) {
      const found = ssnForm.exec(rules.toAsciiDigits(current));
      if (found === null) break;
      current = `${current.slice(0, found.index)}${SSN_TAG}${current.slice(found.index + found[0].length)}`;
      ssns += 1;
    }
    return { text: current, cards, ssns };
  }

  it("on random text, the scrub is exactly the README's convention read literally, text and counts", () => {
    const random = seeded(1070);
    let tagged = 0;
    for (let k = 0; k < 4000; k += 1) {
      const text = randomText(random);
      const expected = referenceScrub(text);
      if (expected.cards + expected.ssns > 0) tagged += 1;
      expect(scrub(text), text).toEqual(expected);
    }
    expect(tagged).toBeGreaterThan(2000);
  });

  it("a text of nothing but one kind of character, and the edges of the text, are handled", () => {
    for (const text of [
      "",
      " ",
      "-",
      "9",
      "–",
      "\n",
      "[card number]",
      "[SSN]",
      "\ud800",
      "4242\ud800424242424242424242",
    ]) {
      expect(rules.scrubbedV1dot1({ body: scrub(text).text, email: null }), text).toEqual([]);
    }
    expect(scrub(" 4242424242424242 ")).toEqual({ text: ` ${CARD_TAG} `, cards: 1, ssns: 0 });
    expect(scrub("-4242-4242-4242-4242-")).toEqual({ text: `-${CARD_TAG}-`, cards: 1, ssns: 0 });
    expect(scrub("123-45-6789")).toEqual({ text: SSN_TAG, cards: 0, ssns: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Speed

// The time is held by its growth, not by a bound in milliseconds: a bound in milliseconds fails on a busy machine
// (T-242's 5 ms failed at 7.9 ms with 17 parallel workers, and passed alone). The text is made 4 times as long and the
// timed runs of each length are compared: a scrub linear in the text takes about 4 times as long, one quadratic in it
// about 16 times, and the fixed limit is 8 times: twice the linear figure and half the quadratic one.
//
// What is timed is the scrub's own cost (T-1074; a median of wall-clock times still failed with 5 builders running
// vitest at once: 10.27 against 8 in T-143, a 5 s timeout in T-182):
//  - each run is timed by the CPU this process spends (process.cpuUsage, user plus system), not by the wall clock, so
//    the time a busy machine keeps the process waiting is not counted. Vitest's unit project runs each test file in its
//    own forked process (the default pool is forks, with isolation, and vitest.config.ts sets neither), and the tests
//    of one file run one after another, so no other file's work and no other test's work is in the figure;
//  - the fastest run of each length is kept, not the median: noise only ever adds time, so the fastest run is the
//    closest to the scrub's own cost;
//  - the runs of the two lengths alternate, so a change in the machine's speed (a clock that steps down, a hotter
//    cache) over the measure reaches both lengths alike.

/** The CPU time in microseconds this process spends running `run`. */
function cpuTimed(run: () => unknown): number {
  const before = process.cpuUsage();
  run();
  const spent = process.cpuUsage(before);
  return spent.user + spent.system;
}

/**
 * How many times as long `run` takes on the `large` text as on the `small` one, by the CPU time of the fastest of
 * `runs` alternating runs of each (after `warmups` runs of each that are not kept).
 */
function growthOf(
  run: (text: string) => unknown,
  small: string,
  large: string,
  runs: number,
  warmups: number,
): number {
  for (let warm = 0; warm < warmups; warm += 1) {
    run(small);
    run(large);
  }
  let fastestSmall = Number.POSITIVE_INFINITY;
  let fastestLarge = Number.POSITIVE_INFINITY;
  for (let at = 0; at < runs; at += 1) {
    fastestSmall = Math.min(
      fastestSmall,
      cpuTimed(() => run(small)),
    );
    fastestLarge = Math.min(
      fastestLarge,
      cpuTimed(() => run(large)),
    );
  }
  // A CPU clock that reads 0 for a very short run must not divide by zero: 1 microsecond is below what a run takes.
  return fastestLarge / Math.max(fastestSmall, 1);
}

/** How many times as long the scrub takes on `text` made 4 times as long, by the fastest of alternating runs. */
function growth(make: (length: number) => string, length: number): number {
  const small = make(length);
  const large = make(length * 4);
  expect(small.length).toBeGreaterThanOrEqual(length);
  expect(large.length).toBeGreaterThanOrEqual(length * 4);
  return growthOf(scrub, small, large, 15, 5);
}

const LINEAR_LIMIT_FOR_4X = 8;

/** Text of at least this many characters made by repeating a unit, ended with a card and an SSN. */
const repeated = (unit: string) => (length: number) => {
  const text = unit.repeat(Math.ceil(length / unit.length));
  return `${text} card 4242 4242 4242 4242 ssn 123-45-6789 end `;
};

describe("speed: the time grows in step with the length of the text", () => {
  const shapes: [string, (length: number) => string][] = [
    [
      "prices, order numbers and phone numbers",
      repeated("Order 4242424242424241 total $1,250.00 call 555-0104. "),
    ],
    ["one unbroken run of digits and separators", repeated("1 2-3 ")],
    ["one unbroken run of digits and wide separators", repeated("1  2–3\t")],
    ["a card after card", repeated("card 4242 4242 4242 4242 ok ")],
    ["a Social Security number after another", repeated("ssn 123-45-6789 ok ")],
    ["non-ASCII digits", repeated("４２４２ ٤٢ 𝟒 ")],
    ["20 digits and more in a run", repeated("42424242424242424242 ")],
  ];

  for (const [name, make] of shapes) {
    it(`${name}: 4 times the text takes less than ${String(LINEAR_LIMIT_FOR_4X)} times as long`, () => {
      expect(growth(make, 10_000)).toBeLessThan(LINEAR_LIMIT_FOR_4X);
    });
  }

  it("the check tells linear from quadratic: a deliberately quadratic scrub of the same texts takes over the limit", () => {
    // A stand-in that does what a bad scrub does (looks again from the start of the text for each digit), run through
    // the same growth measure, must fail it: this holds the check to its word.
    const quadratic = (text: string): number => {
      let seen = 0;
      for (let at = 0; at < text.length; at += 1) {
        for (let back = 0; back < at; back += 1) seen += text.charCodeAt(back) & 1;
      }
      return seen;
    };
    const make = repeated("Order 4242424242424241 total $1,250.00 call 555-0104. ");
    // The texts are shorter than the shapes' (1 000 and 4 000 characters), so the stand-in finishes in well under a
    // second of CPU even on a loaded machine; its ratio still reads 14 to 16, nearly twice the limit.
    const small = make(1_000);
    const large = make(4_000);
    expect(growthOf(quadratic, small, large, 7, 2)).toBeGreaterThan(LINEAR_LIMIT_FOR_4X);
  });
});
