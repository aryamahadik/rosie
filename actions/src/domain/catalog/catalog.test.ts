// T-320's catalog and pricing service base (C-096): with no read port bound every call answers notBuilt and writes
// nothing (DL-888); CQ-128's refusals (a non-deposit path holding both deposit amounts; no link removal); and the
// business's kinds, services and ways as journeys 1 and 2 will write them (S1-12, S1-13, S1-81, S11-56), each row held
// to K-23 v1 and K-25 v1. Every row is the contracts' own seed (test-support.ts), names from fixture set v1's demo shops.

import { describe, expect, it } from "vitest";

import { LaneNotBuiltError, NotBuiltError } from "../../tool-api";
import { noWrites } from "../../commit/test-support";
import {
  NO_CONDITIONS,
  createCatalog,
  withCatalog,
  type AddWayInput,
  type Catalog,
  type CatalogDeps,
  type CatalogReads,
} from "./index";
import {
  BARBERSHOP,
  NOV_2,
  RAISE_DAY,
  SAM,
  SEEDS,
  Store,
  ZONE,
  readsOf,
  seedRows,
  type ReadLog,
} from "./test-support";

function catalogAt(store: Store, more: Partial<CatalogDeps> = {}): { catalog: Catalog; log: ReadLog } {
  const log: ReadLog = [];
  const catalog = createCatalog({
    call: "saveSetupStep",
    businessId: BARBERSHOP,
    currency: "USD",
    now: RAISE_DAY,
    turnKey: "turn-sam-0300",
    reads: readsOf(store, log),
    ...more,
  });
  return { catalog, log };
}

/** The pet boarding demo shop's suite (K-23 seed-place-or-thing), as a call reads it. */
const suite = { id: "place-pet-boarding-suite", businessId: "biz-pet-boarding" };

/** Every call of the service, each with a request built from the seeds. */
function everyCall(catalog: Catalog): readonly (readonly [string, () => Promise<unknown>])[] {
  const service = "svc-lees-haircut";
  return [
    ["kinds", () => catalog.kinds()],
    ["services", () => catalog.services()],
    ["ways", () => catalog.ways(service)],
    ["priceRules", () => catalog.priceRules(service, RAISE_DAY)],
    [
      "placeKind",
      () =>
        catalog.placeKind({
          companyId: "company-lees-barbershop",
          kindId: "dog-walker",
          tradeName: null,
          facts: [],
          switchesA: [],
          switchesB: [],
        }),
    ],
    [
      "updateKind",
      () => catalog.updateKind({ companyId: "company-lees-barbershop", kindId: "barber", facts: [] }),
    ],
    [
      "addService",
      () =>
        catalog.addService({
          kindId: "barber",
          name: "Groom's cut at home",
          priceKind: "one_price",
          unit: null,
          lengthMinutes: 60,
        }),
    ],
    ["updateService", () => catalog.updateService({ serviceId: service, lengthMinutes: 35 })],
    [
      "addWay",
      () =>
        catalog.addWay({
          serviceId: "svc-lees-kids-cut",
          place: "business",
          locationId: "loc-lees-barbershop-second-shop",
          path: "list|card|counter",
          depositCents: null,
          depositPercent: null,
          feeCents: 2000,
          cutoffBeforeMinutes: null,
          cutoffDayBeforeAt: null,
          tipLine: null,
        }),
    ],
    [
      "updateWay",
      () => catalog.updateWay({ wayId: "way-lees-haircut-shop", serviceId: service, feeCents: 2500 }),
    ],
    ["linkSpace", () => catalog.linkSpace({ placeOrThing: suite, serviceId: service })],
    ["unlinkSpace", () => catalog.unlinkSpace({ placeOrThing: suite, serviceId: service })],
    [
      "addPrice",
      () =>
        catalog.addPrice({
          serviceId: service,
          conditions: { ...NO_CONDITIONS, workerResourceId: "res-avery" },
          priceCents: 4500,
          fromCents: null,
          setByPersonId: SAM,
        }),
    ],
    [
      "changePrice",
      () =>
        catalog.changePrice({
          serviceId: service,
          conditions: NO_CONDITIONS,
          priceCents: 4000,
          fromCents: null,
          setByPersonId: SAM,
          effectiveFrom: NOV_2,
        }),
    ],
    [
      "withdrawPrice",
      () =>
        catalog.withdrawPrice({ ruleId: "price-lees-haircut-40", serviceId: service, setByPersonId: SAM }),
    ],
    ["closePrice", () => catalog.closePrice({ ruleId: "price-lees-haircut-home", serviceId: service })],
    [
      "answerTie",
      () =>
        catalog.answerTie({
          tieId: "tie-lees-haircut",
          serviceId: service,
          winnerRuleId: "price-lees-haircut-home",
          answeredByPersonId: SAM,
        }),
    ],
    [
      "takeTermsSnapshot",
      () =>
        catalog.takeTermsSnapshot({
          bookingId: "booking-dee-skin-fade",
          flow: "A",
          serviceId: "svc-lees-skin-fade",
          serviceMoneyId: "way-lees-skin-fade-shop",
          termsConsentId: "consent-dee-ticked-terms-skin-fade",
          termsVersion: "2026-10-19.1",
          termsLanguage: "en",
          noticesShown: [],
          zone: ZONE,
        }),
    ],
  ];
}

describe("with no read port bound, every call answers notBuilt and nothing is written (DL-888)", () => {
  const unbound = (call: string): Catalog =>
    createCatalog({
      call,
      businessId: BARBERSHOP,
      currency: "USD",
      now: RAISE_DAY,
      turnKey: "turn-sam-0300",
    });

  it("each of the service's calls, for a K-09 v1 call, answers that call's notBuilt", async () => {
    const catalog = unbound("saveSetupStep");
    const calls = everyCall(catalog);
    expect(calls.map(([name]) => name)).toHaveLength(18);
    for (const [, run] of calls) {
      const error: unknown = await run().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(NotBuiltError);
      expect(error).toMatchObject({ call: "saveSetupStep" });
    }
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
  });

  it("for a journey lane's call, answers the lane's notBuilt, which the base answers for that call", async () => {
    const catalog = unbound("keepServices");
    for (const [, run] of everyCall(catalog)) {
      const error: unknown = await run().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(LaneNotBuiltError);
      expect(error).toMatchObject({ call: "keepServices" });
    }
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
  });

  it("with the reads bound, the same calls read through the port and build their rows", async () => {
    const store = new Store([
      ...seedRows(SEEDS),
      ...seedRows(["services-prices/fixtures/seed-item-services.json"]),
    ]);
    const { catalog, log } = catalogAt(store, { now: "2026-10-28T14:00:00Z" });
    const answered: string[] = [];
    for (const [name, run] of everyCall(catalog)) {
      const outcome = await run().then(
        () => "built",
        (error: unknown) => (error instanceof Error ? error.name : "thrown"),
      );
      answered.push(`${name}: ${outcome}`);
    }
    expect(log.length).toBeGreaterThan(0);
    // Built where the seeds let it; refused for its own reason where they do not: never notBuilt but the removal.
    expect(answered.filter((each) => each.endsWith("NotBuiltError"))).toEqual(["unlinkSpace: NotBuiltError"]);
    expect(catalog.written().state.length).toBeGreaterThan(0);
  });
});

describe("CQ-128 (the architect's defaults)", () => {
  const kidsCutAtSecondShop: AddWayInput = {
    serviceId: "svc-lees-kids-cut",
    place: "business",
    locationId: "loc-lees-barbershop-second-shop",
    path: "list|card|counter",
    depositCents: null,
    depositPercent: null,
    feeCents: 2000,
    cutoffBeforeMinutes: null,
    cutoffDayBeforeAt: null,
    tipLine: null,
  };

  it("(1) refuses a non-deposit path that holds both deposit_cents and deposit_percent, which K-25 v1's CHECK lets through", async () => {
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)));
    await expect(
      catalog.addWay({ ...kidsCutAtSecondShop, depositCents: 1000, depositPercent: 25 }),
    ).rejects.toMatchObject({ reason: "depositNotOnPath" });
    await expect(catalog.addWay({ ...kidsCutAtSecondShop, depositPercent: 25 })).rejects.toMatchObject({
      reason: "depositNotOnPath",
    });
    // A change that would leave the Groom's package's card path holding both is refused too (S11-56).
    await expect(
      catalog.updateWay({
        wayId: "way-lees-grooms-package-shop",
        serviceId: "svc-lees-grooms-package",
        path: "list|card|counter",
        depositPercent: 25,
      }),
    ).rejects.toMatchObject({ reason: "depositNotOnPath" });
    // On a deposit path, exactly one of them: both refused, one passes ($10 here, as the $40 Groom's package's).
    await expect(
      catalog.addWay({
        ...kidsCutAtSecondShop,
        path: "list|deposit|counter",
        depositCents: 1000,
        depositPercent: 25,
      }),
    ).rejects.toMatchObject({ reason: "depositNotOnPath" });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    const deposit = await catalog.addWay({
      ...kidsCutAtSecondShop,
      path: "list|deposit|counter",
      depositCents: 1000,
    });
    expect(deposit.writes.state[0]).toMatchObject({
      op: "insert",
      table: "service_money",
      values: { path: "list|deposit|counter", deposit_cents: 1000, deposit_percent: null, currency: "USD" },
    });
  });

  it("(2) removing a space's link to a service answers notBuilt, reads nothing and writes nothing", async () => {
    const store = new Store(seedRows(["services-prices/fixtures/seed-item-services.json"]));
    const { catalog, log } = catalogAt(store, { businessId: "biz-pet-boarding" });
    await expect(
      catalog.unlinkSpace({ placeOrThing: suite, serviceId: "svc-boarding-suite-stay" }),
    ).rejects.toBeInstanceOf(NotBuiltError);
    expect(log).toEqual([]);
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
  });
});

describe("kinds of work (K-23 company_kinds, K-24 kind_flows)", () => {
  it("reads the business's kinds with the money paths each flow offers, and refuses a kind placed twice", async () => {
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)));
    const kinds = await catalog.kinds();
    expect(kinds.map((kind) => [kind.kindId, kind.paths.A.length, kind.paths.B.length])).toEqual([
      ["barber", 3, 3],
    ]);
    const placing = {
      companyId: "company-lees-barbershop",
      kindId: "barber",
      tradeName: null,
      facts: [],
      switchesA: [],
      switchesB: [],
    };
    await expect(catalog.placeKind(placing)).rejects.toMatchObject({ reason: "kindTwice" });
    const placed = await catalog.placeKind({ ...placing, kindId: "dog-walker" });
    expect(placed.writes.state).toEqual([
      {
        op: "insert",
        table: "company_kinds",
        values: {
          company_id: "company-lees-barbershop",
          kind_id: "dog-walker",
          business_id: BARBERSHOP,
          trade_name: null,
          pf_facts: [],
          pf_switches_a: [],
          pf_switches_b: [],
        },
      },
    ]);
    expect((await catalog.kinds()).map((kind) => kind.kindId)).toEqual(["barber", "dog-walker"]);
  });

  it("changes a kind's facts at the version read, and refuses nomoney as a fact without its switch", async () => {
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)));
    const facts = ["children", "documents", "extrawork", "groups", "photos", "waitlist"];
    await expect(
      catalog.updateKind({
        companyId: "company-lees-barbershop",
        kindId: "barber",
        facts: [...facts, "nomoney"],
      }),
    ).rejects.toMatchObject({ reason: "badInput" });
    const changed = await catalog.updateKind({
      companyId: "company-lees-barbershop",
      kindId: "barber",
      facts,
    });
    expect(changed.writes.state).toEqual([
      {
        op: "update",
        table: "company_kinds",
        key: { company_id: "company-lees-barbershop", kind_id: "barber" },
        expectVersion: 1,
        set: { pf_facts: facts },
      },
    ]);
    await expect(
      catalog.updateKind({
        companyId: "company-lees-barbershop",
        kindId: "barber",
        switchesA: ["sensitive"],
      }),
    ).rejects.toMatchObject({ reason: "rowTwice" });
  });
});

describe("services, ways and prices in one call (S1-12, S1-13)", () => {
  it("adds a service, its way and its price, each seeing the one before, with ids made by rule", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store);
    const service = await catalog.addService({
      kindId: "barber",
      name: "Groom's cut at home",
      priceKind: "one_price",
      unit: null,
      lengthMinutes: 60,
    });
    const way = await catalog.addWay({
      serviceId: service.id,
      place: "customer",
      locationId: "loc-lees-barbershop-second-shop",
      path: "list|full|none",
      depositCents: null,
      depositPercent: null,
      feeCents: 8900,
      cutoffBeforeMinutes: null,
      cutoffDayBeforeAt: null,
      tipLine: null,
    });
    const price = await catalog.addPrice({
      serviceId: service.id,
      conditions: NO_CONDITIONS,
      priceCents: 15_000,
      fromCents: null,
      setByPersonId: SAM,
    });
    expect([service.id, way.id, price.openedRuleId]).toEqual([
      "svc-turn-sam-0300-1",
      "way-turn-sam-0300-1",
      "price-turn-sam-0300-1",
    ]);
    expect(service.writes.state[0]).toEqual({
      op: "insert",
      table: "services",
      values: {
        id: "svc-turn-sam-0300-1",
        business_id: BARBERSHOP,
        kind_id: "barber",
        name: "Groom's cut at home",
        price_kind: "one_price",
        unit: null,
        length: "60 minutes",
        position: 11,
        active: true,
        extras: null,
      },
    });
    expect(way.writes.state[0]).toMatchObject({
      values: { flow: "B", place: "customer", path: "list|full|none", fee_cents: 8900, currency: "USD" },
    });
    // Nothing was read at a version: every row it rests on was built in this call.
    const written = catalog.written();
    expect(written.versionsRead).toEqual([]);
    expect(written.state.map((write) => [write.op, write.table])).toEqual([
      ["insert", "services"],
      ["insert", "service_money"],
      ["insert", "price_rules"],
    ]);
    // The commit carries them in the part's writes, after what the part already writes.
    const unit = withCatalog(noWrites({ step: "S1-13", choice: "1 Yes" }), written);
    expect(unit.state).toEqual(written.state);
    // Committed, the store holds them.
    store.apply(written.state);
    expect(store.row("services", "svc-turn-sam-0300-1")).toMatchObject({ version: 1, position: 11 });
  });

  it("refuses a kind the business does not have, and a per-unit price with no unit", async () => {
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)));
    const line = {
      kindId: "barber",
      name: "Groom's cut at home",
      priceKind: "one_price" as const,
      unit: null,
      lengthMinutes: 60,
    };
    await expect(catalog.addService({ ...line, kindId: "plumber" })).rejects.toMatchObject({
      reason: "kindNotOnBusiness",
    });
    await expect(catalog.addService({ ...line, priceKind: "per_unit" })).rejects.toMatchObject({
      reason: "badInput",
    });
    await expect(catalog.addService({ ...line, extras: "[1]" })).rejects.toMatchObject({
      reason: "badInput",
    });
    expect(catalog.written().state).toEqual([]);
  });

  it("holds each way to the master's 28, its kind's paths and its money (S1-13; FS section 4; K-25 rule 9)", async () => {
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)));
    const way: AddWayInput = {
      serviceId: "svc-lees-kids-cut",
      place: "business",
      locationId: "loc-lees-barbershop-second-shop",
      path: "list|card|counter",
      depositCents: null,
      depositPercent: null,
      feeCents: 2000,
      cutoffBeforeMinutes: null,
      cutoffDayBeforeAt: null,
      tipLine: null,
    };
    const refusals = await Promise.all(
      [
        { ...way, path: "list|hold|counter" },
        { ...way, path: "list|full|none" },
        { ...way, path: "list|none|counter" },
        { ...way, feeCents: null },
        { ...way, tipLine: true },
        { ...way, cutoffBeforeMinutes: 120, cutoffDayBeforeAt: "18:00" },
        { ...way, locationId: "loc-lees-barbershop-shop" },
        { ...way, place: "video" as const },
      ].map((input) =>
        catalog.addWay(input).then(
          () => "built",
          (error: unknown) => (error as { reason?: string }).reason ?? "thrown",
        ),
      ),
    );
    expect(refusals).toEqual([
      "pathUnknown",
      "pathNotOffered",
      "feeOnNothingTaken",
      "feeMissing",
      "tipLineNotOnBill",
      "twoCutoffs",
      "wayTwice",
      "badInput",
    ]);
    expect(catalog.written().state).toEqual([]);
  });

  it("changes a way in place at its version, for new bookings only (S11-56), and keeps its amounts' currency", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store);
    const changed = await catalog.updateWay({
      wayId: "way-lees-haircut-shop",
      serviceId: "svc-lees-haircut",
      feeCents: 2500,
    });
    expect(changed.writes).toEqual({
      versionsRead: [{ table: "services", rowId: "svc-lees-haircut", version: 1 }],
      state: [
        {
          op: "update",
          table: "service_money",
          key: { id: "way-lees-haircut-shop" },
          expectVersion: 1,
          set: { fee_cents: 2500 },
        },
      ],
    });
    // A business whose one currency is another: the way's dollars are never relabelled.
    const elsewhere = catalogAt(store, { currency: "CAD" }).catalog;
    await expect(
      elsewhere.updateWay({ wayId: "way-lees-haircut-shop", serviceId: "svc-lees-haircut", feeCents: 2500 }),
    ).rejects.toMatchObject({ reason: "currencyMismatch" });
    await expect(
      catalog.updateWay({
        wayId: "way-lees-haircut-shop",
        serviceId: "svc-lees-haircut",
        feeCents: 3000,
        expectVersion: 1,
      }),
    ).rejects.toMatchObject({ reason: "rowTwice" });
  });

  it("changes a service's length at its version and stops one by active false, never deleting it", async () => {
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)));
    const longer = await catalog.updateService({ serviceId: "svc-lees-haircut", lengthMinutes: 35 });
    expect(longer.writes.state).toEqual([
      {
        op: "update",
        table: "services",
        key: { id: "svc-lees-haircut" },
        expectVersion: 1,
        set: { length: "35 minutes" },
      },
    ]);
    const stopped = await catalog.updateService({
      serviceId: "svc-lees-kids-cut",
      active: false,
      expectVersion: 1,
    });
    expect(stopped.writes.state).toEqual([
      {
        op: "update",
        table: "services",
        key: { id: "svc-lees-kids-cut" },
        expectVersion: 1,
        set: { active: false },
      },
    ]);
    await expect(
      catalog.updateService({ serviceId: "svc-lees-beard-trim", name: "Beard trim", expectVersion: 2 }),
    ).rejects.toMatchObject({ reason: "versionChanged" });
  });

  it("links a stay to a second space of its own business, once (S1-81; K-25 item_services)", async () => {
    const store = new Store(seedRows(["services-prices/fixtures/seed-item-services.json"]));
    const { catalog } = catalogAt(store, { businessId: "biz-pet-boarding" });
    const run = { id: "place-pet-boarding-standard-run", businessId: "biz-pet-boarding" };
    const link = { placeOrThing: run, serviceId: "svc-boarding-suite-stay" };
    await expect(
      catalog.linkSpace({ ...link, placeOrThing: { ...run, businessId: BARBERSHOP } }),
    ).rejects.toMatchObject({ reason: "otherBusiness" });
    const linked = await catalog.linkSpace(link);
    expect(linked.writes.state).toEqual([
      {
        op: "insert",
        table: "item_services",
        values: {
          place_or_thing_id: "place-pet-boarding-standard-run",
          service_id: "svc-boarding-suite-stay",
          business_id: "biz-pet-boarding",
        },
      },
    ]);
    await expect(catalog.linkSpace(link)).rejects.toMatchObject({ reason: "rowTwice" });
  });
});

describe("every row is the call's business's (arch 10 line 546)", () => {
  it("refuses what a leaky read answers of another business, and builds nothing", async () => {
    const store = new Store(seedRows(SEEDS));
    const catalog = createCatalog({
      call: "saveSetupStep",
      businessId: BARBERSHOP,
      currency: "USD",
      now: RAISE_DAY,
      turnKey: "turn-sam-0300",
      reads: readsOf(store, [], { scoped: false }),
    });
    await expect(catalog.services()).rejects.toMatchObject({ reason: "otherBusiness" });
    await expect(catalog.kinds()).rejects.toMatchObject({ reason: "otherBusiness" });
    expect(catalog.written().state).toEqual([]);
  });

  it("refuses a read that answers another service's ways or rules", async () => {
    const store = new Store(seedRows(SEEDS));
    const base = readsOf(store);
    const crossed: CatalogReads = {
      ...base,
      waysOf: (businessId) => base.waysOf(businessId, "svc-lees-skin-fade"),
    };
    const catalog = createCatalog({
      call: "saveSetupStep",
      businessId: BARBERSHOP,
      currency: "USD",
      now: RAISE_DAY,
      turnKey: "turn-sam-0300",
      reads: crossed,
    });
    await expect(catalog.ways("svc-lees-haircut")).rejects.toMatchObject({ reason: "badRead" });
  });

  it("refuses to be built for no business, or with a now that is not UTC", () => {
    const deps = {
      call: "saveSetupStep",
      businessId: BARBERSHOP,
      currency: "USD",
      now: RAISE_DAY,
      turnKey: "turn-sam-0300",
    };
    expect(() => createCatalog({ ...deps, businessId: "" })).toThrow(
      "catalog refused: badInput (businessId)",
    );
    expect(() => createCatalog({ ...deps, now: "2026-10-26 14:00" })).toThrow(
      "catalog refused: badInput (now)",
    );
    expect(() => createCatalog({ ...deps, currency: "usd" })).toThrow("catalog refused: badInput (currency)");
  });
});
