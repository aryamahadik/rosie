// T-1433's unit proofs: the catalog's cross-row checks (checks.ts; K-25 v1 rule 9; K-05 v1.18 CQ-349 rulings (1) to (4);
// T-320's security notes N1 and N2), each refusing its one wrong case, naming its rule and writing nothing, and passing
// its right one. The service reads only through its port (test-support.ts readsOf over the frozen seeds of fixture set
// v1's demo shops: Lee's Barbershop, Lee Home Services, the pet boarding inn, the yoga studio); a wrong case is a seed row
// named where it does not belong, or one seed value changed as the test says.

import { describe, expect, it } from "vitest";

import {
  NO_CONDITIONS,
  checkCatalogWrite,
  checkDeposit,
  checkLocation,
  checkWorker,
  createCatalog,
  type AddWayInput,
  type CatalogDeps,
  type CatalogReads,
  type LocationRow,
  type PriceRuleRow,
  type WayRow,
} from "./index";
import {
  BARBERSHOP,
  HOME_SERVICES,
  RAISE_DAY,
  SAM,
  SEEDS,
  SKIN_FADE_WRITTEN,
  Store,
  ZONE,
  readsOf,
  refusalOf,
  ruleOf,
  seedRows,
  wayOf,
  type ReadLog,
} from "./test-support";

const PET_BOARDING = "biz-pet-boarding";
const YOGA = "biz-yoga-studio";

function catalogAt(store: Store, more: Partial<CatalogDeps> = {}) {
  const log: ReadLog = [];
  const catalog = createCatalog({
    call: "saveSetupStep",
    businessId: BARBERSHOP,
    currency: "USD",
    now: RAISE_DAY,
    turnKey: "turn-sam-0400",
    reads: readsOf(store, log),
    ...more,
  });
  return { catalog, log };
}

const seeded = (): Store => new Store(seedRows(SEEDS));

/** The reason a call was refused with, or "built"; anything else thrown fails the test. */
async function outcomeOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => "built",
    (error: unknown) => {
      const reason = (error as { reason?: unknown }).reason;
      if (typeof reason !== "string") throw error;
      return reason;
    },
  );
}

/** The kids cut at the second shop (K-23 seed-location-travel-centre), a card path with the card's $20 fee. */
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

/** A seed row of a table by id, as the store holds it. */
function seedRow(store: Store, table: string, id: string): Record<string, unknown> {
  const row = store.row(table, id);
  if (row === undefined) throw new Error(`no seeded ${table} ${id}`);
  return row;
}

describe("(a) a deposit is never over the price known then (K-25 rule 9; S1-13; README ruling 4 (a))", () => {
  it("at the way's save: the kids cut's $25 price takes a $25 deposit, never $25.01; nothing written", async () => {
    const { catalog } = catalogAt(seeded());
    const over = { ...kidsCutAtSecondShop, path: "list|deposit|counter", depositCents: 2501 };
    await expect(catalog.addWay(over)).rejects.toMatchObject({
      reason: "depositOverPrice",
      fields: ["depositCents"],
    });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    const at = await catalog.addWay({ ...over, depositCents: 2500 });
    expect(at.writes.state[0]).toMatchObject({
      values: { deposit_cents: 2500, path: "list|deposit|counter" },
    });
  });

  it("a change to the Groom's package's deposit is held to its $140 price, a later price included", async () => {
    const store = seeded();
    const change = { wayId: "way-lees-grooms-package-shop", serviceId: "svc-lees-grooms-package" };
    expect(await outcomeOf(catalogAt(store).catalog.updateWay({ ...change, depositCents: 14_001 }))).toBe(
      "depositOverPrice",
    );
    expect(await outcomeOf(catalogAt(store).catalog.updateWay({ ...change, depositCents: 14_000 }))).toBe(
      "built",
    );
    // A $120 price set from Nov 2 is a price known then too: $130 is over it.
    const raise = await catalogAt(store).catalog.changePrice({
      serviceId: "svc-lees-grooms-package",
      conditions: NO_CONDITIONS,
      priceCents: 12_000,
      fromCents: null,
      setByPersonId: SAM,
      effectiveFrom: "2026-11-02T05:00:00Z",
    });
    store.apply(raise.writes.state);
    expect(await outcomeOf(catalogAt(store).catalog.updateWay({ ...change, depositCents: 13_000 }))).toBe(
      "depositOverPrice",
    );
    expect(await outcomeOf(catalogAt(store).catalog.updateWay({ ...change, depositCents: 12_000 }))).toBe(
      "built",
    );
  });

  it("at the price's save: the Groom's package's $40 deposit refuses a $39.99 price, never written; $40 passes", async () => {
    const { catalog } = catalogAt(seeded());
    const lower = {
      serviceId: "svc-lees-grooms-package",
      conditions: NO_CONDITIONS,
      priceCents: 3999,
      fromCents: null,
      setByPersonId: SAM,
      effectiveFrom: "2026-11-02T05:00:00Z",
    };
    await expect(catalog.changePrice(lower)).rejects.toMatchObject({
      reason: "depositOverPrice",
      fields: ["priceCents"],
    });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    expect((await catalog.changePrice({ ...lower, priceCents: 4000 })).openedRuleId).not.toBeNull();
  });

  it("its place's rule, else the service's own: a way priced by its own place is held to that price alone", () => {
    const store = seeded();
    // The at-home haircut is priced by its place's $75 rule, the shop by the service's own $35.
    const home: WayRow = {
      ...wayOf(seedRow(store, "service_money", "way-lees-haircut-home")),
      path: "list|deposit|bill",
      depositCents: 5000,
      currency: "USD",
    };
    const rules = ["price-lees-haircut-35", "price-lees-haircut-home"].map((id) =>
      ruleOf(seedRow(store, "price_rules", id)),
    );
    expect(refusalOf(() => checkDeposit(home, rules, ["depositCents"]))).toBeNull();
    const shop: WayRow = { ...home, id: "way-lees-haircut-shop" };
    expect(refusalOf(() => checkDeposit(shop, rules, ["depositCents"]))).toBe("depositOverPrice");
  });

  it("a visit path: a deposit up to the starting price (A4-13), none with no starting price known", () => {
    const store = seeded();
    // Lee Electric's wiring repair, priced at the visit, with a deposit of its $89 service call.
    const way: WayRow = {
      ...wayOf(seedRow(store, "service_money", "way-lee-electric-wiring-repair-home")),
      path: "visit|deposit|bill",
      depositCents: 8900,
      feeCents: null,
    };
    const rule: PriceRuleRow = ruleOf(seedRow(store, "price_rules", "price-lee-electric-wiring-repair"));
    expect(refusalOf(() => checkDeposit(way, [{ ...rule, fromCents: 8900 }], ["depositCents"]))).toBeNull();
    expect(refusalOf(() => checkDeposit(way, [{ ...rule, fromCents: 8899 }], ["depositCents"]))).toBe(
      "depositOverPrice",
    );
    expect(refusalOf(() => checkDeposit(way, [rule], ["depositCents"]))).toBe("depositOverPrice");
    expect(refusalOf(() => checkDeposit(way, [], ["depositCents"]))).toBe("depositOverPrice");
    // A percent is under the price by its form, and a stopped way takes no new booking.
    expect(refusalOf(() => checkDeposit({ ...way, depositCents: null }, [], ["depositCents"]))).toBeNull();
    expect(refusalOf(() => checkDeposit({ ...way, active: false }, [], ["depositCents"]))).toBeNull();
  });
});

describe("(b) a list-priced way has a price rule in effect at its save (K-25 rule 9)", () => {
  const line = {
    kindId: "barber",
    name: "Groom's cut at home",
    priceKind: "one_price" as const,
    unit: null,
    lengthMinutes: 60,
  };
  const atHome = (serviceId: string): AddWayInput => ({
    serviceId,
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

  it("a new service's way before any price is refused, nothing written; once its price is in effect it passes", async () => {
    const { catalog } = catalogAt(seeded());
    const service = await catalog.addService(line);
    await expect(catalog.addWay(atHome(service.id))).rejects.toMatchObject({
      reason: "noPriceInEffect",
      fields: ["path"],
    });
    expect(catalog.written().state.map((write) => write.table)).toEqual(["services"]);
    await catalog.addPrice({
      serviceId: service.id,
      conditions: NO_CONDITIONS,
      priceCents: 15_000,
      fromCents: null,
      setByPersonId: SAM,
    });
    expect(await outcomeOf(catalog.addWay(atHome(service.id)))).toBe("built");
  });

  it("a price set only for a later date is not in effect at the save", async () => {
    const { catalog } = catalogAt(seeded());
    const service = await catalog.addService(line);
    await catalog.addPrice({
      serviceId: service.id,
      conditions: NO_CONDITIONS,
      priceCents: 15_000,
      fromCents: null,
      setByPersonId: SAM,
      effectiveFrom: "2026-11-02T05:00:00Z",
    });
    expect(await outcomeOf(catalog.addWay(atHome(service.id)))).toBe("noPriceInEffect");
  });
});

describe("(c) a way's location and place, and a rule's worker, are the business's (K-25 rule 9; S1-43)", () => {
  it("a way at Lee Home Services' office is refused for the barbershop; its own second shop passes", async () => {
    const { catalog, log } = catalogAt(seeded());
    await expect(
      catalog.addWay({ ...kidsCutAtSecondShop, locationId: "loc-lee-home-services-office" }),
    ).rejects.toMatchObject({ reason: "locationNotOnBusiness", fields: ["locationId"] });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    expect(log).toContain("locationOf");
    expect(await outcomeOf(catalog.addWay(kidsCutAtSecondShop))).toBe("built");
  });

  it("the customer's place needs a location with a travel area: the shop has none, the second shop's 25 miles pass", async () => {
    const { catalog } = catalogAt(seeded());
    const atCustomer: AddWayInput = {
      ...kidsCutAtSecondShop,
      place: "customer",
      locationId: "loc-lees-barbershop-shop",
      path: "list|card|bill",
      feeCents: 2000,
    };
    await expect(catalog.addWay(atCustomer)).rejects.toMatchObject({
      reason: "locationNotOfPlace",
      fields: ["place", "locationId"],
    });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    expect(
      await outcomeOf(catalog.addWay({ ...atCustomer, locationId: "loc-lees-barbershop-second-shop" })),
    ).toBe("built");
  });

  it("each place takes its own location kind: a shop or office, a meeting spot, a travel area", () => {
    // The barbershop's shop as K-23's seed holds it (seed-business-demo-shop), then with one value changed.
    const shop: LocationRow = {
      id: "loc-lees-barbershop-shop",
      businessId: BARBERSHOP,
      kind: "shop",
      travelMiles: null,
      version: 1,
    };
    const fits = (place: "business" | "meeting_spot" | "customer", location: LocationRow) =>
      refusalOf(() => checkLocation(place, location.id, location, BARBERSHOP));
    expect(fits("business", shop)).toBeNull();
    expect(fits("business", { ...shop, kind: "office" })).toBeNull();
    expect(fits("meeting_spot", shop)).toBe("locationNotOfPlace");
    expect(fits("meeting_spot", { ...shop, kind: "meeting_spot" })).toBeNull();
    expect(fits("business", { ...shop, kind: "meeting_spot" })).toBe("locationNotOfPlace");
    expect(fits("customer", shop)).toBe("locationNotOfPlace");
    expect(fits("customer", { ...shop, travelMiles: 25 })).toBeNull();
    // A row another business holds, answered by a leaky read, is never the business's.
    expect(
      refusalOf(() => checkLocation("business", shop.id, { ...shop, businessId: YOGA }, BARBERSHOP)),
    ).toBe("locationNotOnBusiness");
  });

  it("a price by the yoga studio's Maya is refused at the barbershop; Avery's passes (a rule's worker)", async () => {
    const { catalog, log } = catalogAt(seeded());
    const byPerson = {
      serviceId: "svc-lees-event-hours",
      conditions: { ...NO_CONDITIONS, workerResourceId: "res-maya" },
      priceCents: 13_000,
      fromCents: null,
      setByPersonId: SAM,
    };
    await expect(catalog.addPrice(byPerson)).rejects.toMatchObject({
      reason: "workerNotOnBusiness",
      fields: ["conditions.workerResourceId"],
    });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    expect(log).toContain("resourceOf");
    const avery = { ...byPerson, conditions: { ...NO_CONDITIONS, workerResourceId: "res-avery" } };
    expect(await outcomeOf(catalog.addPrice(avery))).toBe("built");
    // A worker is a worker resource: the yoga studio's room is none, even under its own business.
    expect(
      refusalOf(() =>
        checkWorker(
          "res-studio-room",
          { id: "res-studio-room", businessId: YOGA, kind: "room", active: true, version: 1 },
          YOGA,
        ),
      ),
    ).toBe("workerNotOnBusiness");
  });
});

describe("(d) a kind's company is the business's (read 1; T-320 N1)", () => {
  it("a kind placed on the barbershop under Lee Home Services' company is refused; under its own it passes", async () => {
    const { catalog } = catalogAt(seeded());
    const placing = {
      companyId: "company-lee-home-services",
      kindId: "dog-walker",
      tradeName: null,
      facts: [],
      switchesA: [],
      switchesB: [],
    };
    await expect(catalog.placeKind(placing)).rejects.toMatchObject({
      reason: "companyNotOnBusiness",
      fields: ["companyId"],
    });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    expect(await outcomeOf(catalog.placeKind({ ...placing, companyId: "company-lees-barbershop" }))).toBe(
      "built",
    );
  });
});

describe("(e) a link reads the space's business instead of trusting it (T-320 N1; default 11 withdrawn)", () => {
  it("the inn's suite named as the barbershop's is refused; the inn's own run is linked", async () => {
    const store = new Store([
      ...seedRows(SEEDS),
      ...seedRows(["services-prices/fixtures/seed-item-services.json"]),
    ]);
    const claimed = catalogAt(store).catalog;
    await expect(
      claimed.linkSpace({
        placeOrThing: { id: "place-pet-boarding-suite", businessId: BARBERSHOP },
        serviceId: "svc-lees-haircut",
      }),
    ).rejects.toMatchObject({ reason: "spaceNotOnBusiness", fields: ["placeOrThing.id"] });
    expect(claimed.written()).toEqual({ versionsRead: [], state: [] });
    const { catalog, log } = catalogAt(store, { businessId: PET_BOARDING });
    const run = { id: "place-pet-boarding-standard-run", businessId: PET_BOARDING };
    expect(
      await outcomeOf(catalog.linkSpace({ placeOrThing: run, serviceId: "svc-boarding-suite-stay" })),
    ).toBe("built");
    expect(log).toContain("placeOrThingOf");
  });
});

describe("(f) checkCatalogWrite refuses an update that sets the row's business, id or key (T-320 N2)", () => {
  const way = (set: Record<string, unknown>) => () =>
    checkCatalogWrite({
      op: "update",
      table: "service_money",
      key: { id: "way-lees-haircut-shop" },
      expectVersion: 1,
      set,
    });
  const kind = (set: Record<string, unknown>) => () =>
    checkCatalogWrite({
      op: "update",
      table: "company_kinds",
      key: { company_id: "company-lees-barbershop", kind_id: "barber" },
      expectVersion: 1,
      set,
    });

  it("business_id, id and a key column are refused, each named; the fee alone passes", () => {
    expect(refusalOf(way({ fee_cents: 2500, business_id: HOME_SERVICES }))).toBe("notCatalogWrite");
    expect(refusalOf(way({ id: "way-lees-haircut-home" }))).toBe("notCatalogWrite");
    expect(refusalOf(kind({ kind_id: "dog-walker" }))).toBe("notCatalogWrite");
    expect(() => way({ business_id: HOME_SERVICES })()).toThrow("(service_money.business_id)");
    expect(refusalOf(way({ fee_cents: 2500 }))).toBeNull();
    expect(refusalOf(kind({ trade_name: "Lee's Cuts" }))).toBeNull();
  });
});

describe("(g) a kind is named by K-05 v1.18 item 77's '/' name, never 'company|kind' (the database engineer's N4)", () => {
  it("a placed kind's id is company/kind, an updated one's the name read 1 answers, and neither holds a '|'", async () => {
    const { catalog } = catalogAt(seeded());
    const placed = await catalog.placeKind({
      companyId: "company-lees-barbershop",
      kindId: "dog-walker",
      tradeName: null,
      facts: [],
      switchesA: [],
      switchesB: [],
    });
    const updated = await catalog.updateKind({
      companyId: "company-lees-barbershop",
      kindId: "barber",
      tradeName: "Lee's Cuts",
    });
    expect([placed.id, updated.id]).toEqual([
      "company-lees-barbershop/dog-walker",
      "company-lees-barbershop/barber",
    ]);
    expect(`${placed.id}${updated.id}`).not.toContain("|");
    expect((await catalog.kinds()).map((each) => each.rowId)).toEqual([
      "company-lees-barbershop/barber",
      "company-lees-barbershop/dog-walker",
    ]);
  });
});

describe("(h) read 1's setup, item 77's names and the flows' versions, through the widened port (README item 72)", () => {
  /** The seeds' reads with the barbershop's setup as given. */
  function withSetup(store: Store, setup: "noMoney" | "none"): CatalogReads {
    const base = readsOf(store);
    return {
      ...base,
      kindsOf: async (businessId) => {
        const read = await base.kindsOf(businessId);
        if (setup === "none") return { ...read, setup: null };
        return { ...read, setup: read.setup === null ? null : { ...read.setup, noMoney: true } };
      },
    };
  }

  it("with no money through Rosie, a way that takes money is refused and one that takes none passes", async () => {
    const store = seeded();
    const { catalog } = catalogAt(store, { reads: withSetup(store, "noMoney") });
    await expect(catalog.addWay(kidsCutAtSecondShop)).rejects.toMatchObject({
      reason: "noMoneyPath",
      fields: ["path", "noMoney"],
    });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    const counter = { ...kidsCutAtSecondShop, path: "list|none|counter", feeCents: null };
    expect(await outcomeOf(catalog.addWay(counter))).toBe("built");
  });

  it("with no setup row yet (null), the closed side: no money through Rosie (default 161)", async () => {
    const store = seeded();
    const { catalog } = catalogAt(store, { reads: withSetup(store, "none") });
    expect(await outcomeOf(catalog.addWay(kidsCutAtSecondShop))).toBe("noMoneyPath");
    const counter = { ...kidsCutAtSecondShop, path: "list|none|counter", feeCents: null };
    const built = await catalog.addWay(counter);
    // No setup row, so none is named; the kind's rows are.
    expect(built.writes.versionsRead.map((ref) => ref.table)).toEqual([
      "services",
      "company_kinds",
      "kind_flows",
    ]);
  });

  it("a way rests on its kind's rows by item 77's names and the business's setup, at the versions read 1 answers", async () => {
    const { catalog } = catalogAt(seeded());
    const kinds = await catalog.kinds();
    expect(kinds.map((kind) => [kind.rowId, kind.flows])).toEqual([
      [
        "company-lees-barbershop/barber",
        [
          { rowId: "barber/A", flow: "A", version: 1 },
          { rowId: "barber/B", flow: "B", version: 1 },
        ],
      ],
    ]);
    const built = await catalog.addWay(kidsCutAtSecondShop);
    expect(built.writes.versionsRead).toEqual([
      { table: "services", rowId: "svc-lees-kids-cut", version: 1 },
      { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 1 },
      { table: "kind_flows", rowId: "barber/A", version: 1 },
      { table: "business_setup", rowId: BARBERSHOP, version: 4 },
    ]);
  });

  it("a snapshot that copies the flow's default rests on it by its item 77 name; one that copies the way's own does not", async () => {
    const store = seeded();
    const snapshot = (serviceId: string, serviceMoneyId: string) =>
      catalogAt(store, { now: SKIN_FADE_WRITTEN, call: "gateAndCommit" }).catalog.takeTermsSnapshot({
        bookingId: `booking-dee-${serviceId}`,
        flow: "A",
        serviceId,
        serviceMoneyId,
        termsConsentId: null,
        termsVersion: "2026-10-19.1",
        termsLanguage: "en",
        noticesShown: [],
        zone: ZONE,
      });
    const haircut = await snapshot("svc-lees-haircut", "way-lees-haircut-shop");
    expect(haircut.cutoff.from).toBe("flowDefault");
    expect(haircut.writes.versionsRead).toContainEqual({
      table: "flow_defaults",
      rowId: `${BARBERSHOP}/A`,
      version: 1,
    });
    const skinFade = await snapshot("svc-lees-skin-fade", "way-lees-skin-fade-shop");
    expect(skinFade.cutoff.from).toBe("way");
    expect(skinFade.writes.versionsRead.map((ref) => ref.table)).not.toContain("flow_defaults");
  });
});

describe("(i) fact and switch names only from K-26 v1's registry (CQ-349 (3))", () => {
  const placing = {
    companyId: "company-lees-barbershop",
    kindId: "dog-walker",
    tradeName: null,
    facts: ["animals", "photos"],
    switchesA: [],
    switchesB: [],
  };

  it("a fact or switch the registry does not hold is refused, named, never written; the registry's own pass", async () => {
    const { catalog } = catalogAt(seeded());
    await expect(catalog.placeKind({ ...placing, facts: ["animals", "pets"] })).rejects.toMatchObject({
      reason: "nameNotInRegistry",
      fields: ["facts.1"],
    });
    // A fact is no switch: photos is a trade fact, never a switch.
    await expect(catalog.placeKind({ ...placing, switchesA: ["photos"] })).rejects.toMatchObject({
      reason: "nameNotInRegistry",
      fields: ["switchesA.0"],
    });
    await expect(
      catalog.updateKind({ companyId: "company-lees-barbershop", kindId: "barber", switchesB: ["grief"] }),
    ).rejects.toMatchObject({ reason: "nameNotInRegistry", fields: ["switchesB.0"] });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    expect(await outcomeOf(catalog.placeKind({ ...placing, switchesB: ["cancelright"] }))).toBe("built");
    expect(
      await outcomeOf(
        catalog.updateKind({
          companyId: "company-lees-barbershop",
          kindId: "barber",
          switchesA: ["welfare"],
        }),
      ),
    ).toBe("built");
  });
});
