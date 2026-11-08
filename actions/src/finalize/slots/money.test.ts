// A price is always formatted from integer cents with its currency (T-310, "Proves it with"; CQ-09: money in integer
// cents with a currency code; contracts/common formats.v1 `money`).

import { describe, expect, it } from "vitest";
import moneyOk from "../../../../contracts/common/fixtures/money.ok.json";
import slotsJson from "../../../../contracts/message-plan/fixtures/slots.json";
import { fillText } from "./fill";
import { MoneyFormatError, formatMoney } from "./money";
import { sampleSource } from "./test-support";
import type { Money, SlotSource } from "./types";

/** Intl puts a no-break space between a currency code and its amount ("KWD 1.234"). */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/** Every money slot of slots.json. */
const MONEY_SLOTS = slotsJson.slots.filter((slot) => slot.valueType === "money").map((slot) => slot.name);

/** The sample cast with `amount` as the one fact the money slot `name` reads. */
function withAmount(name: string, amount: Money): SlotSource {
  const source = sampleSource();
  const amounts: Record<string, Money> = {};
  const ledger: Record<string, Money> = {};
  const change: { price?: Money } = {};
  if (["price", "fee", "deposit", "rest", "paid"].includes(name)) amounts[name] = amount;
  else if (["paidnow", "due", "back", "later", "backlate"].includes(name)) ledger[name] = amount;
  else if (name === "change.price") change.price = amount;
  else throw new Error(`${name} is a money slot this test does not know`);
  return { ...source, facts: { ...source.facts, amounts, ledger, change } };
}

/** A value of the wrong form, as a database row or a careless caller might hand it over. */
function loose(value: unknown): Money {
  return value as Money;
}

describe("formatMoney: whole cents with their currency (CQ-09)", () => {
  it.each([
    [3500, "USD", "$35"],
    [1250, "USD", "$12.50"],
    [120050, "USD", "$1,200.50"],
    [99, "USD", "$0.99"],
    [0, "USD", "$0"],
    [3500, "EUR", "€35"],
    [3550, "GBP", "£35.50"],
    [3500, "JPY", "¥3,500"],
    [1234, "KWD", "KWD 1.234"],
  ])("%i cents of %s read %s", (cents, currency, words) => {
    expect(formatMoney({ cents, currency }).replaceAll(NO_BREAK_SPACE, " ")).toBe(words);
  });

  it("reads the shared money fixture (formats.v1 money.ok.json: 4500 USD)", () => {
    const amount: Money = moneyOk;
    expect(formatMoney(amount)).toBe("$45");
  });

  it.each([
    ["a decimal", { cents: 35.5, currency: "USD" }],
    ["dollars as a string", { cents: "3500", currency: "USD" }],
    ["a typed price", "$35"],
    ["a float price", 35],
    ["an amount past a safe integer", { cents: 2 ** 53, currency: "USD" }],
    ["no currency", { cents: 3500 }],
    ["a lowercase currency", { cents: 3500, currency: "usd" }],
    ["a currency that is no ISO 4217 code", { cents: 3500, currency: "ZZQ" }],
    ["an amount below zero", { cents: -3500, currency: "USD" }],
    ["nothing", null],
  ])("refuses %s", (_what, value) => {
    expect(() => formatMoney(loose(value))).toThrow(MoneyFormatError);
  });
});

describe("every money slot is formatted from integer cents with its currency", () => {
  it("covers each money slot of slots.json", () => {
    expect([...MONEY_SLOTS].sort()).toEqual([
      "back",
      "backlate",
      "change.price",
      "deposit",
      "due",
      "fee",
      "later",
      "paid",
      "paidnow",
      "price",
      "rest",
    ]);
  });

  it.each(MONEY_SLOTS)("%s reads $1,234.56 from 123456 USD and ¥3,500 from 3500 JPY", (name) => {
    const dollars = fillText(`{{${name}}}`, withAmount(name, { cents: 123456, currency: "USD" }));
    expect(dollars).toEqual({
      ok: true,
      text: "$1,234.56",
      slotValues: [{ slot: name, value: "$1,234.56" }],
    });
    const yen = fillText(`{{${name}}}`, withAmount(name, { cents: 3500, currency: "JPY" }));
    expect(yen.ok && yen.text).toBe("¥3,500");
  });

  it.each(MONEY_SLOTS)("%s stays unfilled, never written, when its amount is not whole cents", (name) => {
    for (const bad of [{ cents: 35.5, currency: "USD" }, "$35", 35, { cents: 3500, currency: "dollars" }]) {
      const filled = fillText(`Total: {{${name}}}`, withAmount(name, loose(bad)));
      expect(filled.ok).toBe(false);
      expect(filled.text).toBe(`Total: {{${name}}}`);
      expect(filled.slotValues).toEqual([]);
    }
  });

  it("fills a record row's amounts from cents too: pay.price on A6-14's path reads the due", () => {
    const source = sampleSource();
    const filled = fillText("{{pay.price}}", {
      ...source,
      facts: { ...source.facts, ledger: { ...source.facts.ledger, due: { cents: 3550, currency: "USD" } } },
    });
    expect(filled.ok && filled.text).toBe("$35.50, paid at the chair");
  });

  it("leaves a record row unfilled when an amount inside it is not whole cents", () => {
    const source = sampleSource();
    const filled = fillText("{{pay.price}}", {
      ...source,
      facts: {
        ...source.facts,
        ledger: { ...source.facts.ledger, due: loose({ cents: 35.5, currency: "USD" }) },
      },
    });
    expect(filled.ok).toBe(false);
    expect(filled.text).toBe("{{pay.price}}");
  });
});
