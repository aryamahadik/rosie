// The gold store's check of one item (T-470, validate.ts), against T-003's shared harness on K-10 v1's own item
// fixtures: the same verdict on each, and the same lines, with a field's name added where a line is about a field.
import { describe, expect, it } from "vitest";

import type { GoldItem } from "../../../../contracts/generated/eval-set/eval-set.v1";
import { formatErrors as harnessFormatErrors } from "../../../../tests/contract/_harness";
import {
  ACCEPTED_ITEMS,
  HARNESS_REPORT,
  ITEM_FIXTURES,
  REFUSED_ITEM_FILE,
  acceptedItem,
  fixtureValue,
} from "./test-support";
import {
  K10_SCHEMA_FILE,
  checkGoldItem,
  formatErrors,
  goldItemSchemaCheck,
  goldItemSchemaFiles,
} from "./validate";

/** The S1-02 item as a human-labelled live turn: K-10 v1 accepts the shape (made-up words, no real person's). */
function humanLabelled(): GoldItem {
  const item = acceptedItem("item-low-stakes-s1-02");
  if (item.seed.kind !== "fixtureSet") throw new Error("the S1-02 item has a fixture set seed");
  item.labelledBy = "human";
  item.seed = {
    kind: "liveTurn",
    turnId: "turn-sample-s1-02",
    business: "biz-movers",
    openQuestions: item.seed.openQuestions,
    booking: null,
    flags: [],
  };
  return item;
}

describe("K-10 v1's item fixtures, as T-003's harness reads them", () => {
  it("are listed in an index the harness reads with no problem, some to accept and the card's to refuse", () => {
    expect(HARNESS_REPORT.problems).toEqual([]);
    expect(ACCEPTED_ITEMS.length).toBeGreaterThan(0);
    expect(ITEM_FIXTURES.filter((entry) => entry.expect === "refuse").map((entry) => entry.file)).toEqual([
      REFUSED_ITEM_FILE,
    ]);
    for (const entry of ITEM_FIXTURES) expect(entry.problems, entry.file).toEqual([]);
  });
});

describe("checkGoldItem", () => {
  for (const entry of ITEM_FIXTURES) {
    it(`gives the harness's verdict on ${entry.file}`, () => {
      const problems = checkGoldItem(fixtureValue(entry.file));
      expect(entry.outcome).toBe(entry.expect === "accept" ? "accepted" : "refused");
      if (entry.outcome === "accepted") expect(problems).toEqual([]);
      else expect(problems.length).toBeGreaterThan(0);
    });
  }

  it("words each line as the harness's formatErrors, and names the field a line is about", () => {
    const { errors, problems } = goldItemSchemaCheck(fixtureValue(REFUSED_ITEM_FILE));
    const lines = harnessFormatErrors(errors);
    expect(lines).toEqual(["/turns/0/label/parts/0/fields/0 must have required property 'value'"]);
    expect(problems).toEqual([`${lines[0] ?? ""} (field "kinds")`]);
    expect(checkGoldItem(fixtureValue(REFUSED_ITEM_FILE))).toEqual(problems);
  });

  it("prints Ajv's errors as the harness's formatErrors does, extra words for additional properties and enums included", () => {
    const wrongKind = acceptedItem("item-typo-s1-02") as unknown as Record<string, unknown>;
    wrongKind.kind = "chat";
    for (const value of [fixtureValue("report-journey-1-sample.json"), wrongKind, null, []]) {
      const { errors } = goldItemSchemaCheck(value);
      expect(errors.length).toBeGreaterThan(0);
      expect(formatErrors(errors)).toEqual(harnessFormatErrors(errors));
    }
    const { errors } = goldItemSchemaCheck(wrongKind);
    expect(formatErrors(errors)).toContain(
      "/kind must be equal to one of the allowed values (turn, wholeChat)",
    );
  });

  it("names the field in a line about its value", () => {
    const item = acceptedItem("item-two-requests-s11-12");
    const price = item.turns[0].label.parts[1]?.fields[1];
    if (price === undefined) throw new Error("the two-requests item's second part has a price field");
    price.value = "$12 a foot";
    const { errors, problems } = goldItemSchemaCheck(item);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.length).toBe(errors.length);
    for (const line of problems)
      expect(line).toMatch(/^\/turns\/0\/label\/parts\/1\/fields\/1.* \(field "price"\)$/);
  });

  it("refuses a human-labelled live turn, which K-10 v1 itself accepts (BP rule 9)", () => {
    const item = humanLabelled();
    expect(goldItemSchemaCheck(item).problems).toEqual([]);
    const problems = checkGoldItem(item);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^\/labelledBy is human .*never enters the repository/);
  });

  it("refuses what is not an item, with K-10 v1's lines", () => {
    expect(checkGoldItem(fixtureValue("report-journey-1-sample.json"))).toContain(
      "(root) must NOT have additional properties (reportId)",
    );
    expect(checkGoldItem(null)).toEqual(["(root) must be object"]);
  });

  it("loads K-10 v1 first, then each schema it refers to, once", () => {
    const files = goldItemSchemaFiles();
    expect(files[0]).toBe(K10_SCHEMA_FILE);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toEqual(
      expect.arrayContaining([
        "bundle/bundle.v1.schema.json",
        "model/model.v1.schema.json",
        "event-trace/event-trace.v1.schema.json",
        "common/formats.v1.schema.json",
      ]),
    );
  });
});
