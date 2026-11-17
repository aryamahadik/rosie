// T-1429: limit 2's OwnerRules bound to K-05 v1.18's readTermsSources (owner-rules.ts), driven by a fake of the read that
// answers the contract's own v1.18 exchanges, never by a database and never mocking the binding or the evaluator:
//   - rulesOf answers the exchange's rules, each as RuleRow field by field without its version, equal to T-300's own
//     reading of the same K-26 rows (../../../rules/evaluator/test-support.ts ruleRowOf) in force at the time asked, and
//     the evaluator reads every one of them (no row refused);
//   - notFound and transient are passed on; an answer for another business, or holding its row, fails closed; whatever
//     db/repo throws leaves as it was thrown.

import { describe, expect, it } from "vitest";

import type { ReadTermsSourcesOutcome, ReadTermsSourcesRequest } from "../../../../../db/repo/catalog-reads";
import {
  acceptedCatalogFiles,
  catalogExchange,
  rowsOf,
  thrownBy,
  type CatalogExchange,
} from "../../../domain/catalog/pg/test-support";
import { evaluateRules, type RuleRow } from "../../../rules/evaluator";
import { ruleRowOf } from "../../../rules/evaluator/test-support";
import { TONIGHT_AT_9 } from "../test-support";
import { OwnerRulesReadError, ownerRulesOf, type TermsSourcesRead } from "./index";

const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";

/** Every accepted v1.18 readTermsSources exchange, by its version. */
const TERMS = acceptedCatalogFiles().filter((file) => catalogExchange(file).call === "readTermsSources");

/** The read answering `outcome` to any request, each request written down. */
function answering(outcome: object, asked: ReadTermsSourcesRequest[] = []): TermsSourcesRead {
  return (request) => {
    asked.push(structuredClone(request));
    return Promise.resolve(structuredClone(outcome) as ReadTermsSourcesOutcome);
  };
}

/** A request's string field; fails the test when it has none. */
function field(exchange: CatalogExchange, name: string): string {
  const value = exchange.request[name];
  if (typeof value !== "string") throw new Error(`the request has no ${name}`);
  return value;
}

/** The K-26 rules rows of an exchange's world, of `businessId`, in force at `at` ([from, to)), as T-300 reads them. */
function seededRules(file: string, businessId: string, at: string): RuleRow[] {
  const atMs = Date.parse(at);
  return rowsOf(file)
    .filter((row) => row.table === "rules" && row.values.business_id === businessId)
    .map((row) => ruleRowOf(row.values))
    .filter(
      (rule) =>
        Date.parse(rule.effectiveFrom) <= atMs &&
        (rule.effectiveTo === null || atMs < Date.parse(rule.effectiveTo)),
    );
}

const byId = (a: RuleRow, b: RuleRow): number => (a.id < b.id ? -1 : 1);

describe("OwnerRules.rulesOf over readTermsSources: the rules in force at a time, as RuleRow (README item 76)", () => {
  it("the index lists accepted readTermsSources exchanges", () => {
    expect(TERMS.length).toBeGreaterThan(0);
  });

  for (const file of TERMS) {
    it(`${file}: each rule as T-300 reads the same K-26 row, without its version, asked for that business and time`, async () => {
      const exchange = catalogExchange(file);
      const businessId = field(exchange, "businessId");
      const at = field(exchange, "at");
      const asked: ReadTermsSourcesRequest[] = [];
      const rows = await ownerRulesOf(answering(exchange.outcome, asked)).rulesOf(businessId, at);

      expect(rows.length).toBeGreaterThan(0);
      expect([...rows].sort(byId)).toEqual(seededRules(file, businessId, at).sort(byId));
      expect(asked).toEqual([{ businessId, at }]);
      for (const row of rows) expect(Object.hasOwn(row, "version")).toBe(false);
      // The evaluator reads every row as it is handed over: none of them is refused.
      expect(evaluateRules(rows, { ...TONIGHT_AT_9, businessId }).result).not.toBe("refused");
    });
  }
});

describe("the read's error answers are passed on, and another business fails the gate's call closed", () => {
  it("notFound and transient: thrown as OwnerRulesReadError carrying K-05's answer as given", async () => {
    const notFound = catalogExchange("read-business-kinds-no-business-row.json").outcome;
    const transient = { error: "transient", sqlstate: "40P01" };
    for (const answer of [notFound, transient]) {
      const error = await thrownBy(
        ownerRulesOf(answering(answer)).rulesOf(HOME_SERVICES, "2026-10-29T14:00:00Z"),
      );
      expect(error).toBeInstanceOf(OwnerRulesReadError);
      expect(error).toMatchObject({ read: "readTermsSources", code: answer.error, answer });
    }
  });

  it("the barbershop's rules, answered to a read for Lee Home Services, are never used", async () => {
    const theirs = catalogExchange("read-terms-sources-after-no-show-count.json").outcome;
    const error = await thrownBy(
      ownerRulesOf(answering(theirs)).rulesOf(HOME_SERVICES, "2026-10-29T14:00:00Z"),
    );
    expect(error).toMatchObject({ code: "otherBusiness", answer: null });
    // One row of another business inside the business's own answer is refused too.
    const mixed = structuredClone(catalogExchange("read-terms-sources-dee-skin-fade.json").outcome) as {
      rules: { businessId: string }[];
    };
    const [first] = mixed.rules;
    if (first === undefined) throw new Error("the exchange answers no rule");
    first.businessId = HOME_SERVICES;
    const mixedError = await thrownBy(
      ownerRulesOf(answering(mixed)).rulesOf(BARBERSHOP, "2026-10-22T22:30:00Z"),
    );
    expect(mixedError).toMatchObject({ code: "otherBusiness" });
  });

  it("what db/repo throws leaves as it was thrown, its words unchanged", async () => {
    const thrown = new TypeError("readTermsSources: at is not an instant in UTC ending in Z");
    const read: TermsSourcesRead = () => Promise.reject(thrown);
    expect(await thrownBy(ownerRulesOf(read).rulesOf(BARBERSHOP, "2026-10-29T14:00:00Z"))).toBe(thrown);
  });
});
