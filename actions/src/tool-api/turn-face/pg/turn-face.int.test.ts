// T-315's integration proof, round 4 (DL-346 ruling 3; ADR-013 section 6's T-315 lines): the turn face's buildFrontier
// for turn 1, Sam's first text (K-09 v1.5 build-frontier-s1-01.json), on local PostgreSQL (`npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/turn-face`), through the Tool API base, its scope one read-only
// transaction at repeatable read on a client that runs as rosie_job, set to the call's business before the frontier reads
// (pg/frontier.ts), and its read T-219's readTurnState. The schema is fresh, migrated with every migration, seeded with
// the fixture's given business heads and then T-1148's seed for D-017 (db/seeds/skeleton.ts, run as it is), and dropped
// when the file ends (test-support.ts).
//
// Real here: the Tool API base with K-09's checks, the frontier (T-291, T-295) with main's registry, the scope and repo
// on PostgreSQL, T-219's readTurnState with row-level security and the application roles, and T-1148's seed. Given, as
// the frontier takes them (DL-319 ruling 3): bundle v0 (K-01 v1's bundle-v0-skeleton.json, which the fixture's turn
// pins). Watched, never changed: the reads the frontier makes through the scope (each passed on to the real repo as it
// is and written down with its answer), and the statements the rosie_job client sends (their text, never a value).
//
// The card's proofs: Sam's first text at Lee's Barbershop is read once, under Lee's Barbershop's scope, and gives the
// fixture's frontier as far as main's sources give it (../test-support.ts asFarAsMain): on main none, since the sign-up
// door waits for T-1147, so the call fails closed with FrontierError noChoices, its span failed and its transaction
// rolled back, as in the unit proof; the same call under another business's scope (Sam's text sent to the yoga studio)
// sees nothing of Lee's Barbershop.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BusinessScopeError, type Sql } from "../../../../../db/repo/scope";
import { SKELETON_ROWS, type SkeletonSeedResult } from "../../../../../db/seeds/skeleton";
import type { Span } from "../../../../../runtime/src/trace";
import { RUNTIME_ROLE, snapshot, writesIn, type CommitDatabase } from "../../../commit/pg/test-support";
import { FrontierError, type FrontierRepo } from "../../../frontier";
import { frameFacts } from "../../../frontier/assemble/frame";
import {
  captureLog,
  checks,
  fakeBundles,
  k05Problems,
  sampleBundle,
  type LogCapture,
} from "../../../frontier/assemble/test-support";
import type { Context, ReadTurnStateRequest, TurnState } from "../../../frontier/assemble/types";
import type { BusinessScope } from "../../scope";
import { traceFor } from "../../test-support";
import { asFarAsMain, s101Exchange, type AsFarAsMain } from "../test-support";
import { createTurnFace, type BuildFrontierCallAnswer } from "../turn-face";
import { pgFrontierScope, pgTurnFace } from "./frontier";
import { BARBERSHOP, openTurnFaceDatabase, SAM, SAM_HANDLE, YOGA } from "./test-support";

const SLOW = { timeout: 60_000 };
/** Connections per application client. */
const POOL = 4;
/** The yoga studio as the fixture's given seed holds it (K-04 seed-business-head.json): another business of Sam's text. */
const YOGA_TARGET = { businessId: YOGA, businessName: "Yoga studio", bookingId: null, visitAt: null };

const { validator, checker } = checks();

let cdb: CommitDatabase;
let seeded: SkeletonSeedResult;

beforeAll(async () => {
  ({ cdb, seeded } = await openTurnFaceDatabase(POOL));
}, 120_000);

afterAll(async () => {
  await cdb.close();
});

/** One read the frontier made through the scope: the business the call's transaction was scoped to, and the read. */
interface Read {
  scope: string;
  call: "readTurnState" | "readVisitTimes";
  request: unknown;
  answer: unknown;
}

/** pgFrontierScope on `runtime`, each read the frontier makes through its repo passed on as it is and written down. */
function watchedScope(runtime: Sql, reads: Read[]): BusinessScope<FrontierRepo> {
  const scope = pgFrontierScope(runtime);
  return {
    withBusiness: (businessId, work) =>
      scope.withBusiness(businessId, (repo) =>
        work({
          async readTurnState(request) {
            const answer = await repo.readTurnState(request);
            reads.push({
              scope: businessId,
              call: "readTurnState",
              request: structuredClone(request),
              answer: structuredClone(answer),
            });
            return answer;
          },
          async readVisitTimes(request) {
            const answer = await repo.readVisitTimes(request);
            reads.push({
              scope: businessId,
              call: "readVisitTimes",
              request: structuredClone(request),
              answer: structuredClone(answer),
            });
            return answer;
          },
        }),
      ),
  };
}

/** How one call ended: its answer, or what it threw. */
interface Ended {
  answer: BuildFrontierCallAnswer | undefined;
  thrown: unknown;
  log: LogCapture;
  spans: Span[];
}

interface Called extends Ended {
  reads: Read[];
  /** The statements the call's rosie_job client sent, as sent: their text only, never a value. */
  statements: string[];
}

const settle = (promise: Promise<BuildFrontierCallAnswer>) =>
  promise.then(
    (answer) => ({ answer, thrown: undefined }),
    (thrown: unknown) => ({ answer: undefined, thrown }),
  );

/** One buildFrontier call through the turn face on PostgreSQL (rosie_job, watched), bundle v0 injected. */
async function callTurnFace(request: unknown): Promise<Called> {
  const reads: Read[] = [];
  const statements: string[] = [];
  const runtime = cdb.client(RUNTIME_ROLE, "rosie-t315-turn-face", 1, (text) => {
    statements.push(text);
  });
  try {
    const log = captureLog();
    const face = createTurnFace<FrontierRepo>({
      scope: watchedScope(runtime, reads),
      bundles: fakeBundles(sampleBundle("bundle-v0-skeleton.json")),
      validator,
      checker,
      log: log.sink,
    });
    const { trace, spans } = traceFor(request);
    const ended = await settle(face.buildFrontier(structuredClone(request), trace));
    return { ...ended, log, spans, reads, statements };
  } finally {
    await runtime.end({ timeout: 5 });
  }
}

/** The call answered as far as main gives the fixture's frontier, or failed closed with noChoices; its one span says so. */
function expectAsFarAsMain(ended: Ended, expected: AsFarAsMain, businessId: string): void {
  expect(ended.spans).toHaveLength(1);
  if (expected.ends === "answer") {
    expect(ended.thrown).toBeUndefined();
    expect(ended.answer).toEqual(expected.answer);
    expect(validator.check("buildFrontier", "response", ended.answer)).toEqual([]);
    expect(checker.check("context", (ended.answer as { context: Context }).context)).toEqual([]);
    expect(ended.spans[0]).toMatchObject({
      hop: "frontier",
      outcome: "ok",
      error_code: null,
      business_id: businessId,
    });
  } else {
    expect(ended.answer).toBeUndefined();
    expect(ended.thrown).toBeInstanceOf(FrontierError);
    expect((ended.thrown as FrontierError).code).toBe("noChoices");
    expect(ended.spans[0]).toMatchObject({
      hop: "frontier",
      outcome: "failed",
      error_code: "FrontierError",
      business_id: businessId,
    });
  }
}

/** The call's one transaction on the rosie_job client: read only, and how it ended, from the statements as sent. */
function transactionOf(statements: readonly string[]): string[] {
  return statements.map((text) => text.trim()).filter((text) => /^(begin|commit|rollback)\b/i.test(text));
}

/** The frontier's own readTurnState request for Sam under `businessId`: the business's name and zone, Sam's name. */
function frontierRead(businessId: string): ReadTurnStateRequest {
  return { handleId: SAM_HANDLE, businessId, bookingIds: [], facts: frameFacts(businessId, [SAM]) };
}

function turnStateOf(answer: unknown): TurnState {
  if (typeof answer !== "object" || answer === null || !("result" in answer)) {
    throw new Error("expected a turn state");
  }
  return answer as TurnState;
}

/** The facts a turn state read, by key: their values and versions. */
function factsOf(answer: unknown): unknown[] {
  return turnStateOf(answer).facts.map((fact) => [fact.key, fact.value, fact.version]);
}

describe("buildFrontier for turn 1 on local PostgreSQL, on T-1148's seed, under the call's business scope", () => {
  it(
    "Sam's first text at Lee's Barbershop: one readTurnState under its scope, and the fixture's frontier as far as main gives it, else fail closed",
    SLOW,
    async () => {
      const exchange = s101Exchange();
      const expected = asFarAsMain(exchange);
      const called = await callTurnFace(exchange.request);

      // One read of the stored state, under Lee's Barbershop's scope, naming that business: T-219's readTurnStateIn reads
      // nothing unless PostgreSQL's scope is the request's business, so its answer was read under that scope.
      expect(called.reads.map((read) => [read.call, read.scope])).toEqual([["readTurnState", BARBERSHOP]]);
      expect(called.reads[0]?.request).toEqual(frontierRead(BARBERSHOP));
      expect(turnStateOf(called.reads[0]?.answer)).toMatchObject({
        handleId: SAM_HANDLE,
        businessId: BARBERSHOP,
      });

      expectAsFarAsMain(called, expected, BARBERSHOP);
      // The call's one transaction: read only, then rolled back when the frontier fails closed (committed with an
      // answer), and nothing written.
      expect(transactionOf(called.statements)).toEqual([
        expect.stringMatching(/^begin\b.*\bread only$/i),
        expected.ends === "answer" ? "commit" : "rollback",
      ]);
      expect(writesIn(called.statements)).toEqual([]);
      expect(called.log.lines.map((line) => line.msg)).toContain("frontier_source_missing");

      // Nothing of the yoga studio, whose business head the same database holds.
      for (const seen of [called.reads, called.answer ?? null, called.spans, called.log.lines]) {
        const text = JSON.stringify(seen);
        for (const other of [YOGA, "Yoga studio"]) expect(text).not.toContain(other);
      }
    },
  );

  it(
    "the same call under Sam's yoga studio's scope sees nothing of Lee's Barbershop: only the yoga studio's own business head",
    SLOW,
    async () => {
      const exchange = s101Exchange();
      const request = structuredClone(exchange.request);
      request.caller.businessId = YOGA;
      const called = await callTurnFace(request);

      // One read, under the yoga studio's scope: its business head, and Sam's handle and name, as K-04 scopes none of them.
      expect(called.reads.map((read) => [read.call, read.scope])).toEqual([["readTurnState", YOGA]]);
      expect(called.reads[0]?.request).toEqual(frontierRead(YOGA));
      expect(factsOf(called.reads[0]?.answer)).toEqual([
        ["biz.name", "Yoga studio", 2],
        ["biz.zone", "America/New_York", 2],
        [`person.name/${SAM}`, "Sam Lee", 1],
      ]);
      // The fixture's frontier about the yoga studio, as far as main gives it (fail closed on main).
      expectAsFarAsMain(called, asFarAsMain(exchange, YOGA_TARGET), YOGA);

      // Nothing of Lee's Barbershop: not in the read, the answer, the span or the log.
      for (const seen of [called.reads, called.answer ?? null, called.spans, called.log.lines]) {
        const text = JSON.stringify(seen);
        for (const other of [BARBERSHOP, "Lee's Barbershop"]) expect(text).not.toContain(other);
      }
    },
  );

  it(
    "the scope binds each read to the call's business: another business is refused before any read, its rows unseen",
    SLOW,
    async () => {
      const scope = pgFrontierScope(cdb.runtime);

      // A read naming another business than the call's scope: refused before anything is read.
      await expect(
        scope.withBusiness(YOGA, (repo) => repo.readTurnState(frontierRead(BARBERSHOP))),
      ).rejects.toBeInstanceOf(BusinessScopeError);
      await expect(
        scope.withBusiness(BARBERSHOP, (repo) => repo.readTurnState(frontierRead(YOGA))),
      ).rejects.toBeInstanceOf(BusinessScopeError);

      // Under each scope the other business's head is missing (row-level security), and its own is read.
      const barbershopUnderYoga = await scope.withBusiness(YOGA, (repo) =>
        repo.readTurnState({ ...frontierRead(YOGA), facts: frameFacts(BARBERSHOP, []) }),
      );
      expect(barbershopUnderYoga).toEqual({ error: "notFound", table: "businesses", rowId: BARBERSHOP });
      expect(k05Problems("readTurnState.errors", barbershopUnderYoga)).toEqual([]);
      const yogaUnderBarbershop = await scope.withBusiness(BARBERSHOP, (repo) =>
        repo.readTurnState({ ...frontierRead(BARBERSHOP), facts: frameFacts(YOGA, []) }),
      );
      expect(yogaUnderBarbershop).toEqual({ error: "notFound", table: "businesses", rowId: YOGA });

      const yoga = await scope.withBusiness(YOGA, (repo) => repo.readTurnState(frontierRead(YOGA)));
      expect(factsOf(yoga).slice(0, 1)).toEqual([["biz.name", "Yoga studio", 2]]);
      const barbershop = await scope.withBusiness(BARBERSHOP, (repo) =>
        repo.readTurnState(frontierRead(BARBERSHOP)),
      );
      expect(factsOf(barbershop).slice(0, 1)).toEqual([["biz.name", "Lee's Barbershop", 3]]);
    },
  );

  it(
    "each read holds to K-05 v1.2's frozen schema: T-1148's first text, with no role, question, booking or phone row; a booking's visit time is not read yet",
    SLOW,
    async () => {
      // T-1148's seed ran as itself on the fixture's given seed: it kept the business head that seed wrote, value for
      // value, and wrote Sam's person, handle and their link.
      expect(seeded).toMatchObject({
        ranAs: RUNTIME_ROLE,
        tables: {
          businesses: { rows: 1, inserted: 0, kept: 1 },
          persons: { rows: 1, inserted: 1, kept: 0 },
          handles: { rows: 1, inserted: 1, kept: 0 },
          person_handles: { rows: 1, inserted: 1, kept: 0 },
        },
      });

      const scope = pgFrontierScope(cdb.runtime);
      const answer = await scope.withBusiness(BARBERSHOP, (repo) =>
        repo.readTurnState(frontierRead(BARBERSHOP)),
      );
      expect(k05Problems("readTurnState.response", answer)).toEqual([]);
      const handle = SKELETON_ROWS.handles.find((row) => row.id === SAM_HANDLE);
      expect(answer).toEqual({
        result: "turnState",
        handleId: SAM_HANDLE,
        handle: { kind: "phone", address: handle?.address },
        businessId: BARBERSHOP,
        readAt: expect.any(String) as unknown,
        persons: [{ personId: SAM, language: null, version: 1 }],
        roles: [],
        phone: null,
        openQuestions: [],
        bookings: [],
        pauses: [],
        consents: [],
        facts: [
          {
            key: "biz.name",
            table: "businesses",
            rowId: BARBERSHOP,
            column: "name",
            value: "Lee's Barbershop",
            version: 3,
          },
          {
            key: "biz.zone",
            table: "businesses",
            rowId: BARBERSHOP,
            column: "time_zone",
            value: "America/New_York",
            version: 3,
          },
          {
            key: `person.name/${SAM}`,
            table: "persons",
            rowId: SAM,
            column: "name",
            value: "Sam Lee",
            version: 1,
          },
        ],
      });

      // K-05 v1.2 open gap 25: no call reads a booking's visit time, so the frontier offers none of its options.
      const visits = await scope.withBusiness(BARBERSHOP, (repo) =>
        repo.readVisitTimes({ bookingIds: ["booking-alex-haircut"] }),
      );
      expect(visits).toEqual({
        result: "visits",
        visits: [{ bookingId: "booking-alex-haircut", visitAt: null }],
      });
    },
  );

  it(
    "one call's reads are one moment's: a change committed while the call runs is not seen inside it",
    SLOW,
    async () => {
      const scope = pgFrontierScope(cdb.runtime);
      const hours = {
        ...frontierRead(BARBERSHOP),
        facts: [{ key: "biz.hours", table: "businesses", rowId: BARBERSHOP, column: "text_hours_start" }],
      } as ReadTurnStateRequest;
      const valueOf = (answer: unknown): unknown[] =>
        turnStateOf(answer).facts.map((fact) => [fact.value, fact.version]);
      try {
        const [before, after] = await scope.withBusiness(BARBERSHOP, async (repo) => {
          const first = await repo.readTurnState(hours);
          await cdb.db.sql`
          update businesses set text_hours_start = '09:00', version = version + 1 where id = ${BARBERSHOP}
        `;
          return [first, await repo.readTurnState(hours)];
        });
        expect(valueOf(before)).toEqual([["08:00", 3]]);
        expect(valueOf(after)).toEqual(valueOf(before));
        // The next call reads the change.
        const next = await scope.withBusiness(BARBERSHOP, (repo) => repo.readTurnState(hours));
        expect(valueOf(next)).toEqual([["09:00", 4]]);
      } finally {
        await cdb.db.sql`
        update businesses set text_hours_start = '08:00', version = version + 1 where id = ${BARBERSHOP}
      `;
      }
    },
  );

  it("a call writes nothing: every core table's rows and versions are as they were", SLOW, async () => {
    const before = await snapshot(cdb);
    const exchange = s101Exchange();
    const called = await callTurnFace(exchange.request);
    expectAsFarAsMain(called, asFarAsMain(exchange), BARBERSHOP);
    expect(await snapshot(cdb)).toEqual(before);
  });

  it("pgTurnFace, the face join 6 binds, gives the same answer on the runtime client", SLOW, async () => {
    const exchange = s101Exchange();
    const log = captureLog();
    const face = pgTurnFace(cdb.runtime, {
      bundles: fakeBundles(sampleBundle("bundle-v0-skeleton.json")),
      validator,
      checker,
      log: log.sink,
    });
    const { trace, spans } = traceFor(exchange.request);
    const ended = await settle(face.buildFrontier(structuredClone(exchange.request), trace));
    expectAsFarAsMain({ ...ended, log, spans }, asFarAsMain(exchange), BARBERSHOP);
  });

  it(
    "as the Tool API's own role (rosie_app) the read is refused by privilege: readTurnState is the runtime side's read",
    SLOW,
    async () => {
      await expect(
        pgFrontierScope(cdb.toolApi).withBusiness(BARBERSHOP, (repo) =>
          repo.readTurnState(frontierRead(BARBERSHOP)),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );
});
