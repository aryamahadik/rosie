// T-1429's unit proofs: the catalog's read port bound to K-05 v1.18's five reads (reads.ts), driven by fakes of the five
// that answer the contract's own v1.18 exchanges (test-support.ts), never by a database and never mocking the binding:
//   - each port read maps its K-05 answer field by field: for every accepted exchange, the binding's answer equals T-320's
//     in-memory double of the five reads (../test-support.ts readsOf) over the exchange's own seeds, an independent
//     reading of the same rows, and it asks K-05 for the call's business alone;
//   - spans are whole minutes and clock times HH:MM, as types.ts says;
//   - notFound and transient are passed on, thrown with K-05's answer as given; another business, asked or answered,
//     fails the call closed before or instead of any row; a binding with no business is never made;
//   - whatever db/repo throws leaves the binding and the service's call as it was thrown, its words unchanged;
//   - the service built with the binding (createCatalog's `reads`) takes Dee's skin fade snapshot exactly as over T-320's
//     double.

import { describe, expect, it } from "vitest";

import type { CatalogRead } from "../../../../../db/repo/catalog-reads";
import { createCatalog, type CatalogReads } from "../index";
import type { SnapshotInput } from "../terms";
import { SKIN_FADE_WRITTEN, Store, ZONE, minutesOf, readsOf } from "../test-support";
import { CatalogReadError, catalogReadsOf } from "./index";
import {
  BARBERSHOP,
  HOME_SERVICES,
  TIE_FIXTURE,
  YOGA,
  acceptedCatalogFiles,
  answeringK05Reads,
  catalogExchange,
  fixtureK05Reads,
  ordered,
  rowsOf,
  thrownBy,
  throwingK05Reads,
  valuesNamed,
  worldRows,
  type CatalogExchange,
  type K05Ask,
} from "./test-support";

const ACCEPTED = acceptedCatalogFiles();
/** Every accepted exchange whose outcome is a response, not one of the call's errors. */
const ANSWERED = ACCEPTED.filter((file) => !("error" in catalogExchange(file).outcome));
const NO_BUSINESS_ROW = "read-business-kinds-no-business-row.json";

/** A request's string field; fails the test when it has none. */
function field(exchange: CatalogExchange, name: string): string {
  const value = exchange.request[name];
  if (typeof value !== "string") throw new Error(`the ${exchange.call} request has no ${name}`);
  return value;
}

/** The port read an exchange's call serves, asked as its request asks (a terms read in each flow). */
async function portRead(reads: CatalogReads, exchange: CatalogExchange): Promise<unknown> {
  const businessId = field(exchange, "businessId");
  switch (exchange.call) {
    case "readBusinessKinds":
      return reads.kindsOf(businessId);
    case "readBusinessServices":
      return reads.servicesOf(businessId);
    case "readServiceWays":
      return reads.waysOf(businessId, field(exchange, "serviceId"));
    case "readServicePriceRules":
      return reads.priceRulesOf(businessId, field(exchange, "serviceId"), field(exchange, "at"));
    case "readTermsSources": {
      const at = field(exchange, "at");
      return {
        A: await reads.termsSourcesOf(businessId, "A", at),
        B: await reads.termsSourcesOf(businessId, "B", at),
      };
    }
  }
}

/** The five port reads for `businessId`, each asked as a call of the service would ask it. */
function everyRead(reads: CatalogReads, businessId: string): [CatalogRead, () => Promise<unknown>][] {
  const service = "svc-lees-haircut";
  const at = "2026-10-27T14:00:00Z";
  return [
    ["readBusinessKinds", () => reads.kindsOf(businessId)],
    ["readBusinessServices", () => reads.servicesOf(businessId)],
    ["readServiceWays", () => reads.waysOf(businessId, service)],
    ["readServicePriceRules", () => reads.priceRulesOf(businessId, service, at)],
    ["readTermsSources", () => reads.termsSourcesOf(businessId, "A", at)],
  ];
}

describe("each port read maps its K-05 v1.18 answer field by field (README items 72 to 76, 'The mapping')", () => {
  it("the index lists accepted exchanges of each of the five reads", () => {
    const calls = new Set(ACCEPTED.map((file) => catalogExchange(file).call));
    expect([...calls].sort()).toEqual([
      "readBusinessKinds",
      "readBusinessServices",
      "readServicePriceRules",
      "readServiceWays",
      "readTermsSources",
    ]);
  });

  for (const file of ANSWERED) {
    it(`${file}: the answer, as T-320's double reads the same seeds, asked for the call's business alone`, async () => {
      const exchange = catalogExchange(file);
      const businessId = field(exchange, "businessId");
      const asked: K05Ask[] = [];
      const bound = await portRead(catalogReadsOf(fixtureK05Reads([exchange], asked), businessId), exchange);
      const double = await portRead(readsOf(new Store(rowsOf(file))), exchange);

      expect(ordered(bound)).toEqual(ordered(double));
      // Every request went to K-05 as the exchange's, the call's business named (a terms read once per flow asked).
      expect(asked.length).toBeGreaterThan(0);
      for (const ask of asked) expect(ask).toEqual({ call: exchange.call, request: exchange.request });
      // Nothing the port has no field for is answered: no item 77 name, no flows list, no setup (DL-911 item 1).
      for (const name of ["rowId", "flows", "setup", "readAt", "result"]) {
        expect(valuesNamed(bound, name), name).toEqual([]);
      }
    });
  }

  it("read-business-kinds-barbershop: paths.A and paths.B are the combos of the kind's kind_flows row in each flow (item 72)", async () => {
    const exchange = catalogExchange("read-business-kinds-barbershop.json");
    const [kind] = await catalogReadsOf(fixtureK05Reads([exchange]), BARBERSHOP).kindsOf(BARBERSHOP);
    const outcome = exchange.outcome as { kinds: { flows: { flow: string; combos: string[] }[] }[] };
    const flows = outcome.kinds[0]?.flows ?? [];
    expect(kind?.paths).toEqual({
      A: flows.find((row) => row.flow === "A")?.combos,
      B: flows.find((row) => row.flow === "B")?.combos,
    });
  });

  it("a kind with no kind_flows row in a flow offers no path there: empty, never a default (item 72)", async () => {
    const exchange = catalogExchange("read-business-kinds-barbershop.json");
    const drafted = structuredClone(exchange.outcome) as { kinds: { flows: unknown[] }[] };
    for (const kind of drafted.kinds) kind.flows = [];
    const kinds = await catalogReadsOf(answeringK05Reads(drafted), BARBERSHOP).kindsOf(BARBERSHOP);
    expect(kinds.map((kind) => kind.paths)).toEqual([{ A: [], B: [] }]);
  });
});

describe("spans in whole minutes and clock times as HH:MM (types.ts)", () => {
  it("every span every exchange answers is a whole number of minutes from 1, and every clock time HH:MM (:SS only when not zero)", async () => {
    const spans: unknown[] = [];
    const times: unknown[] = [];
    for (const file of ANSWERED) {
      const exchange = catalogExchange(file);
      const bound = await portRead(
        catalogReadsOf(fixtureK05Reads([exchange]), field(exchange, "businessId")),
        exchange,
      );
      for (const name of ["lengthMinutes", "cutoffBeforeMinutes"]) {
        spans.push(...valuesNamed(bound, name).filter((value) => value !== null));
      }
      for (const name of ["fromTime", "untilTime", "cutoffDayBeforeAt"]) {
        times.push(...valuesNamed(bound, name).filter((value) => value !== null));
      }
    }
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(Number.isSafeInteger(span) && Number(span) >= 1, JSON.stringify(span)).toBe(true);
    }
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) expect(time).toMatch(/^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/);
  });

  it("the skin fade way's own free-cancel time and every barbershop service's length are the seeds' intervals in minutes", async () => {
    const ways = catalogExchange("read-service-ways-skin-fade.json");
    const services = catalogExchange("read-business-services-barbershop.json");
    const reads = catalogReadsOf(fixtureK05Reads([ways, services]), BARBERSHOP);
    const seeded = (file: string, table: string, id: string, column: string): number => {
      const row = rowsOf(file).find((each) => each.table === table && each.values.id === id);
      const text = row?.values[column];
      if (typeof text !== "string") throw new Error(`no seeded ${table} ${column}`);
      return minutesOf(text);
    };
    for (const way of await reads.waysOf(BARBERSHOP, field(ways, "serviceId"))) {
      expect(way.cutoffBeforeMinutes).toBe(
        seeded("read-service-ways-skin-fade.json", "service_money", way.id, "cutoff_before"),
      );
    }
    const list = await reads.servicesOf(BARBERSHOP);
    expect(list.length).toBeGreaterThan(0);
    for (const service of list) {
      expect(service.lengthMinutes).toBe(
        seeded("read-business-services-barbershop.json", "services", service.id, "length"),
      );
    }
  });

  it("read-price-rules-haircut-tie: the evening price's from time is the noted row's 17:00, as HH:MM", async () => {
    const exchange = catalogExchange(TIE_FIXTURE);
    const read = await catalogReadsOf(fixtureK05Reads([exchange]), BARBERSHOP).priceRulesOf(
      BARBERSHOP,
      field(exchange, "serviceId"),
      field(exchange, "at"),
    );
    const noted = rowsOf(TIE_FIXTURE).find((row) => row.values.id === "price-lees-haircut-evening");
    const evening = read.rules.find((rule) => rule.id === "price-lees-haircut-evening");
    expect(evening?.conditions.fromTime).toBe(noted?.values.from_time);
    expect(read.ties.map((tie) => [tie.firstRuleId, tie.secondRuleId])).toEqual([
      ["price-lees-haircut-home", "price-lees-haircut-evening"],
    ]);
  });
});

describe("K-05's error answers are passed on, and another business fails the call closed", () => {
  it(`notFound (${NO_BUSINESS_ROW}): thrown as CatalogReadError carrying K-05's answer as given, from every port read`, async () => {
    const { outcome } = catalogExchange(NO_BUSINESS_ROW);
    expect(outcome.error).toBe("notFound");
    for (const [read, ask] of everyRead(
      catalogReadsOf(answeringK05Reads(outcome), HOME_SERVICES),
      HOME_SERVICES,
    )) {
      const error = await thrownBy(ask());
      expect(error, read).toBeInstanceOf(CatalogReadError);
      expect(error).toMatchObject({ read, code: "notFound", answer: outcome });
      expect((error as Error).message).toBe(`${read} answered notFound: the call fails closed`);
    }
  });

  it("transient: thrown as CatalogReadError carrying K-05's answer and its SQLSTATE, from every port read", async () => {
    const transient = { error: "transient", sqlstate: "40001" };
    for (const [read, ask] of everyRead(
      catalogReadsOf(answeringK05Reads(transient), BARBERSHOP),
      BARBERSHOP,
    )) {
      const error = await thrownBy(ask());
      expect(error, read).toBeInstanceOf(CatalogReadError);
      expect(error).toMatchObject({ read, code: "transient", answer: transient });
    }
  });

  it("a port read asked for another business than the call's is refused before anything is read", async () => {
    const asked: K05Ask[] = [];
    const exchanges = ACCEPTED.map(catalogExchange);
    for (const [read, ask] of everyRead(
      catalogReadsOf(fixtureK05Reads(exchanges, asked), BARBERSHOP),
      YOGA,
    )) {
      const error = await thrownBy(ask());
      expect(error, read).toBeInstanceOf(CatalogReadError);
      expect(error).toMatchObject({ read, code: "otherBusiness", answer: null });
    }
    expect(asked).toEqual([]);
  });

  it("an answer holding a row of another business, or answered for another business, is never used", async () => {
    // The barbershop's own answers, handed to a binding of Lee Home Services and of the yoga studio.
    const theirs: [CatalogRead, string][] = [
      ["readBusinessKinds", "read-business-kinds-barbershop.json"],
      ["readBusinessServices", "read-business-services-barbershop.json"],
      ["readServiceWays", "read-service-ways-haircut.json"],
      ["readServicePriceRules", "read-price-rules-haircut-before-raise.json"],
      ["readTermsSources", "read-terms-sources-dee-skin-fade.json"],
    ];
    for (const businessId of [HOME_SERVICES, YOGA]) {
      for (const [read, file] of theirs) {
        const reads = catalogReadsOf(answeringK05Reads(catalogExchange(file).outcome), businessId);
        const ask = everyRead(reads, businessId).find(([name]) => name === read)?.[1];
        if (ask === undefined) throw new Error(`no port read for ${read}`);
        expect(await thrownBy(ask()), `${read} for ${businessId}`).toMatchObject({
          read,
          code: "otherBusiness",
        });
      }
    }
    // An answer with no row at all, but for another business than the one asked.
    const yogaKinds = catalogExchange("read-business-kinds-yoga-studio-none.json").outcome;
    const error = await thrownBy(
      catalogReadsOf(answeringK05Reads(yogaKinds), BARBERSHOP).kindsOf(BARBERSHOP),
    );
    expect(error).toMatchObject({ read: "readBusinessKinds", code: "otherBusiness" });
  });

  it("a binding with no business, an empty one or one that is not an id, is never made, and nothing is read", () => {
    const asked: K05Ask[] = [];
    const k05 = fixtureK05Reads(ACCEPTED.map(catalogExchange), asked);
    for (const none of [null, undefined, "", 7]) {
      expect(() => catalogReadsOf(k05, none as unknown as string)).toThrow(TypeError);
    }
    expect(asked).toEqual([]);
  });

  it("a terms read for a flow that is not A or B is refused before anything is read", async () => {
    const asked: K05Ask[] = [];
    const reads = catalogReadsOf(fixtureK05Reads(ACCEPTED.map(catalogExchange), asked), BARBERSHOP);
    const error = await thrownBy(reads.termsSourcesOf(BARBERSHOP, "C" as never, "2026-10-22T22:30:00Z"));
    expect(error).toBeInstanceOf(TypeError);
    expect(asked).toEqual([]);
  });
});

describe("what db/repo throws surfaces unchanged, through the binding and the service", () => {
  // db/repo's own words for a stored value an answer cannot carry (catalog-reads.ts cannotCarry), as it throws them.
  const thrown = [
    new Error(
      "readBusinessKinds: company_kinds.trade_name holds an empty name, which the answer cannot carry",
    ),
    new Error(
      "readBusinessKinds: company_kinds.pf_facts holds a NULL element, which the answer cannot carry",
    ),
    new Error(
      "readServicePriceRules: price_rules.from_time holds a time that is the day's end or has a fraction of a second, which the answer cannot carry",
    ),
    new TypeError("readServicePriceRules: at is not an instant in UTC ending in Z"),
  ];

  it("each port read rejects with the very error db/repo threw", async () => {
    for (const error of thrown) {
      for (const [read, ask] of everyRead(catalogReadsOf(throwingK05Reads(error), BARBERSHOP), BARBERSHOP)) {
        expect(await thrownBy(ask()), read).toBe(error);
      }
    }
  });

  it("the service's call that made the read rejects with it too, its words unchanged, and builds nothing", async () => {
    for (const error of thrown) {
      const catalog = createCatalog({
        call: "saveSetupStep",
        businessId: BARBERSHOP,
        currency: "USD",
        now: "2026-10-26T14:00:00Z",
        turnKey: "turn-sam-0002",
        reads: catalogReadsOf(throwingK05Reads(error), BARBERSHOP),
      });
      const failed = await thrownBy(catalog.kinds());
      expect(failed).toBe(error);
      expect((failed as Error).message).toBe(error.message);
      expect(await thrownBy(catalog.services())).toBe(error);
      expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    }
  });
});

describe("the service built with the binding (createCatalog's reads, as journey 1's calls hand them in)", () => {
  /** Dee's skin fade, booked with Riley at 10:00am Sat Oct 24 (K-30 seed-terms-snapshot), as terms.test.ts takes it. */
  const skinFade: SnapshotInput = {
    bookingId: "booking-dee-skin-fade",
    flow: "A",
    serviceId: "svc-lees-skin-fade",
    serviceMoneyId: "way-lees-skin-fade-shop",
    termsConsentId: "consent-dee-ticked-terms-skin-fade",
    termsVersion: "2026-10-19.1",
    termsLanguage: "en",
    noticesShown: [],
    zone: ZONE,
  };

  const catalogOver = (reads: CatalogReads) =>
    createCatalog({
      call: "gateAndCommit",
      businessId: BARBERSHOP,
      currency: "USD",
      now: SKIN_FADE_WRITTEN,
      turnKey: "turn-dee-0013",
      reads,
    });

  it("Dee's skin fade snapshot over the bound reads equals the one over T-320's double of the same seeds", async () => {
    const asked: K05Ask[] = [];
    const bound = catalogReadsOf(fixtureK05Reads(ACCEPTED.map(catalogExchange), asked), BARBERSHOP);
    const snapshot = await catalogOver(bound).takeTermsSnapshot(skinFade);
    const double = await catalogOver(readsOf(new Store(worldRows()))).takeTermsSnapshot(skinFade);
    expect(snapshot).toEqual(double);
    expect(snapshot.cutoff.from).toBe("way");
    expect(asked.map((ask) => ask.call)).toEqual([
      "readBusinessServices",
      "readServiceWays",
      "readTermsSources",
    ]);
  });

  it("the haircut's price rules before the raise, read through the service, are the exchange's rules in id order", async () => {
    const exchange = catalogExchange("read-price-rules-haircut-before-raise.json");
    const services = catalogExchange("read-business-services-barbershop.json");
    const catalog = createCatalog({
      call: "saveSetupStep",
      businessId: BARBERSHOP,
      currency: "USD",
      now: field(exchange, "at"),
      turnKey: "turn-sam-0002",
      reads: catalogReadsOf(fixtureK05Reads([exchange, services]), BARBERSHOP),
    });
    const read = await catalog.priceRules(field(exchange, "serviceId"), field(exchange, "at"));
    const outcome = exchange.outcome as { rules: { id: string }[] };
    expect(read.rules.map((rule) => rule.id)).toEqual(outcome.rules.map((rule) => rule.id));
    expect(read.ties).toEqual([]);
  });
});
