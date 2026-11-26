// T-639's integration proof (C-132; K-25 v1 price_rules_one_in_effect; refuse-overlapping-effective-dates.json), against
// local PostgreSQL (`npm run test:integration -- actions/src/domain/price-resolver`). One fresh schema for the file,
// migrated with every migration and dropped when it ends (T-306's openCommitDatabase), with the Tool API's client, whose
// connections run as rosie_app inside the call's business scope (withBusiness), as a commit writes.
//   - An overlapping effective-date write is refused by the table: S11-54's $40 from Mon Nov 2 inserted while the $35
//     row is still open fails with 23P01 on price_rules_one_in_effect, nothing is written, and the resolver over the
//     bound read 4 still prices the haircut $35 after Nov 2.
//   - The same row passes once the $35 row is closed at that instant (the fixture's one reason), and the resolver then
//     prices the haircut $35 before Nov 2 and $40 from it.
//   - Over every accepted v1.18 exchange's world (the catalog binding's, with the tie its fixture's note writes): the
//     resolver reads the tie between the home and evening prices, unanswered, and returns the lower price until it is
//     answered; event hours with Andre take his own price, with anyone else the service's.
// Rule 9: every row is a frozen seed of fixture set v1's demo shops (Lee's Barbershop; Sam, Andre); nothing logs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBusiness } from "../../../../db/repo/scope";
import { openCommitDatabase, type CommitDatabase } from "../../commit/pg/test-support";
import { pgCatalogReads } from "../catalog/pg";
import { BARBERSHOP, loadWorld, thrownBy, worldRows } from "../catalog/pg/test-support";
import { NOV_2, ZONE, refusedFixture, seedRows } from "../catalog/test-support";
import { createPriceResolver, type Visit } from "./index";

const SLOW = { timeout: 120_000 };
const HAIRCUT = "svc-lees-haircut";
const REFUSED = "services-prices/fixtures/invalid/refuse-overlapping-effective-dates.json";

let cdb: CommitDatabase;

beforeAll(async () => {
  cdb = await openCommitDatabase("price_resolver", 2);
}, 120_000);

afterAll(async () => {
  await cdb.close();
});

const resolver = () =>
  createPriceResolver({ businessId: BARBERSHOP, reads: pgCatalogReads(cdb.toolApi, BARBERSHOP) });

/** A haircut visit in the barbershop's zone. */
const haircut = (startsAt: string, wayId: string, workerResourceId: string | null = null): Visit => ({
  serviceId: HAIRCUT,
  startsAt,
  wayId,
  workerResourceId,
  zone: ZONE,
});

/** The haircut's price rules as the table holds them, by id. */
async function haircutRows(): Promise<{ id: string; effective_to: Date | null }[]> {
  return cdb.db.sql<{ id: string; effective_to: Date | null }[]>`
    select id, effective_to from price_rules where service_id = ${HAIRCUT} order by id
  `;
}

describe("refuse-overlapping-effective-dates.json: an overlapping effective-date write is refused by the table", () => {
  const { rows, refused } = refusedFixture(REFUSED);

  beforeAll(async () => {
    // The fixture's own chain (its `after`, named from fixtures/, not fixtures/invalid/), then its own rows: the haircut's
    // $35 as it stood before S11-54 closed it.
    await loadWorld(cdb.db.sql, cdb.db.schema, [
      ...seedRows(["services-prices/fixtures/seed-services-price-list.json"]),
      ...rows,
    ]);
  }, 120_000);

  it(
    "the $40 from Mon Nov 2 inserted by the Tool API while the $35 is open: 23P01 on price_rules_one_in_effect, nothing written, still $35 after Nov 2",
    SLOW,
    async () => {
      const error = await thrownBy(
        withBusiness(cdb.toolApi, BARBERSHOP, async (tx) => {
          await tx`insert into price_rules ${tx(refused.values as Record<string, never>)}`;
        }),
      );
      expect(error).toMatchObject({ code: "23P01", constraint_name: "price_rules_one_in_effect" });
      expect((await haircutRows()).map((row) => [row.id, row.effective_to])).toEqual([
        ["price-lees-haircut-35", null],
      ]);
      expect(
        await resolver().priceFor(haircut("2026-11-03T15:00:00Z", "way-lees-haircut-shop")),
      ).toMatchObject({
        found: true,
        ruleId: "price-lees-haircut-35",
        priceCents: 3500,
        decidedBy: "mostConditions",
      });
    },
  );

  it(
    "the same row passes once the $35 is closed at Nov 2 (a change closes one row and opens the next), and the resolver prices each side of it",
    SLOW,
    async () => {
      await withBusiness(cdb.toolApi, BARBERSHOP, async (tx) => {
        await tx`
          update price_rules set effective_to = ${NOV_2}, version = version + 1
          where id = 'price-lees-haircut-35' and version = 1
        `;
        await tx`insert into price_rules ${tx(refused.values as Record<string, never>)}`;
      });
      expect((await haircutRows()).map((row) => [row.id, row.effective_to?.toISOString() ?? null])).toEqual([
        ["price-lees-haircut-35", "2026-11-02T05:00:00.000Z"],
        ["price-lees-haircut-40", null],
      ]);
      const priced = resolver();
      expect(await priced.priceFor(haircut("2026-10-30T15:00:00Z", "way-lees-haircut-shop"))).toMatchObject({
        ruleId: "price-lees-haircut-35",
        priceCents: 3500,
      });
      expect(await priced.priceFor(haircut(NOV_2, "way-lees-haircut-shop"))).toMatchObject({
        ruleId: "price-lees-haircut-40",
        priceCents: 4000,
      });
    },
  );
});

describe("the resolver over the bound read 4, on every accepted v1.18 exchange's world", () => {
  beforeAll(async () => {
    await loadWorld(cdb.db.sql, cdb.db.schema, worldRows());
  }, 120_000);

  /** Sat Nov 7 at 6pm and at 3pm in the barbershop's zone, after the tie was asked (Tue Nov 3). */
  const SAT_6PM = "2026-11-07T23:00:00Z";
  const SAT_3PM = "2026-11-07T20:00:00Z";

  it(
    "the haircut at home in the evening: the home and evening prices tie, unanswered, so the lower ($45) until Sam answers; the read-back asks it",
    SLOW,
    async () => {
      const priced = resolver();
      expect(await priced.priceFor(haircut(SAT_6PM, "way-lees-haircut-home"))).toEqual({
        found: true,
        ruleId: "price-lees-haircut-evening",
        priceCents: 4500,
        fromCents: null,
        currency: "USD",
        conditionCount: 1,
        decidedBy: "lowerPrice",
        tiedRuleIds: ["price-lees-haircut-evening", "price-lees-haircut-home"],
        openTieIds: ["tie-lees-haircut-home-evening"],
      });
      expect(await priced.priceFor(haircut(SAT_3PM, "way-lees-haircut-home"))).toMatchObject({
        ruleId: "price-lees-haircut-home",
        priceCents: 7500,
        decidedBy: "mostConditions",
      });
      const questions = await priced.tiesToAsk(HAIRCUT, SAT_3PM);
      expect(
        questions.map((question) => [question.tieId, question.first.priceCents, question.second.priceCents]),
      ).toEqual([["tie-lees-haircut-home-evening", 7500, 4500]]);
    },
  );

  it(
    "event hours with Andre take his $140; with Avery, the service's $120 (worker beats none)",
    SLOW,
    async () => {
      const priced = resolver();
      const event = (workerResourceId: string): Visit => ({
        serviceId: "svc-lees-event-hours",
        startsAt: SAT_3PM,
        wayId: "way-lees-event-hours-home",
        workerResourceId,
        zone: ZONE,
      });
      expect(await priced.priceFor(event("res-andre"))).toMatchObject({
        ruleId: "price-lees-event-hours-andre",
        priceCents: 14000,
        conditionCount: 1,
      });
      expect(await priced.priceFor(event("res-avery"))).toMatchObject({
        ruleId: "price-lees-event-hours",
        priceCents: 12000,
        conditionCount: 0,
      });
    },
  );
});
