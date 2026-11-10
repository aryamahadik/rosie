// T-315's integration proof (DL-319 ruling 2): the turn face's buildFrontier for S1-02 on local PostgreSQL
// (`npm run db:up`, then `npm run test:integration -- actions/src/tool-api/turn-face`), through the Tool API base, its
// scope one read-only transaction at repeatable read on a client that runs as rosie_job, set to the call's business
// before the frontier reads (pg/frontier.ts), and its reads T-219's readTurnState. The schema is fresh, migrated with
// every migration, and dropped when the file ends (test-support.ts).
//
// Real here: the Tool API base with K-09 v1's checks, the frontier (T-291, T-295) with main's registry, the scope and
// repo on PostgreSQL, T-219's readTurnState with row-level security and the application roles. Given, as the frontier
// takes them (DL-319 ruling 3): bundle v0 (K-01 v1's bundle-v0-skeleton.json), and the stored state of
// test-support.ts. The card's proofs: Sam's answer to S1-02 gives build-frontier-s1-02.json's frontier as far as main's
// sources give it, read under Lee's Barbershop's scope; the same call under another business's scope (Sam's yoga studio)
// sees nothing of Lee's Barbershop.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BusinessScopeError } from "../../../../../db/repo/scope";
import type { Span } from "../../../../../runtime/src/trace";
import { snapshot, type CommitDatabase } from "../../../commit/pg/test-support";
import { frameFacts } from "../../../frontier/assemble/frame";
import {
  captureLog,
  checks,
  fakeBundles,
  k05Problems,
  s102Exchange,
  sampleBundle,
  type FrontierExchange,
  type LogCapture,
} from "../../../frontier/assemble/test-support";
import type { Context, ReadTurnStateRequest, TurnState } from "../../../frontier/assemble/types";
import { traceFor } from "../../test-support";
import { asFarAsMain, SLOTS_NOT_BUILT } from "../test-support";
import type { BuildFrontierCallAnswer } from "../turn-face";
import { pgFrontierScope, pgTurnFace } from "./frontier";
import {
  BARBERSHOP,
  openTurnFaceDatabase,
  SAM_HANDLE,
  YOGA,
  YOGA_QUESTION,
  YOGA_SENT_AT,
} from "./test-support";

type Json = Record<string, unknown>;

const SLOW = { timeout: 60_000 };
/** Connections per application client. */
const POOL = 4;

const { validator, checker } = checks();

let cdb: CommitDatabase;

beforeAll(async () => {
  cdb = await openTurnFaceDatabase(POOL);
}, 120_000);

afterAll(async () => {
  await cdb.close();
});

interface Called {
  answer: BuildFrontierCallAnswer;
  log: LogCapture;
  spans: Span[];
}

/** One buildFrontier call through the turn face on PostgreSQL (rosie_job), bundle v0 injected. */
async function callTurnFace(request: unknown): Promise<Called> {
  const log = captureLog();
  const face = pgTurnFace(cdb.runtime, {
    bundles: fakeBundles(sampleBundle("bundle-v0-skeleton.json")),
    validator,
    checker,
    log: log.sink,
  });
  const { trace, spans } = traceFor(request);
  const answer = await face.buildFrontier(structuredClone(request), trace);
  return { answer, log, spans };
}

/** The frontier's own readTurnState request for Sam under `businessId`: the business's name and zone, Sam's name. */
function frontierRead(businessId: string): ReadTurnStateRequest {
  return { handleId: SAM_HANDLE, businessId, bookingIds: [], facts: frameFacts(businessId, ["person-sam"]) };
}

function turnStateOf(answer: unknown): TurnState {
  if (typeof answer !== "object" || answer === null || !("result" in answer)) {
    throw new Error("expected a turn state");
  }
  return answer as TurnState;
}

describe("buildFrontier for S1-02 on local PostgreSQL, under the call's business scope", () => {
  it(
    "Sam's answer at Lee's Barbershop: the fixture's frontier as far as main's sources give it, read under that scope",
    SLOW,
    async () => {
      const exchange = s102Exchange();
      const called = await callTurnFace(exchange.request);

      expect(called.answer).toEqual(asFarAsMain(exchange));
      expect(validator.check("buildFrontier", "response", called.answer)).toEqual([]);
      expect(checker.check("context", (called.answer as { context: Context }).context)).toEqual([]);
      // Nothing of the yoga studio's own question to the same handle.
      const text = JSON.stringify(called.answer);
      for (const other of [YOGA, YOGA_QUESTION, "Yoga studio"]) expect(text).not.toContain(other);

      expect(called.spans).toHaveLength(1);
      expect(called.spans[0]).toMatchObject({ hop: "frontier", outcome: "ok", business_id: BARBERSHOP });
      expect(called.log.lines.map((line) => [line.msg, line.source])).toEqual(
        SLOTS_NOT_BUILT.map((source) => ["frontier_source_missing", source]),
      );
    },
  );

  it(
    "the same call under Sam's yoga studio's scope sees nothing of Lee's Barbershop: only its own question",
    SLOW,
    async () => {
      const exchange: FrontierExchange = s102Exchange();
      const request = structuredClone(exchange.request);
      request.caller.businessId = YOGA;
      // The guard lists every live question of the handle, at every business (K-05 v1.2 handleTargets).
      request.targets.openQuestionIds = ["oq-s1-02", YOGA_QUESTION];
      const called = await callTurnFace(request);

      // The fixture's frontier, but about the yoga studio's own question: its target, its id and its send time.
      const target = { businessId: YOGA, businessName: "Yoga studio", bookingId: null, visitAt: null };
      const expected = asFarAsMain(exchange) as Json & {
        context: Json & { openQuestions: Json[]; choices: Json[] };
      };
      expected.context.openQuestions = expected.context.openQuestions.map((question) => ({
        ...question,
        openQuestionId: YOGA_QUESTION,
        target,
        sentAt: { utc: YOGA_SENT_AT, zone: "America/New_York" },
      }));
      expected.context.choices = expected.context.choices.map((choice) => ({
        ...choice,
        question: YOGA_QUESTION,
        target,
      }));
      expect(called.answer).toEqual(expected);
      expect(validator.check("buildFrontier", "response", called.answer)).toEqual([]);

      // Lee's Barbershop's question, listed by the guard, is not read under this scope, and is logged by its id alone.
      const text = JSON.stringify(called.answer);
      for (const other of ["oq-s1-02", "Lee's Barbershop"]) expect(text).not.toContain(other);
      expect(called.log.lines).toContainEqual({
        level: "warn",
        msg: "frontier_question_unread",
        trace_id: "trace-sam-0001",
        turn_id: "turn-s1-02-sam-kinds",
        open_question_id: "oq-s1-02",
      });
      expect(called.spans[0]).toMatchObject({ hop: "frontier", outcome: "ok", business_id: YOGA });
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

      // Under the yoga studio's scope, Lee's Barbershop's row is missing, and only the yoga studio's question and role are
      // read.
      const missing = await scope.withBusiness(YOGA, (repo) =>
        repo.readTurnState({ ...frontierRead(YOGA), facts: frameFacts(BARBERSHOP, []) }),
      );
      expect(missing).toEqual({ error: "notFound", table: "businesses", rowId: BARBERSHOP });
      expect(k05Problems("readTurnState.errors", missing)).toEqual([]);
      const yoga = turnStateOf(
        await scope.withBusiness(YOGA, (repo) => repo.readTurnState(frontierRead(YOGA))),
      );
      expect(yoga.openQuestions.map((question) => question.id)).toEqual([YOGA_QUESTION]);
      expect(yoga.roles.map((role) => role.roleId)).toEqual(["role-sam-yoga"]);

      // And under Lee's Barbershop's, the reverse.
      const barbershop = turnStateOf(
        await scope.withBusiness(BARBERSHOP, (repo) => repo.readTurnState(frontierRead(BARBERSHOP))),
      );
      expect(barbershop.openQuestions.map((question) => question.id)).toEqual(["oq-s1-02"]);
      expect(barbershop.roles.map((role) => role.roleId)).toEqual(["role-sam-barber"]);
    },
  );

  it(
    "each read holds to K-05 v1.2's frozen schema; a booking's visit time is not read yet, so none is given",
    SLOW,
    async () => {
      const scope = pgFrontierScope(cdb.runtime);
      const answer = await scope.withBusiness(BARBERSHOP, (repo) =>
        repo.readTurnState(frontierRead(BARBERSHOP)),
      );
      expect(k05Problems("readTurnState.response", answer)).toEqual([]);
      const state = turnStateOf(answer);
      expect(state).toMatchObject({ result: "turnState", handleId: SAM_HANDLE, businessId: BARBERSHOP });
      expect(state.openQuestions).toEqual([
        expect.objectContaining({
          id: "oq-s1-02",
          step: "S1-02",
          sentAt: "2026-10-19T14:02:00Z",
          pollId: null,
        }),
      ]);
      expect(state.facts.map((fact) => [fact.key, fact.value])).toEqual([
        ["biz.name", "Lee's Barbershop"],
        ["biz.zone", "America/New_York"],
        ["person.name/person-sam", "Sam Lee"],
      ]);

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
    const called = await callTurnFace(s102Exchange().request);
    expect(called.answer).toEqual(asFarAsMain());
    expect(await snapshot(cdb)).toEqual(before);
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
