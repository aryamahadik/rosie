// T-320's price rules (C-096; arch 09 lines 457, 478, 488; K-25 v1 "Prices"; S11-54; RULES 3.7): a change closes one row
// at its end date and opens the next at that instant; overlapping effective dates are refused; a booking line built
// before the change keeps the old price; a price set for a later date is withdrawn before it starts; a possible tie is
// caught at the second save. Every row is K-25's, K-26's or K-30's own seed (test-support.ts), and the service reads
// them only through its five reads.

import { describe, expect, it } from "vitest";

import {
  checkCatalogWrite,
  conditionCount,
  createCatalog,
  inEffectAt,
  NO_CONDITIONS,
  type CatalogDeps,
} from "./index";
import {
  BARBERSHOP,
  DEE_VISIT,
  HOME_SERVICES,
  NOV_2,
  PRICE_RULE_COLUMNS,
  RAISE_DAY,
  SAM,
  SEEDS,
  Store,
  WITHDRAW_DAY,
  beforeRaise,
  faucetBeforeRaise,
  fixtureRows,
  readsOf,
  refusalOf,
  refusedFixture,
  ruleOf,
  rulesOfService,
  seedRows,
  withDefaults,
  type ReadLog,
  type Row,
} from "./test-support";

const HAIRCUT = "svc-lees-haircut";
const FAUCET = "svc-lee-plumbing-faucet-rebuild";

function catalogAt(store: Store, now: string, more: Partial<CatalogDeps> = {}) {
  const log: ReadLog = [];
  const catalog = createCatalog({
    call: "saveSetupStep",
    businessId: BARBERSHOP,
    currency: "USD",
    now,
    turnKey: "turn-sam-0300",
    reads: readsOf(store, log),
    ...more,
  });
  return { catalog, log };
}

/** The seed's rows of a K-25 fixture by id, with every column (a column left out takes its default). */
function seedPriceRows(file: string, ids: readonly string[]): Row[] {
  const rows = fixtureRows(`services-prices/fixtures/${file}`).filter((row) => row.table === "price_rules");
  return ids.map((id) => {
    const found = rows.find((row) => row.values.id === id);
    if (found === undefined) throw new Error(`${file} has no ${id}`);
    return withDefaults(found.values, PRICE_RULE_COLUMNS);
  });
}

function storedRows(store: Store, ids: readonly string[]): Row[] {
  return ids.map((id) => withDefaults(store.row("price_rules", id) ?? {}, PRICE_RULE_COLUMNS));
}

const raise = {
  id: "price-lees-haircut-40",
  serviceId: HAIRCUT,
  conditions: NO_CONDITIONS,
  priceCents: 4000,
  fromCents: null,
  setByPersonId: SAM,
  effectiveFrom: NOV_2,
};

describe("a price change closes one row and opens the next (arch 09 line 488; S11-54)", () => {
  it("raising the haircut to $40 for visits from Mon Nov 2 closes the $35 rule at that end date and opens the $40 rule there", async () => {
    const store = beforeRaise();
    const { catalog } = catalogAt(store, RAISE_DAY);
    const change = await catalog.changePrice(raise);

    expect(change.closedRuleId).toBe("price-lees-haircut-35");
    expect(change.openedRuleId).toBe("price-lees-haircut-40");
    expect(change.tieIds).toEqual([]);
    expect(change.writes.state).toEqual([
      {
        op: "update",
        table: "price_rules",
        key: { id: "price-lees-haircut-35" },
        expectVersion: 1,
        set: { effective_to: NOV_2 },
      },
      {
        op: "insert",
        table: "price_rules",
        values: {
          id: "price-lees-haircut-40",
          business_id: BARBERSHOP,
          service_id: HAIRCUT,
          service_money_id: null,
          worker_resource_id: null,
          weekdays: null,
          from_time: null,
          until_time: null,
          price_cents: 4000,
          from_cents: null,
          currency: "USD",
          set_by_person_id: SAM,
          effective_from: NOV_2,
          effective_to: null,
        },
      },
    ]);
    expect(change.writes.versionsRead).toEqual([{ table: "services", rowId: HAIRCUT, version: 1 }]);

    // Committed, the two rows are K-25's seed after S11-54, column for column: $35 closed at Nov 2, $40 from then.
    store.apply(change.writes.state);
    const ids = ["price-lees-haircut-35", "price-lees-haircut-40"];
    expect(storedRows(store, ids)).toEqual(seedPriceRows("seed-price-rule-dates.json", ids));
    expect(catalog.written().state).toEqual(change.writes.state);
  });

  it("a booking line built before the change keeps the old price, even for a visit after it (RULES 3.7)", async () => {
    const store = beforeRaise();
    // Dee's haircut line, made Fri Oct 23 while the $35 rule was open, for Sat Nov 7 (K-30 seed-booking-line-price-copied).
    const line = store.row("booking_lines", "line-dee-haircut-1");
    expect(line).toMatchObject({ price_cents: 3500, price_rule_id: "price-lees-haircut-35", state: "open" });
    const lineBefore = structuredClone(line);
    const { catalog } = catalogAt(store, RAISE_DAY);
    const change = await catalog.changePrice(raise);

    // No write names a booking line, and the only update closes a rule: no price is ever edited in place.
    expect(change.writes.state.map((write) => write.table)).toEqual(["price_rules", "price_rules"]);
    for (const write of change.writes.state)
      if (write.op === "update") expect(Object.keys(write.set)).toEqual(["effective_to"]);
    store.apply(change.writes.state);

    expect(store.row("booking_lines", "line-dee-haircut-1")).toEqual(lineBefore);
    expect(store.row("price_rules", "price-lees-haircut-35")).toMatchObject({
      price_cents: 3500,
      effective_to: NOV_2,
      version: 2,
    });
    // The list prices her Nov 7 visit at $40 now; her line keeps the $35 it copied.
    const visit = Date.parse(DEE_VISIT);
    const listed = rulesOfService(store, HAIRCUT)
      .map(ruleOf)
      .filter((rule) => conditionCount(rule.conditions) === 0 && inEffectAt(rule, visit));
    expect(listed.map((rule) => [rule.id, rule.priceCents])).toEqual([["price-lees-haircut-40", 4000]]);
    const read = await catalogAt(store, RAISE_DAY).catalog.priceRules(HAIRCUT, DEE_VISIT);
    expect(
      read.rules.filter((rule) => conditionCount(rule.conditions) === 0).map((rule) => rule.priceCents),
    ).toEqual([4000]);
  });

  it("a time rule's change keeps its conditions: the movers' evening vault visit from $40 to $45, the day price untouched", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store, RAISE_DAY, { businessId: "biz-movers" });
    const evening = { ...NO_CONDITIONS, fromTime: "17:00" };
    const change = await catalog.changePrice({
      serviceId: "svc-movers-vault-visit",
      conditions: evening,
      priceCents: 4500,
      fromCents: null,
      setByPersonId: SAM,
      effectiveFrom: NOV_2,
    });
    expect(change.closedRuleId).toBe("price-movers-vault-visit-evening");
    expect(change.openedRuleId).toBe("price-turn-sam-0300-1");
    store.apply(change.writes.state);
    expect(store.row("price_rules", "price-turn-sam-0300-1")).toMatchObject({
      from_time: "17:00",
      until_time: null,
      price_cents: 4500,
      effective_from: NOV_2,
      effective_to: null,
    });
    expect(store.row("price_rules", "price-movers-vault-visit")).toMatchObject({
      price_cents: 3500,
      version: 1,
    });
  });

  it("a price is never edited in place: the one gate to the commit refuses an update that sets anything but the end", () => {
    const close = (set: Row) => () =>
      checkCatalogWrite({
        op: "update",
        table: "price_rules",
        key: { id: "price-lees-haircut-35" },
        expectVersion: 1,
        set,
      });
    expect(refusalOf(close({ price_cents: 4000 }))).toBe("notCatalogWrite");
    expect(refusalOf(close({ effective_to: NOV_2, version: 2 }))).toBe("notCatalogWrite");
    expect(refusalOf(close({ effective_to: NOV_2 }))).toBeNull();
  });

  it("refuses a change with no price in effect then, one dated before now, and one from an old read (limit 4)", async () => {
    const store = beforeRaise();
    const { catalog } = catalogAt(store, RAISE_DAY);
    const andre = { ...NO_CONDITIONS, workerResourceId: "res-andre" };
    await expect(catalog.changePrice({ ...raise, conditions: andre })).rejects.toMatchObject({
      reason: "noPriceToChange",
    });
    await expect(
      catalog.changePrice({ ...raise, effectiveFrom: "2026-10-20T05:00:00Z" }),
    ).rejects.toMatchObject({
      reason: "backdated",
    });
    await expect(catalog.changePrice({ ...raise, expectVersion: 2 })).rejects.toMatchObject({
      reason: "versionChanged",
    });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    // A refused call changes nothing the next one sees: the raise still goes through, once.
    const change = await catalog.changePrice(raise);
    expect(change.closedRuleId).toBe("price-lees-haircut-35");
    await expect(
      catalog.changePrice({ ...raise, id: "price-lees-haircut-45", priceCents: 4500 }),
    ).rejects.toMatchObject({ reason: "rowTwice" });
  });

  it("closes a price at an instant with none opening, never before its own start", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store, RAISE_DAY);
    const closed = await catalog.closePrice({
      ruleId: "price-lees-haircut-home",
      serviceId: HAIRCUT,
      at: "2026-11-09T05:00:00Z",
    });
    expect(closed).toMatchObject({ closedRuleId: "price-lees-haircut-home", openedRuleId: null });
    expect(closed.writes.state).toEqual([
      {
        op: "update",
        table: "price_rules",
        key: { id: "price-lees-haircut-home" },
        expectVersion: 1,
        set: { effective_to: "2026-11-09T05:00:00Z" },
      },
    ]);
    await expect(
      catalog.closePrice({ ruleId: "price-lees-haircut-40", serviceId: HAIRCUT, at: "2026-10-30T05:00:00Z" }),
    ).rejects.toMatchObject({ reason: "closedBeforeStart" });
  });
});

describe("overlapping effective dates are refused (K-25 price_rules_one_in_effect)", () => {
  const { refused } = refusedFixture(
    "services-prices/fixtures/invalid/refuse-overlapping-effective-dates.json",
  );
  const values = refused.values;
  const added = {
    id: String(values.id),
    serviceId: String(values.service_id),
    conditions: NO_CONDITIONS,
    priceCents: Number(values.price_cents),
    fromCents: null,
    setByPersonId: String(values.set_by_person_id),
    effectiveFrom: String(values.effective_from),
  };

  it("adding S11-54's $40 from Nov 2 while the $35 row is still open is refused and nothing is written (refuse-overlapping-effective-dates.json)", async () => {
    const store = beforeRaise();
    const { catalog } = catalogAt(store, RAISE_DAY);
    await expect(catalog.addPrice(added)).rejects.toMatchObject({ reason: "overlap" });
    expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
  });

  it("the same row passes once the $35 row is closed at Nov 2 (the fixture's one reason)", async () => {
    const store = beforeRaise();
    store.put("price_rules", {
      ...(store.row("price_rules", "price-lees-haircut-35") ?? {}),
      effective_to: NOV_2,
    });
    const { catalog } = catalogAt(store, RAISE_DAY);
    const price = await catalog.addPrice(added);
    expect(price.openedRuleId).toBe("price-lees-haircut-40");
    store.apply(price.writes.state);
    expect(store.row("price_rules", "price-lees-haircut-40")).toMatchObject({
      price_cents: 4000,
      version: 1,
    });
  });

  it("a change while a later price of the same conditions is set is refused; one from inside the later price closes it", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store, WITHDRAW_DAY);
    await expect(
      catalog.changePrice({
        ...raise,
        id: "price-lees-haircut-38",
        priceCents: 3800,
        effectiveFrom: "2026-10-30T04:00:00Z",
      }),
    ).rejects.toMatchObject({ reason: "overlap" });
    const change = await catalog.changePrice({
      ...raise,
      id: "price-lees-haircut-45",
      priceCents: 4500,
      effectiveFrom: "2026-11-09T05:00:00Z",
    });
    expect(change.closedRuleId).toBe("price-lees-haircut-40");
  });

  it("a rule added with the same conditions as one in effect is refused; another worker's price does not overlap", async () => {
    const store = beforeRaise();
    const { catalog } = catalogAt(store, RAISE_DAY);
    const home = { ...NO_CONDITIONS, serviceMoneyId: "way-lees-haircut-home" };
    await expect(
      catalog.addPrice({ ...added, id: "price-lees-haircut-home-80", conditions: home, priceCents: 8000 }),
    ).rejects.toMatchObject({ reason: "overlap" });
    // Avery's event hours beside Andre's $140 and the $120 for whoever goes: other conditions, no overlap, no tie.
    const avery = await catalog.addPrice({
      id: "price-lees-event-hours-avery",
      serviceId: "svc-lees-event-hours",
      conditions: { ...NO_CONDITIONS, workerResourceId: "res-avery" },
      priceCents: 13_000,
      fromCents: null,
      setByPersonId: SAM,
    });
    expect(avery.tieIds).toEqual([]);
    expect(avery.writes.state).toHaveLength(1);
  });

  it("refuses a rule for a way priced from photos, and a 'from' price on a way not priced at the visit", async () => {
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)), RAISE_DAY);
    const rule = {
      serviceId: "svc-lees-wedding-party",
      priceCents: 64_000,
      fromCents: null,
      setByPersonId: SAM,
    };
    // The wedding party is quoted from photos: its quote prices each booking, never a rule (K-25 "Prices").
    await expect(
      catalog.addPrice({
        ...rule,
        conditions: { ...NO_CONDITIONS, serviceMoneyId: "way-lees-wedding-party-home" },
      }),
    ).rejects.toMatchObject({ reason: "badInput", fields: ["conditions.serviceMoneyId"] });
    await expect(
      catalog.addPrice({
        serviceId: HAIRCUT,
        conditions: { ...NO_CONDITIONS, serviceMoneyId: "way-lees-haircut-shop" },
        priceCents: 3500,
        fromCents: 3000,
        setByPersonId: SAM,
      }),
    ).rejects.toMatchObject({ reason: "badInput", fields: ["fromCents"] });
    expect(catalog.written().state).toEqual([]);
  });

  it("a price for the skin fade whose place is the haircut's home visit is refused; its own way passes (refuse-place-of-another-service.json)", async () => {
    const { refused } = refusedFixture(
      "services-prices/fixtures/invalid/refuse-place-of-another-service.json",
    );
    const values = refused.values;
    const { catalog } = catalogAt(new Store(seedRows(SEEDS)), RAISE_DAY);
    const price = {
      id: String(values.id),
      serviceId: String(values.service_id),
      conditions: { ...NO_CONDITIONS, serviceMoneyId: String(values.service_money_id) },
      priceCents: Number(values.price_cents),
      fromCents: null,
      setByPersonId: String(values.set_by_person_id),
    };
    await expect(catalog.addPrice(price)).rejects.toMatchObject({
      reason: "notFound",
      fields: ["conditions.serviceMoneyId"],
    });
    expect(catalog.written().state).toEqual([]);
    const own = await catalog.addPrice({
      ...price,
      conditions: { ...NO_CONDITIONS, serviceMoneyId: "way-lees-skin-fade-shop" },
    });
    expect(own).toMatchObject({ openedRuleId: "price-lees-skin-fade-home", tieIds: [] });
  });
});

describe("a price set for a later date is withdrawn before it starts (seed-price-withdrawn-before-start)", () => {
  it("closes the $40 at its own start and opens the $35 again at that instant, as K-25's seed holds them", async () => {
    const store = faucetBeforeRaise(new Store(seedRows(SEEDS)));
    const raised = await catalogAt(store, RAISE_DAY, { businessId: HOME_SERVICES }).catalog.changePrice({
      id: "price-lee-plumbing-faucet-rebuild-40",
      serviceId: FAUCET,
      conditions: NO_CONDITIONS,
      priceCents: 4000,
      fromCents: null,
      setByPersonId: SAM,
      effectiveFrom: NOV_2,
    });
    store.apply(raised.writes.state);

    const { catalog } = catalogAt(store, WITHDRAW_DAY, {
      businessId: HOME_SERVICES,
      turnKey: "turn-sam-0310",
    });
    const withdrawn = await catalog.withdrawPrice({
      ruleId: "price-lee-plumbing-faucet-rebuild-40",
      serviceId: FAUCET,
      setByPersonId: SAM,
      id: "price-lee-plumbing-faucet-rebuild-35-again",
    });
    expect(withdrawn).toMatchObject({
      closedRuleId: "price-lee-plumbing-faucet-rebuild-40",
      openedRuleId: "price-lee-plumbing-faucet-rebuild-35-again",
    });
    store.apply(withdrawn.writes.state);
    const ids = [
      "price-lee-plumbing-faucet-rebuild-35",
      "price-lee-plumbing-faucet-rebuild-35-again",
      "price-lee-plumbing-faucet-rebuild-40",
    ];
    expect(storedRows(store, ids)).toEqual(seedPriceRows("seed-price-withdrawn-before-start.json", ids));
  });

  it("refuses to withdraw a price that has started", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store, "2026-11-03T15:00:00Z");
    await expect(
      catalog.withdrawPrice({ ruleId: "price-lees-haircut-40", serviceId: HAIRCUT, setByPersonId: SAM }),
    ).rejects.toMatchObject({ reason: "started" });
    expect(catalog.written().state).toEqual([]);
  });

  it("withdraws a first price set for a later date with nothing to open again", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store, RAISE_DAY);
    const andre = { ...NO_CONDITIONS, workerResourceId: "res-andre" };
    const later = await catalog.addPrice({
      id: "price-lees-haircut-andre",
      serviceId: HAIRCUT,
      conditions: andre,
      priceCents: 4500,
      fromCents: null,
      setByPersonId: SAM,
      effectiveFrom: NOV_2,
    });
    store.apply(later.writes.state);
    const withdrawn = await catalogAt(store, WITHDRAW_DAY, {
      turnKey: "turn-sam-0310",
    }).catalog.withdrawPrice({
      ruleId: "price-lees-haircut-andre",
      serviceId: HAIRCUT,
      setByPersonId: SAM,
      expectVersion: 1,
    });
    expect(withdrawn).toMatchObject({
      closedRuleId: "price-lees-haircut-andre",
      openedRuleId: null,
      tieIds: [],
    });
    store.apply(withdrawn.writes.state);
    expect(store.row("price_rules", "price-lees-haircut-andre")).toMatchObject({
      effective_from: NOV_2,
      effective_to: NOV_2,
      version: 2,
    });
  });
});

describe("a possible tie is caught at the second save (arch 05 line 253; S13-25 rule 19)", () => {
  const evening = { ...NO_CONDITIONS, fromTime: "17:00" };

  it("an evening haircut price beside the at-home price asks which wins, and the owner's answer is kept", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store, RAISE_DAY);
    const saved = await catalog.addPrice({
      id: "price-lees-haircut-evening",
      serviceId: HAIRCUT,
      conditions: evening,
      priceCents: 5000,
      fromCents: null,
      setByPersonId: SAM,
    });
    expect(saved.tieIds).toEqual(["tie-turn-sam-0300-1"]);
    expect(saved.writes.state[1]).toEqual({
      op: "insert",
      table: "price_rule_ties",
      values: {
        id: "tie-turn-sam-0300-1",
        business_id: BARBERSHOP,
        service_id: HAIRCUT,
        first_rule_id: "price-lees-haircut-home",
        second_rule_id: "price-lees-haircut-evening",
        asked_at: RAISE_DAY,
        winner_rule_id: null,
        answered_at: null,
        answered_by_person_id: null,
      },
    });
    expect(saved.writes.versionsRead).toContainEqual({
      table: "price_rules",
      rowId: "price-lees-haircut-home",
      version: 1,
    });
    store.apply(saved.writes.state);

    const next = catalogAt(store, WITHDRAW_DAY, { turnKey: "turn-sam-0310" }).catalog;
    await expect(
      next.answerTie({
        tieId: "tie-turn-sam-0300-1",
        serviceId: HAIRCUT,
        winnerRuleId: "price-lees-haircut-35",
        answeredByPersonId: SAM,
      }),
    ).rejects.toMatchObject({ reason: "tieAnswer" });
    const answer = await next.answerTie({
      tieId: "tie-turn-sam-0300-1",
      serviceId: HAIRCUT,
      winnerRuleId: "price-lees-haircut-home",
      answeredByPersonId: SAM,
    });
    store.apply(answer.writes.state);
    expect(store.row("price_rule_ties", "tie-turn-sam-0300-1")).toMatchObject({
      winner_rule_id: "price-lees-haircut-home",
      answered_at: WITHDRAW_DAY,
      answered_by_person_id: SAM,
      version: 2,
    });
    await expect(
      catalogAt(store, WITHDRAW_DAY, { turnKey: "turn-sam-0320" }).catalog.answerTie({
        tieId: "tie-turn-sam-0300-1",
        serviceId: HAIRCUT,
        winnerRuleId: "price-lees-haircut-evening",
        answeredByPersonId: SAM,
      }),
    ).rejects.toMatchObject({ reason: "tieAnswer" });
  });

  it("no tie between rules that can never both apply: Saturdays and Sundays, or a rule and the service's own price", async () => {
    const store = new Store(seedRows(SEEDS));
    const { catalog } = catalogAt(store, RAISE_DAY);
    const saturday = await catalog.addPrice({
      serviceId: "svc-lees-beard-trim",
      conditions: { ...NO_CONDITIONS, weekdays: "6" },
      priceCents: 2500,
      fromCents: null,
      setByPersonId: SAM,
    });
    const sunday = await catalog.addPrice({
      serviceId: "svc-lees-beard-trim",
      conditions: { ...NO_CONDITIONS, weekdays: "7" },
      priceCents: 2200,
      fromCents: null,
      setByPersonId: SAM,
    });
    expect([saturday.tieIds, sunday.tieIds]).toEqual([[], []]);
    expect([saturday.openedRuleId, sunday.openedRuleId]).toEqual([
      "price-turn-sam-0300-1",
      "price-turn-sam-0300-2",
    ]);
  });
});

describe("reads", () => {
  it("each price call reads through the port: the service's row, then its rules, then its ways' deposits (T-1433 (a))", async () => {
    const store = beforeRaise();
    const { catalog, log } = catalogAt(store, RAISE_DAY);
    await catalog.changePrice(raise);
    expect(log).toEqual(["servicesOf", "priceRulesOf", "waysOf"]);
  });
});
