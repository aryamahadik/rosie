// Tests of the card and SSN scrub (T-242, C-045). Test values only: the public test card numbers and the printed
// sample Social Security number K-06's fixtures use (rule 9). The contract's own named rule `scrubbed` decides what an
// unscrubbed body is, so it is loaded from contracts/inbound-event and run on the scrub's output.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { CARD_TAG, SSN_TAG, passesLuhn, scrub, scrubInbound } from "./scrub";

// ---------------------------------------------------------------------------------------------------------------
// K-06 v1: its fixtures and its named rule

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
  hasSsn: (words: string) => boolean;
  cardNumbersIn: (words: string) => string[];
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

  it("changes no fixture the contract accepts, and counts what it swapped in the refused ones", () => {
    for (const entry of fixtureIndex.fixtures) {
      const event = fixture(entry.file);
      const output = gatewayOutput(event);
      if (entry.expect === "accept") {
        // Already scrubbed upstream of this call, so nothing is left to swap: the words stay as they are.
        expect({ ...output, scrubbed: event.scrubbed }, entry.file).toEqual(event);
        expect(output.scrubbed, entry.file).toEqual({ cards: 0, ssns: 0 });
      } else {
        expect(output.scrubbed.cards + output.scrubbed.ssns > 0, entry.file).toBe(
          rules.scrubbed(event).length > 0,
        );
      }
    }
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

  it("keeps prices, order numbers, phone numbers, dates and a Luhn-valid run too short or too long", () => {
    const kept = [
      "The fee is $20 and the deposit $1,250.00",
      "Order 4242424242424241 is late", // 16 digits, fails Luhn
      "Call +1 555 555 0100 or 555-0104",
      "It was 2026-10-23 at 14:10",
      "Account 424242424242", // 12 digits, passes Luhn, too short
      "Number 42424242424242424242", // 20 digits, too long to be a card by the 13 to 19 rule
      "4242  4242  4242  4242", // two spaces between groups: not one run
      "",
    ];
    for (const text of kept) expect(scrub(text), text).toEqual({ text, cards: 0, ssns: 0 });
  });

  it("is rule-clean: what it leaves holds no card number by the contract's own reading", () => {
    const result = scrub("a 4242 4242 4242 4242 b 4111-1111-1111-1111 c 4242424242424241");
    expect(rules.cardNumbersIn(result.text)).toEqual([]);
    expect(result.cards).toBe(2);
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

  it("keeps what is not one: nine bare digits, mixed separators, longer runs, phone numbers", () => {
    const kept = [
      "123456789",
      "123-45 6789",
      "1123-45-6789",
      "123-45-67890",
      "123-45-6789-1",
      "-123-45-6789",
      "555-0104",
      "+1 555 555 0100",
    ];
    for (const text of kept) expect(scrub(text), text).toEqual({ text, cards: 0, ssns: 0 });
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

  it("a digit run that fails Luhn, or is under 13 or over 19 digits, is kept as it was", () => {
    const random = seeded(2420);
    for (let k = 0; k < CASES; k += 1) {
      const length = pick(random, [3, 6, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 25] as const);
      const digits = length >= 13 && length <= 19 ? luhnInvalid(random, length) : luhnValid(random, length);
      // Groups of 4 or more: no group of 3, 2 and 4 digits, so the run is never also a Social Security number.
      const run = typed(random, digits, 4, 8);
      const text = `${pick(random, BEFORE)}${run}${pick(random, AFTER)}`;
      expect(scrub(text), text).toEqual({ text, cards: 0, ssns: 0 });
    }
  });

  it("a text with several runs tags exactly the Luhn-valid ones of 13 to 19 digits", () => {
    const random = seeded(24200);
    for (let k = 0; k < 1000; k += 1) {
      const parts: string[] = [];
      const expected: string[] = [];
      let cards = 0;
      for (let n = int(random, 1, 5); n > 0; n -= 1) {
        const valid = random() < 0.5;
        const length = int(random, 13, 19);
        const run = typed(random, valid ? luhnValid(random, length) : luhnInvalid(random, length), 4, 8);
        parts.push(run);
        expected.push(valid ? CARD_TAG : run);
        if (valid) cards += 1;
      }
      const text = parts.join(" and ");
      expect(scrub(text), text).toEqual({ text: expected.join(" and "), cards, ssns: 0 });
    }
  });

  it("whatever text comes in, what goes out passes the scrubbed rule, and scrubbing it again changes nothing", () => {
    const random = seeded(242000);
    const alphabet = "0123456789012345678901234567890123456789  --ab$.,[]\n";
    for (let k = 0; k < 4000; k += 1) {
      let text = "";
      for (let n = int(random, 0, 120); n > 0; n -= 1)
        text += alphabet.charAt(int(random, 0, alphabet.length - 1));
      // Some random text also carries a number the scrub must find, next to digits that may join it.
      if (random() < 0.4)
        text += ` ${typed(random, luhnValid(random, int(random, 13, 19)), 1, 5)}${randomDigits(random, int(random, 0, 3))}`;
      if (random() < 0.4)
        text += ` ${randomDigits(random, 3)}${pick(random, ["-", " "] as const)}${randomDigits(random, 2)}${pick(random, ["-", " "] as const)}${randomDigits(random, 4)}`;
      const once = scrub(text);
      expect(rules.scrubbed({ body: once.text, email: null }), text).toEqual([]);
      expect(scrub(once.text), text).toEqual({ text: once.text, cards: 0, ssns: 0 });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Speed

describe("speed", () => {
  it("runs in under 5 ms on a 2,000-character text that holds a card, an SSN and many digit runs", () => {
    const unit = "Order 4242424242424241 total $1,250.00 call 555-0104. ";
    let text = "";
    while (text.length < 1900) text += unit;
    text = `${text.slice(0, 1900)} card 4242 4242 4242 4242 ssn 123-45-6789 end `;
    text = text.padEnd(2000, ".");
    expect(text).toHaveLength(2000);
    const sample = scrub(text);
    expect(sample.cards).toBe(1);
    expect(sample.ssns).toBe(1);
    for (let warm = 0; warm < 20; warm += 1) scrub(text);
    let slowest = 0;
    for (let run = 0; run < 50; run += 1) {
      const started = performance.now();
      scrub(text);
      slowest = Math.max(slowest, performance.now() - started);
    }
    expect(slowest).toBeLessThan(5);
  });

  it("stays fast on 2,000 characters of one unbroken run of digits and separators", () => {
    const text = "1 2-3 ".repeat(334).slice(0, 2000);
    const started = performance.now();
    scrub(text);
    expect(performance.now() - started).toBeLessThan(5);
  });
});
