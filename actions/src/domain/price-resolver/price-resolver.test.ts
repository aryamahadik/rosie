// T-639's proof (C-132; arch 05 line 253; S13-25 rule 19; K-25 v1 "How a price is found"): the rule with the most
// conditions set wins (worker and place beat the worker alone); a tie between two equally specific rules is flagged when
// the owner saves the second, and the read-back asks which wins; until it is answered the lower price is returned, and
// the owner's answer then wins. Effective dates and time conditions read in the visit's zone price by the visit's start.
//
// Every rule is saved through the catalog and pricing service (T-320's createCatalog, which writes the tie at the save)
// over K-25's own seeds in T-320's in-memory store, and the resolver reads them through the catalog's read 4 (readsOf).
// Rule 9: Lee's Barbershop, Lee Home Services and the movers are fixture set v1's demo shops; Sam, Andre and Avery its
// sample cast; the made-up prices ($50 with Andre, $90 with Andre at home, $90 or $50 after 5pm) are examples only.

import { describe, expect, it } from "vitest";

import { NO_CONDITIONS, createCatalog, type PriceConditions } from "../catalog";
import {
  BARBERSHOP,
  DEE_VISIT,
  HOME_SERVICES,
  MOVERS,
  NOV_2,
  RAISE_DAY,
  SAM,
  SEEDS,
  Store,
  WITHDRAW_DAY,
  ZONE,
  readsOf,
  ruleOf,
  seedRows,
} from "../catalog/test-support";
import {
  PriceResolverError,
  createPriceResolver,
  localStart,
  resolvePrice,
  tieQuestions,
  tiesAtSave,
  type Visit,
} from "./index";

const HAIRCUT = "svc-lees-haircut";
const SHOP = "way-lees-haircut-shop";
const HOME = "way-lees-haircut-home";
const ANDRE = "res-andre";
const AVERY = "res-avery";

const HOME_RULE = "price-lees-haircut-home";
const EVENING_RULE = "price-lees-haircut-evening";
const ANDRE_RULE = "price-lees-haircut-andre";
const ANDRE_HOME_RULE = "price-lees-haircut-andre-home";

/** Sat Nov 7 in the barbershop's zone (after the clocks went back on Sun Nov 1): 3pm and 6pm. */
const SAT_3PM = "2026-11-07T20:00:00Z";
const SAT_6PM = "2026-11-07T23:00:00Z";

const evening: PriceConditions = { ...NO_CONDITIONS, fromTime: "17:00" };

/** The seeds as T-320's tests start from them. */
const seeded = (): Store => new Store(seedRows(SEEDS));

/** One owner's turn of the catalog at `now`, its writes applied to the store when it ends. */
async function ownerTurn(
  store: Store,
  now: string,
  turnKey: string,
  work: (catalog: ReturnType<typeof createCatalog>) => Promise<unknown>,
): Promise<void> {
  const catalog = createCatalog({
    call: "saveSetupStep",
    businessId: BARBERSHOP,
    currency: "USD",
    now,
    turnKey,
    reads: readsOf(store),
  });
  await work(catalog);
  store.apply(catalog.written().state);
}

/** A haircut price Sam saves now, from now on. */
const price = (id: string, conditions: PriceConditions, priceCents: number) => ({
  id,
  serviceId: HAIRCUT,
  conditions,
  priceCents,
  fromCents: null,
  setByPersonId: SAM,
});

/** A haircut visit in the barbershop's zone. */
const haircut = (startsAt: string, wayId: string | null, workerResourceId: string | null): Visit => ({
  serviceId: HAIRCUT,
  startsAt,
  wayId,
  workerResourceId,
  zone: ZONE,
});

const resolverOver = (store: Store, businessId = BARBERSHOP) =>
  createPriceResolver({ businessId, reads: readsOf(store) });

/** The id of the tie row asking about two rules, either way round. */
function tieBetween(store: Store, a: string, b: string): string {
  const found = store
    .rows("price_rule_ties")
    .find(
      (row) =>
        (row.first_rule_id === a && row.second_rule_id === b) ||
        (row.first_rule_id === b && row.second_rule_id === a),
    );
  if (typeof found?.id !== "string") throw new Error("no tie row asks about the pair");
  return found.id;
}

describe("the rule with the most conditions set wins (step 3)", () => {
  it("Andre at the customer's home (worker and place) beats Andre alone, the home price alone and the haircut's own price", async () => {
    const store = seeded();
    await ownerTurn(store, RAISE_DAY, "turn-sam-0700", async (catalog) => {
      await catalog.addPrice(price(ANDRE_RULE, { ...NO_CONDITIONS, workerResourceId: ANDRE }, 5000));
      const both = await catalog.addPrice(
        price(ANDRE_HOME_RULE, { ...NO_CONDITIONS, workerResourceId: ANDRE, serviceMoneyId: HOME }, 9000),
      );
      // Two conditions set: no rule of as many, so no tie to ask about.
      expect(both.tieIds).toEqual([]);
    });
    const resolver = resolverOver(store);

    expect(await resolver.priceFor(haircut(DEE_VISIT, HOME, ANDRE))).toEqual({
      found: true,
      ruleId: ANDRE_HOME_RULE,
      priceCents: 9000,
      fromCents: null,
      currency: "USD",
      conditionCount: 2,
      decidedBy: "mostConditions",
      tiedRuleIds: [ANDRE_HOME_RULE],
      openTieIds: [],
    });
    // At the shop the place rules do not hold: Andre's own price (one condition) beats the haircut's $40 (none).
    expect(await resolver.priceFor(haircut(DEE_VISIT, SHOP, ANDRE))).toMatchObject({
      ruleId: ANDRE_RULE,
      priceCents: 5000,
      conditionCount: 1,
      decidedBy: "mostConditions",
    });
    // Avery: no rule of hers, so the place's price at home and the haircut's own at the shop.
    expect(await resolver.priceFor(haircut(DEE_VISIT, HOME, AVERY))).toMatchObject({
      ruleId: HOME_RULE,
      priceCents: 7500,
      conditionCount: 1,
    });
    expect(await resolver.priceFor(haircut(DEE_VISIT, SHOP, AVERY))).toMatchObject({
      ruleId: "price-lees-haircut-40",
      priceCents: 4000,
      conditionCount: 0,
      decidedBy: "mostConditions",
    });
    // No worker chosen yet ("whoever goes", default 1): a worker's rule does not hold.
    expect(await resolver.priceFor(haircut(DEE_VISIT, HOME, null))).toMatchObject({
      ruleId: HOME_RULE,
      priceCents: 7500,
    });
  });

  it("the same order over rows alone, whatever order they are read in: worker and place, worker, none", () => {
    const store = seeded();
    const base = ruleOf(store.row("price_rules", "price-lees-haircut-40") ?? {});
    const andre = {
      ...base,
      id: ANDRE_RULE,
      conditions: { ...NO_CONDITIONS, workerResourceId: ANDRE },
      priceCents: 5000,
    };
    const andreHome = {
      ...base,
      id: ANDRE_HOME_RULE,
      conditions: { ...NO_CONDITIONS, workerResourceId: ANDRE, serviceMoneyId: HOME },
      priceCents: 9000,
    };
    for (const rules of [
      [base, andre, andreHome],
      [andreHome, andre, base],
    ]) {
      expect(resolvePrice(haircut(DEE_VISIT, HOME, ANDRE), rules, [])).toMatchObject({
        ruleId: ANDRE_HOME_RULE,
        priceCents: 9000,
      });
      expect(resolvePrice(haircut(DEE_VISIT, HOME, AVERY), rules, [])).toMatchObject({
        ruleId: "price-lees-haircut-40",
        priceCents: 4000,
      });
    }
  });
});

describe("a tie between two equally specific rules is flagged at the second save (arch 05 line 253)", () => {
  it("an evening haircut price saved beside the at-home price is a tie: the catalog writes it, tiesAtSave names the home price, and the read-back asks which wins with both prices", async () => {
    const store = seeded();
    const before = await readsOf(store).priceRulesOf(BARBERSHOP, HAIRCUT, RAISE_DAY);
    let tieIds: readonly string[] = [];
    await ownerTurn(store, RAISE_DAY, "turn-sam-0710", async (catalog) => {
      tieIds = (await catalog.addPrice(price(EVENING_RULE, evening, 9000))).tieIds;
    });
    expect(tieIds).toEqual(["tie-turn-sam-0710-1"]);
    const saved = ruleOf(store.row("price_rules", EVENING_RULE) ?? {});
    expect(tiesAtSave(saved, before.rules, before.ties).map((rule) => rule.id)).toEqual([HOME_RULE]);
    // Once written, the pair is asked about already: the same save finds no new tie.
    const after = await readsOf(store).priceRulesOf(BARBERSHOP, HAIRCUT, RAISE_DAY);
    expect(tiesAtSave(saved, after.rules, after.ties)).toEqual([]);

    const questions = await resolverOver(store).tiesToAsk(HAIRCUT, RAISE_DAY);
    expect(questions).toEqual([
      {
        tieId: "tie-turn-sam-0710-1",
        serviceId: HAIRCUT,
        askedAt: RAISE_DAY,
        first: {
          ruleId: HOME_RULE,
          conditions: { ...NO_CONDITIONS, serviceMoneyId: HOME },
          priceCents: 7500,
          fromCents: null,
          currency: "USD",
          effectiveFrom: "2026-10-19T18:11:00Z",
          effectiveTo: null,
        },
        second: {
          ruleId: EVENING_RULE,
          conditions: evening,
          priceCents: 9000,
          fromCents: null,
          currency: "USD",
          effectiveFrom: RAISE_DAY,
          effectiveTo: null,
        },
      },
    ]);
    expect(tieQuestions(after.rules, after.ties)).toEqual(questions);
  });

  it("no tie where the rules can never both apply or set fewer conditions: Saturdays beside Sundays, a place rule beside worker and place", async () => {
    const store = seeded();
    const read = await readsOf(store).priceRulesOf(BARBERSHOP, HAIRCUT, RAISE_DAY);
    const base = ruleOf(store.row("price_rules", "price-lees-haircut-40") ?? {});
    const saturday = {
      ...base,
      id: "price-lees-haircut-saturday",
      conditions: { ...NO_CONDITIONS, weekdays: "6" },
    };
    const sunday = {
      ...base,
      id: "price-lees-haircut-sunday",
      conditions: { ...NO_CONDITIONS, weekdays: "7" },
    };
    // Sunday's price ties with the home price (both apply to a Sunday visit at home), never with Saturday's.
    expect(tiesAtSave(sunday, [...read.rules, saturday], read.ties).map((rule) => rule.id)).toEqual([
      HOME_RULE,
    ]);
    const andreHome = {
      ...base,
      id: ANDRE_HOME_RULE,
      effectiveFrom: RAISE_DAY,
      effectiveTo: null,
      conditions: { ...NO_CONDITIONS, workerResourceId: ANDRE, serviceMoneyId: HOME },
    };
    expect(tiesAtSave(andreHome, read.rules, read.ties)).toEqual([]);
    // A Saturday price does tie with the home price: both can apply to a Saturday visit at home.
    expect(
      tiesAtSave({ ...saturday, effectiveFrom: RAISE_DAY, effectiveTo: null }, read.rules, read.ties).map(
        (rule) => rule.id,
      ),
    ).toEqual([HOME_RULE]);
  });
});

describe("until a tie is answered the lower price is returned (S13-25 rule 19), then the owner's winner", () => {
  it("the evening price ($90) beside the home price ($75): a visit at home at 6pm takes $75 until Sam answers, then $90", async () => {
    const store = seeded();
    await ownerTurn(store, RAISE_DAY, "turn-sam-0720", (catalog) =>
      catalog.addPrice(price(EVENING_RULE, evening, 9000)),
    );
    const tieId = tieBetween(store, HOME_RULE, EVENING_RULE);
    const resolver = resolverOver(store);

    expect(await resolver.priceFor(haircut(SAT_6PM, HOME, null))).toEqual({
      found: true,
      ruleId: HOME_RULE,
      priceCents: 7500,
      fromCents: null,
      currency: "USD",
      conditionCount: 1,
      decidedBy: "lowerPrice",
      tiedRuleIds: [EVENING_RULE, HOME_RULE],
      openTieIds: [tieId],
    });
    // Where only one holds there is nothing to ask: at home at 3pm, the home price; at the shop at 6pm, the evening price.
    expect(await resolver.priceFor(haircut(SAT_3PM, HOME, null))).toMatchObject({
      ruleId: HOME_RULE,
      decidedBy: "mostConditions",
      openTieIds: [],
    });
    expect(await resolver.priceFor(haircut(SAT_6PM, SHOP, null))).toMatchObject({
      ruleId: EVENING_RULE,
      priceCents: 9000,
      decidedBy: "mostConditions",
    });

    await ownerTurn(store, WITHDRAW_DAY, "turn-sam-0730", (catalog) =>
      catalog.answerTie({ tieId, serviceId: HAIRCUT, winnerRuleId: EVENING_RULE, answeredByPersonId: SAM }),
    );
    expect(await resolver.priceFor(haircut(SAT_6PM, HOME, null))).toMatchObject({
      ruleId: EVENING_RULE,
      priceCents: 9000,
      decidedBy: "ownerAnswer",
      tiedRuleIds: [EVENING_RULE, HOME_RULE],
      openTieIds: [],
    });
    expect(await resolver.tiesToAsk(HAIRCUT, WITHDRAW_DAY)).toEqual([]);
  });

  it("the lower price is whichever rule is lower: an evening price of $50 is taken at home at 6pm until Sam names the home price", async () => {
    const store = seeded();
    await ownerTurn(store, RAISE_DAY, "turn-sam-0740", (catalog) =>
      catalog.addPrice(price(EVENING_RULE, evening, 5000)),
    );
    const tieId = tieBetween(store, HOME_RULE, EVENING_RULE);
    const resolver = resolverOver(store);
    expect(await resolver.priceFor(haircut(SAT_6PM, HOME, null))).toMatchObject({
      ruleId: EVENING_RULE,
      priceCents: 5000,
      decidedBy: "lowerPrice",
      openTieIds: [tieId],
    });
    await ownerTurn(store, WITHDRAW_DAY, "turn-sam-0750", (catalog) =>
      catalog.answerTie({ tieId, serviceId: HAIRCUT, winnerRuleId: HOME_RULE, answeredByPersonId: SAM }),
    );
    expect(await resolver.priceFor(haircut(SAT_6PM, HOME, null))).toMatchObject({
      ruleId: HOME_RULE,
      priceCents: 7500,
      decidedBy: "ownerAnswer",
    });
  });

  it("three rules of one condition each (place, time, worker): the lowest until answered; each answer drops a loser; the last answer decides", async () => {
    const store = seeded();
    await ownerTurn(store, RAISE_DAY, "turn-sam-0760", async (catalog) => {
      await catalog.addPrice(price(EVENING_RULE, evening, 9000));
      await catalog.addPrice(price(ANDRE_RULE, { ...NO_CONDITIONS, workerResourceId: ANDRE }, 5000));
    });
    const homeEvening = tieBetween(store, HOME_RULE, EVENING_RULE);
    const homeAndre = tieBetween(store, HOME_RULE, ANDRE_RULE);
    const eveningAndre = tieBetween(store, EVENING_RULE, ANDRE_RULE);
    const resolver = resolverOver(store);
    const visit = haircut(SAT_6PM, HOME, ANDRE);

    expect(await resolver.priceFor(visit)).toMatchObject({
      ruleId: ANDRE_RULE,
      priceCents: 5000,
      decidedBy: "lowerPrice",
      tiedRuleIds: [ANDRE_RULE, EVENING_RULE, HOME_RULE],
      openTieIds: [homeEvening, homeAndre, eveningAndre].sort(),
    });

    await ownerTurn(store, WITHDRAW_DAY, "turn-sam-0770", async (catalog) => {
      await catalog.answerTie({
        tieId: homeAndre,
        serviceId: HAIRCUT,
        winnerRuleId: HOME_RULE,
        answeredByPersonId: SAM,
      });
      await catalog.answerTie({
        tieId: eveningAndre,
        serviceId: HAIRCUT,
        winnerRuleId: EVENING_RULE,
        answeredByPersonId: SAM,
      });
    });
    // Andre's price lost both its ties; the home and evening prices are still unanswered: the lower, $75.
    expect(await resolver.priceFor(visit)).toMatchObject({
      ruleId: HOME_RULE,
      priceCents: 7500,
      decidedBy: "lowerPrice",
      openTieIds: [homeEvening],
    });

    await ownerTurn(store, WITHDRAW_DAY, "turn-sam-0780", (catalog) =>
      catalog.answerTie({
        tieId: homeEvening,
        serviceId: HAIRCUT,
        winnerRuleId: EVENING_RULE,
        answeredByPersonId: SAM,
      }),
    );
    expect(await resolver.priceFor(visit)).toMatchObject({
      ruleId: EVENING_RULE,
      priceCents: 9000,
      decidedBy: "ownerAnswer",
      openTieIds: [],
    });
  });

  it("two rules of as many with no tie row asking about them still take the lower price (default 2)", () => {
    const store = seeded();
    const home = ruleOf(store.row("price_rules", HOME_RULE) ?? {});
    const late = { ...home, id: EVENING_RULE, conditions: evening, priceCents: 6000 };
    expect(resolvePrice(haircut(SAT_6PM, HOME, null), [home, late], [])).toMatchObject({
      ruleId: EVENING_RULE,
      priceCents: 6000,
      decidedBy: "lowerPrice",
      openTieIds: [],
    });
  });
});

describe("effective dates and time conditions price by the visit's start, in the visit's zone (K-25 rule 8)", () => {
  it("the haircut at the shop is $35 up to the start of Mon Nov 2 and $40 from that instant (S11-54)", async () => {
    const resolver = resolverOver(seeded());
    const at = (startsAt: string) => resolver.priceFor(haircut(startsAt, SHOP, null));
    expect(await at("2026-10-30T15:00:00Z")).toMatchObject({
      ruleId: "price-lees-haircut-35",
      priceCents: 3500,
    });
    expect(await at("2026-11-02T04:59:59.999Z")).toMatchObject({ priceCents: 3500 });
    expect(await at(NOV_2)).toMatchObject({ ruleId: "price-lees-haircut-40", priceCents: 4000 });
  });

  it("a price withdrawn before it started prices nothing: the faucet rebuild stays $35 at midnight on Nov 2", async () => {
    const store = new Store(
      seedRows([...SEEDS, "services-prices/fixtures/seed-price-withdrawn-before-start.json"]),
    );
    const resolver = resolverOver(store, HOME_SERVICES);
    expect(
      await resolver.priceFor({
        serviceId: "svc-lee-plumbing-faucet-rebuild",
        startsAt: NOV_2,
        wayId: "way-lee-plumbing-faucet-rebuild-office",
        workerResourceId: null,
        zone: ZONE,
      }),
    ).toMatchObject({ ruleId: "price-lee-plumbing-faucet-rebuild-35-again", priceCents: 3500 });
  });

  it("the movers' vault visit is $40 from 5pm read in the visit's zone: 5:30pm in New York, 4:30pm an hour behind", async () => {
    const resolver = resolverOver(seeded(), MOVERS);
    const vault = (startsAt: string, zone: string): Visit => ({
      serviceId: "svc-movers-vault-visit",
      startsAt,
      wayId: "way-movers-vault-visit-warehouse",
      workerResourceId: null,
      zone,
    });
    const evening = "2026-11-04T22:30:00Z";
    expect(localStart(evening, ZONE)).toEqual({ weekday: 3, seconds: 17 * 3600 + 30 * 60 });
    expect(await resolver.priceFor(vault(evening, ZONE))).toMatchObject({
      ruleId: "price-movers-vault-visit-evening",
      priceCents: 4000,
    });
    expect(await resolver.priceFor(vault(evening, "America/Chicago"))).toMatchObject({
      ruleId: "price-movers-vault-visit",
      priceCents: 3500,
    });
    expect(await resolver.priceFor(vault("2026-11-04T16:00:00Z", ZONE))).toMatchObject({ priceCents: 3500 });
  });
});

describe("no price, and refusals (fail closed)", () => {
  it("a service with no rule (the wedding party, quoted per booking) answers none", async () => {
    expect(
      await resolverOver(seeded()).priceFor({
        ...haircut(DEE_VISIT, "way-lees-wedding-party-home", null),
        serviceId: "svc-lees-wedding-party",
      }),
    ).toEqual({ found: false });
  });

  it("a visit not in its form is refused before anything is read: an instant not UTC, an unknown zone, an empty id", async () => {
    const log: string[] = [];
    const resolver = createPriceResolver({ businessId: BARBERSHOP, reads: readsOf(seeded(), log) });
    for (const [visit, field] of [
      [{ ...haircut(DEE_VISIT, SHOP, null), startsAt: "2026-11-07 11:00" }, "startsAt"],
      [{ ...haircut(DEE_VISIT, SHOP, null), zone: "Eastern" }, "zone"],
      [{ ...haircut(DEE_VISIT, SHOP, null), serviceId: "" }, "serviceId"],
      [{ ...haircut(DEE_VISIT, SHOP, null), wayId: " " }, "wayId"],
    ] as const) {
      await expect(resolver.priceFor(visit)).rejects.toMatchObject({ reason: "badInput", fields: [field] });
    }
    await expect(resolver.tiesToAsk(HAIRCUT, "Nov 7")).rejects.toBeInstanceOf(PriceResolverError);
    expect(log).toEqual([]);
    expect(() => createPriceResolver({ businessId: "", reads: readsOf(seeded()) })).toThrow(
      PriceResolverError,
    );
  });

  it("a leaky read answering another business's rules, or another service's, is refused, never priced", async () => {
    const store = seeded();
    const leaky = createPriceResolver({
      businessId: BARBERSHOP,
      reads: readsOf(store, [], { scoped: false }),
    });
    await expect(
      leaky.priceFor({ ...haircut(DEE_VISIT, null, null), serviceId: "svc-movers-vault-visit" }),
    ).rejects.toMatchObject({ reason: "otherBusiness" });
    const wrongService = createPriceResolver({
      businessId: BARBERSHOP,
      reads: {
        priceRulesOf: (businessId, _serviceId, at) =>
          readsOf(store).priceRulesOf(businessId, "svc-lees-beard-trim", at),
      },
    });
    await expect(wrongService.priceFor(haircut(DEE_VISIT, SHOP, null))).rejects.toMatchObject({
      reason: "badRead",
    });
    const beard = await readsOf(store).priceRulesOf(BARBERSHOP, "svc-lees-beard-trim", DEE_VISIT);
    expect(() => resolvePrice(haircut(DEE_VISIT, SHOP, null), beard.rules, [])).toThrow(PriceResolverError);
  });
});
