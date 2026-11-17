// T-1429's integration proof: the catalog's read port bound to K-05 v1.18's five reads on PostgreSQL (reads.ts), against
// local PostgreSQL (`npm run db:up`; `npm run test:integration -- actions/src/domain/catalog/pg`). One fresh schema for the
// file, migrated with every migration and dropped when it ends (T-306's openCommitDatabase over db/repo/test-db.ts), with
// the Tool API's client, whose connections run as rosie_app, as the binding's; the tables' owner loads fixture set v1's
// seeds (every accepted v1.18 exchange's world, test-support.ts worldRows).
//   - Under each business's own scope, every port read answers what T-320's in-memory double of the five reads answers
//     over the same seeds (../test-support.ts readsOf), and no row of another business; the service built with the
//     binding takes Dee's skin fade snapshot as over the double, inside the call's own transaction too.
//   - A call with no business, or reads asked for another business, is refused before any statement is sent.
//   - K-05's notFound and transient come through as CatalogReadError carrying K-05's answer; a stored value db/repo
//     cannot carry comes through the binding and the service with db/repo's own words.
//   - Limit 2's OwnerRules over readTermsSources answers the business's K-26 rows in force, as T-300 reads them.
//   - T-1433's widened port: read 1's setup and item 77's names as the database builds them; the reads of a row by id
//     through readTurnState as rosie_job for Sam's handle (a location, a worker, a space of the business; another
//     business's, or none, null); the service's cross-row checks through them; no turn handle, or rosie_app, fails closed.
// Rule 9: every row is a frozen seed of fixture set v1's demo shops; nothing logs.

import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBusinessKinds } from "../../../../../db/repo/catalog-reads";
import { resolvePrimaryUrl } from "../../../../../db/repo/client";
import { withBusiness, type Sql } from "../../../../../db/repo/scope";
import { openCommitDatabase, TOOL_API_ROLE, type CommitDatabase } from "../../../commit/pg/test-support";
import { pgOwnerRules } from "../../../gate/limit-2/pg";
import type { RuleRow } from "../../../rules/evaluator";
import { ruleRowOf } from "../../../rules/evaluator/test-support";
import { CatalogRefusedError, NO_CONDITIONS, createCatalog, type CatalogReads } from "../index";
import type { SnapshotInput } from "../terms";
import { SKIN_FADE_WRITTEN, Store, ZONE, readsOf } from "../test-support";
import { CatalogReadError, pgCatalogReads, type CatalogTurn } from "./index";
import {
  BARBERSHOP,
  HOME_SERVICES,
  MOVERS,
  ROW_BY_ID_SEEDS,
  SAM_HANDLE,
  YOGA,
  catalogExchange,
  loadWorld,
  ordered,
  rowsOf,
  thrownBy,
  valuesNamed,
  worldRows,
} from "./test-support";

const SLOW = { timeout: 120_000 };
const BUSINESSES = [BARBERSHOP, HOME_SERVICES, YOGA, MOVERS];
const FLOWS = ["A", "B"] as const;
/** When Sam confirmed the money card, the day after the raise was set, and a day after the tie was asked (K-25). */
const PRICE_TIMES = ["2026-10-19T18:11:00Z", "2026-10-27T14:00:00Z", "2026-11-04T14:00:00Z"];
/** Dee's skin fade written (K-30), and a week later, after the no-show count came into force (K-26). */
const TERMS_TIMES = [SKIN_FADE_WRITTEN, "2026-10-29T14:00:00Z"];
const NO_BUSINESS_ROW = "read-business-kinds-no-business-row.json";

let cdb: CommitDatabase;
/** rosie_app, this file's schema first, recording every statement it sends (the text, never the values). */
let recorder: Sql;
const sent: string[] = [];

beforeAll(async () => {
  cdb = await openCommitDatabase("catalog_pg", 4);
  recorder = cdb.client(TOOL_API_ROLE, "rosie-t1429-app", 2, (text) => {
    sent.push(text);
  });
  await loadWorld(cdb.db.sql, cdb.db.schema, worldRows());
}, 120_000);

afterAll(async () => {
  await recorder.end({ timeout: 5 });
  await cdb.close();
});

/** T-320's in-memory double of the five reads over the same world. */
const double = (): CatalogReads => readsOf(new Store(worldRows()));

/** Every row an answer holds (each element of its lists, and a flow default). */
function rowsIn(answer: unknown): { readonly businessId?: unknown }[] {
  if (Array.isArray(answer)) return answer.flatMap((item) => rowsIn(item));
  if (typeof answer !== "object" || answer === null) return [];
  const record = answer as Record<string, unknown>;
  const own = "businessId" in record ? [record] : [];
  return [...own, ...Object.values(record).flatMap((item) => rowsIn(item))];
}

/** The service's ids of a business, as the double reads them, and one service of another business. */
async function servicesAsked(businessId: string): Promise<string[]> {
  const own = (await double().servicesOf(businessId)).map((service) => service.id);
  const other = businessId === BARBERSHOP ? "svc-lee-electric-wiring-repair" : "svc-lees-haircut";
  return [...own, other];
}

describe("under each business's scope the bound reads answer the seeds as T-320's double reads them, and nothing of another business", () => {
  for (const businessId of BUSINESSES) {
    it(
      `${businessId}: kinds, services, each service's ways and prices, and the terms sources in each flow`,
      SLOW,
      async () => {
        const bound = pgCatalogReads(cdb.toolApi, businessId);
        const reference = double();
        const answers: unknown[] = [];
        const same = async (read: (reads: CatalogReads) => Promise<unknown>): Promise<void> => {
          const answer = await read(bound);
          expect(ordered(answer)).toEqual(ordered(await read(reference)));
          answers.push(answer);
        };

        await same((reads) => reads.kindsOf(businessId));
        await same((reads) => reads.servicesOf(businessId));
        for (const serviceId of await servicesAsked(businessId)) {
          await same((reads) => reads.waysOf(businessId, serviceId));
          for (const at of PRICE_TIMES) await same((reads) => reads.priceRulesOf(businessId, serviceId, at));
        }
        for (const at of TERMS_TIMES) {
          for (const flow of FLOWS) await same((reads) => reads.termsSourcesOf(businessId, flow, at));
        }

        const rows = rowsIn(answers);
        for (const row of rows) expect(row.businessId, businessId).toBe(businessId);
        // The widened port (T-1433 (h)): item 77's names, as the database builds them, for every kind, kind_flows row and
        // flow default answered (each held to the double's reading above), and read 1's setup, null with no setup row.
        for (const rowId of valuesNamed(answers, "rowId")) expect(rowId).toMatch(/^.+\/.+$/);
        const [setup] = valuesNamed(answers, "setup");
        if (businessId === BARBERSHOP) {
          expect(setup).toEqual({ businessId, noMoney: false, version: 4 });
          expect(valuesNamed(answers, "rowId")).toContain("company-lees-barbershop/barber");
        } else expect(setup).toBeNull();
        if (businessId === YOGA) expect(rows).toEqual([]);
        if (businessId === BARBERSHOP) expect(rows.length).toBeGreaterThan(0);
      },
    );
  }

  it(
    "another business's service named under the barbershop's scope answers no way, rule or tie, never notFound (default 153)",
    SLOW,
    async () => {
      const bound = pgCatalogReads(cdb.toolApi, BARBERSHOP);
      expect(await bound.waysOf(BARBERSHOP, "svc-lee-electric-wiring-repair")).toEqual([]);
      expect(await bound.priceRulesOf(BARBERSHOP, "svc-movers-vault-visit", PRICE_TIMES[0] ?? "")).toEqual({
        rules: [],
        ties: [],
      });
    },
  );

  it(
    "the movers' evening price comes back with its clock time as HH:MM, and the haircut's tie with its two rules",
    SLOW,
    async () => {
      const movers = await pgCatalogReads(cdb.toolApi, MOVERS).priceRulesOf(
        MOVERS,
        "svc-movers-vault-visit",
        "2026-10-27T14:00:00Z",
      );
      expect(movers.rules.map((rule) => rule.conditions.fromTime)).toContain("17:00");
      const haircut = await pgCatalogReads(cdb.toolApi, BARBERSHOP).priceRulesOf(
        BARBERSHOP,
        "svc-lees-haircut",
        "2026-11-04T14:00:00Z",
      );
      const tie = catalogExchange("read-price-rules-haircut-tie.json").outcome as {
        rules: { id: string }[];
        ties: unknown[];
      };
      expect(haircut.rules.map((rule) => rule.id)).toEqual(tie.rules.map((rule) => rule.id));
      expect(haircut.ties).toEqual(tie.ties);
    },
  );
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

  const catalogOver = (reads: CatalogReads, businessId = BARBERSHOP) =>
    createCatalog({
      call: "gateAndCommit",
      businessId,
      currency: "USD",
      now: SKIN_FADE_WRITTEN,
      turnKey: "turn-dee-0013",
      reads,
    });

  it(
    "Dee's skin fade snapshot over PostgreSQL equals the one over T-320's double, and the reads answer the same",
    SLOW,
    async () => {
      const catalog = catalogOver(pgCatalogReads(cdb.toolApi, BARBERSHOP));
      const reference = catalogOver(double());
      expect(ordered(await catalog.kinds())).toEqual(ordered(await reference.kinds()));
      expect(await catalog.services()).toEqual(await reference.services());
      expect(ordered(await catalog.ways("svc-lees-haircut"))).toEqual(
        ordered(await reference.ways("svc-lees-haircut")),
      );
      expect(await catalog.priceRules("svc-lees-haircut", SKIN_FADE_WRITTEN)).toEqual(
        await reference.priceRules("svc-lees-haircut", SKIN_FADE_WRITTEN),
      );
      const snapshot = await catalog.takeTermsSnapshot(skinFade);
      expect(snapshot).toEqual(await reference.takeTermsSnapshot(skinFade));
      expect(snapshot.cutoff.from).toBe("way");
    },
  );

  it(
    "inside the call's own transaction (withBusiness, read committed), each read runs in a transaction of its own beside it",
    SLOW,
    async () => {
      const reference = await catalogOver(double()).takeTermsSnapshot(skinFade);
      const snapshot = await withBusiness(cdb.toolApi, BARBERSHOP, () =>
        catalogOver(pgCatalogReads(cdb.toolApi, BARBERSHOP)).takeTermsSnapshot(skinFade),
      );
      expect(snapshot).toEqual(reference);
    },
  );
});

describe("a call with no business, or reads asked for another business, is refused before any statement", () => {
  it("no binding is made with no business or an empty one, and no service either", SLOW, () => {
    sent.length = 0;
    for (const none of [null, undefined, ""]) {
      const businessId = none as unknown as string;
      expect(() => pgCatalogReads(recorder, businessId)).toThrow(TypeError);
      expect(() =>
        createCatalog({
          call: "saveSetupStep",
          businessId,
          currency: "USD",
          now: SKIN_FADE_WRITTEN,
          turnKey: "turn-sam-0002",
          reads: pgCatalogReads(recorder, BARBERSHOP),
        }),
      ).toThrow(CatalogRefusedError);
    }
    expect(sent).toEqual([]);
  });

  it(
    "a service of the yoga studio over the barbershop's reads is refused at its first read (otherBusiness), nothing sent",
    SLOW,
    async () => {
      sent.length = 0;
      const catalog = createCatalog({
        call: "saveSetupStep",
        businessId: YOGA,
        currency: "USD",
        now: SKIN_FADE_WRITTEN,
        turnKey: "turn-sam-0002",
        reads: pgCatalogReads(recorder, BARBERSHOP),
      });
      for (const ask of [
        () => catalog.kinds(),
        () => catalog.services(),
        () => catalog.ways("svc-lees-haircut"),
      ]) {
        const error = await thrownBy(ask());
        expect(error).toBeInstanceOf(CatalogReadError);
        expect(error).toMatchObject({ code: "otherBusiness", answer: null });
      }
      expect(sent).toEqual([]);
    },
  );
});

describe("limit 2's OwnerRules over readTermsSources on PostgreSQL", () => {
  /** The world's K-26 rules rows of a business in force at `at`, as T-300 reads them. */
  const seeded = (businessId: string, at: string): RuleRow[] => {
    const atMs = Date.parse(at);
    return worldRows()
      .filter((row) => row.table === "rules" && row.values.business_id === businessId)
      .map((row) => ruleRowOf(row.values))
      .filter(
        (rule) =>
          Date.parse(rule.effectiveFrom) <= atMs &&
          (rule.effectiveTo === null || atMs < Date.parse(rule.effectiveTo)),
      );
  };

  it("each business's rules in force, as RuleRow, and none of another business's", SLOW, async () => {
    const rules = pgOwnerRules(cdb.toolApi);
    for (const businessId of BUSINESSES) {
      for (const at of TERMS_TIMES) {
        const rows = await rules.rulesOf(businessId, at);
        expect(ordered(rows), `${businessId} at ${at}`).toEqual(ordered(seeded(businessId, at)));
        for (const row of rows) expect(row.businessId).toBe(businessId);
      }
    }
    expect((await rules.rulesOf(BARBERSHOP, TERMS_TIMES[1] ?? "")).length).toBeGreaterThan(0);
  });
});

describe("K-05's transient answer and db/repo's own throw come through unchanged", () => {
  it(
    "a client that cannot reach the database: transient, thrown as CatalogReadError carrying K-05's answer",
    SLOW,
    async () => {
      const closed = createServer();
      closed.listen(0, "127.0.0.1");
      await once(closed, "listening");
      const { port } = closed.address() as AddressInfo;
      closed.close();
      await once(closed, "close");
      const url = new URL(resolvePrimaryUrl());
      url.hostname = "127.0.0.1";
      url.port = String(port);
      const unreachable = postgres(url.href, { max: 1, connect_timeout: 2, onnotice: () => undefined });
      try {
        const error = await thrownBy(pgCatalogReads(unreachable, BARBERSHOP).kindsOf(BARBERSHOP));
        expect(error).toBeInstanceOf(CatalogReadError);
        expect(error).toMatchObject({
          read: "readBusinessKinds",
          code: "transient",
          answer: { error: "transient", sqlstate: "08001" },
        });
      } finally {
        await unreachable.end({ timeout: 1 });
      }
    },
  );

  it(
    "an empty trade name, which the answer cannot carry: db/repo's error, its words unchanged, through the binding and the service",
    SLOW,
    async () => {
      const owner = cdb.db.sql;
      await owner`
      update company_kinds set trade_name = '', version = version + 1 where business_id = ${BARBERSHOP}
    `;
      try {
        const direct = await thrownBy(readBusinessKinds(cdb.toolApi, { businessId: BARBERSHOP }));
        const bound = await thrownBy(pgCatalogReads(cdb.toolApi, BARBERSHOP).kindsOf(BARBERSHOP));
        const service = await thrownBy(
          createCatalog({
            call: "saveSetupStep",
            businessId: BARBERSHOP,
            currency: "USD",
            now: SKIN_FADE_WRITTEN,
            turnKey: "turn-sam-0002",
            reads: pgCatalogReads(cdb.toolApi, BARBERSHOP),
          }).kinds(),
        );
        expect(direct).toBeInstanceOf(Error);
        expect(direct).not.toBeInstanceOf(CatalogReadError);
        for (const error of [bound, service]) {
          expect(error).not.toBeInstanceOf(CatalogReadError);
          expect(error).toMatchObject({ name: (direct as Error).name, message: (direct as Error).message });
        }
      } finally {
        await owner`
        update company_kinds set trade_name = null, version = version + 1 where business_id = ${BARBERSHOP}
      `;
      }
    },
  );
});

describe("the reads of a row by id: readTurnState's facts as rosie_job for the turn's handle, under the call's business (T-1433)", () => {
  const rows = worldRows(ROW_BY_ID_SEEDS);
  /** Sam's turn: the runtime side's client (rosie_job) and his handle. */
  const turn = (): CatalogTurn => ({ runtime: cdb.runtime, handleId: SAM_HANDLE });
  const bound = (businessId: string): CatalogReads => pgCatalogReads(cdb.toolApi, businessId, turn());
  const reference = (): CatalogReads => readsOf(new Store(rows));
  /** Now, for the service's saves: Sam's raise day, a week after the money card (K-25). */
  const NOW = "2026-10-26T14:00:00Z";
  const catalogOf = (businessId: string, reads: CatalogReads) =>
    createCatalog({
      call: "saveSetupStep",
      businessId,
      currency: "USD",
      now: NOW,
      turnKey: "turn-sam-0400",
      reads,
    });

  beforeAll(async () => {
    await loadWorld(cdb.db.sql, cdb.db.schema, rows);
  }, 120_000);

  it(
    "a location, a worker and a space of the business answer as the double reads them; another business's, or none, null",
    SLOW,
    async () => {
      const asks: [string, (reads: CatalogReads) => Promise<unknown>][] = [
        [BARBERSHOP, (reads) => reads.locationOf(BARBERSHOP, "loc-lees-barbershop-second-shop")],
        [BARBERSHOP, (reads) => reads.locationOf(BARBERSHOP, "loc-lees-barbershop-shop")],
        [BARBERSHOP, (reads) => reads.locationOf(BARBERSHOP, "loc-lee-home-services-office")],
        [HOME_SERVICES, (reads) => reads.locationOf(HOME_SERVICES, "loc-lee-home-services-office")],
        [BARBERSHOP, (reads) => reads.resourceOf(BARBERSHOP, "res-andre")],
        [BARBERSHOP, (reads) => reads.resourceOf(BARBERSHOP, "res-maya")],
        [YOGA, (reads) => reads.resourceOf(YOGA, "res-studio-room")],
        ["biz-pet-boarding", (reads) => reads.placeOrThingOf("biz-pet-boarding", "place-pet-boarding-suite")],
        [BARBERSHOP, (reads) => reads.placeOrThingOf(BARBERSHOP, "place-pet-boarding-suite")],
      ];
      for (const [businessId, ask] of asks) {
        expect(await ask(bound(businessId))).toEqual(await ask(reference()));
      }
      expect(await bound(BARBERSHOP).locationOf(BARBERSHOP, "loc-lees-barbershop-second-shop")).toEqual({
        id: "loc-lees-barbershop-second-shop",
        businessId: BARBERSHOP,
        kind: "shop",
        travelMiles: 25,
        version: 1,
      });
      expect(await bound(BARBERSHOP).resourceOf(BARBERSHOP, "res-maya")).toBeNull();
      expect(await bound(BARBERSHOP).placeOrThingOf(BARBERSHOP, "place-pet-boarding-suite")).toBeNull();
    },
  );

  it(
    "the service's checks through the binding: another business's location, worker or space is refused, its own passes",
    SLOW,
    async () => {
      const way = {
        serviceId: "svc-lees-kids-cut",
        place: "business" as const,
        locationId: "loc-lees-barbershop-second-shop",
        path: "list|card|counter",
        depositCents: null,
        depositPercent: null,
        feeCents: 2000,
        cutoffBeforeMinutes: null,
        cutoffDayBeforeAt: null,
        tipLine: null,
      };
      const catalog = catalogOf(BARBERSHOP, bound(BARBERSHOP));
      await expect(
        catalog.addWay({ ...way, locationId: "loc-lee-home-services-office" }),
      ).rejects.toMatchObject({ reason: "locationNotOnBusiness" });
      const byPerson = {
        serviceId: "svc-lees-event-hours",
        conditions: { ...NO_CONDITIONS, workerResourceId: "res-maya" },
        priceCents: 13_000,
        fromCents: null,
        setByPersonId: "person-sam",
      };
      await expect(catalog.addPrice(byPerson)).rejects.toMatchObject({ reason: "workerNotOnBusiness" });
      await expect(
        catalog.linkSpace({
          placeOrThing: { id: "place-pet-boarding-suite", businessId: BARBERSHOP },
          serviceId: "svc-lees-haircut",
        }),
      ).rejects.toMatchObject({ reason: "spaceNotOnBusiness" });
      expect(catalog.written()).toEqual({ versionsRead: [], state: [] });

      const added = await catalog.addWay(way);
      // The way rests on its kind's rows by the names the database built (item 77) and the setup, at their versions.
      expect(added.writes.versionsRead).toEqual([
        { table: "services", rowId: "svc-lees-kids-cut", version: 1 },
        { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 1 },
        { table: "kind_flows", rowId: "barber/A", version: 1 },
        { table: "business_setup", rowId: BARBERSHOP, version: 4 },
      ]);
      const avery = await catalog.addPrice({
        ...byPerson,
        conditions: { ...NO_CONDITIONS, workerResourceId: "res-avery" },
      });
      expect(avery.openedRuleId).not.toBeNull();
      const inn = catalogOf("biz-pet-boarding", bound("biz-pet-boarding"));
      const linked = await inn.linkSpace({
        placeOrThing: { id: "place-pet-boarding-standard-run", businessId: "biz-pet-boarding" },
        serviceId: "svc-boarding-suite-stay",
      });
      expect(linked.writes.state).toHaveLength(1);
    },
  );

  it(
    "a call with no turn handle reads no row by id: the way at its location fails closed (noTurn), nothing written",
    SLOW,
    async () => {
      const catalog = catalogOf(BARBERSHOP, pgCatalogReads(cdb.toolApi, BARBERSHOP));
      const error = await thrownBy(
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
      );
      expect(error).toBeInstanceOf(CatalogReadError);
      expect(error).toMatchObject({ read: "readTurnState", code: "noTurn" });
      expect(catalog.written()).toEqual({ versionsRead: [], state: [] });
    },
  );

  it(
    "as the Tool API's own role (rosie_app) readTurnState is refused by privilege, never answered: it is the runtime side's read",
    SLOW,
    async () => {
      const error = await thrownBy(
        pgCatalogReads(cdb.toolApi, BARBERSHOP, { runtime: cdb.toolApi, handleId: SAM_HANDLE }).locationOf(
          BARBERSHOP,
          "loc-lees-barbershop-shop",
        ),
      );
      // db/repo's scrubbed refusal passes through as thrown: its call and SQLSTATE alone (42501), never a value.
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CatalogReadError);
      expect(error).toMatchObject({ call: "readTurnState", code: "42501" });
    },
  );
});

describe(`notFound (${NO_BUSINESS_ROW}): the business read before its row is written`, () => {
  beforeAll(async () => {
    await loadWorld(cdb.db.sql, cdb.db.schema, rowsOf(NO_BUSINESS_ROW));
  }, 120_000);

  it(
    "every port read throws CatalogReadError carrying the exchange's notFound, as K-05 answers it",
    SLOW,
    async () => {
      const { outcome, request } = catalogExchange(NO_BUSINESS_ROW);
      const businessId = request.businessId as string;
      const bound = pgCatalogReads(cdb.toolApi, businessId);
      const reads: [string, () => Promise<unknown>][] = [
        ["readBusinessKinds", () => bound.kindsOf(businessId)],
        ["readBusinessServices", () => bound.servicesOf(businessId)],
        ["readServiceWays", () => bound.waysOf(businessId, "svc-lee-electric-wiring-repair")],
        [
          "readServicePriceRules",
          () => bound.priceRulesOf(businessId, "svc-lee-electric-wiring-repair", SKIN_FADE_WRITTEN),
        ],
        ["readTermsSources", () => bound.termsSourcesOf(businessId, "B", SKIN_FADE_WRITTEN)],
      ];
      for (const [read, ask] of reads) {
        const error = await thrownBy(ask());
        expect(error, read).toBeInstanceOf(CatalogReadError);
        expect(error).toMatchObject({ read, code: "notFound", answer: outcome });
      }
    },
  );
});
