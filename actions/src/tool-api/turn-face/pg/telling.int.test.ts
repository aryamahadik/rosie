// T-1443's integration proof on local PostgreSQL (`npm run db:up`, then `npm run test:integration --
// actions/src/tool-api/turn-face`): a crisis-words turn through the turn face's gate and commit (pgTurnFace with
// pgTurnCalls) with the paging telling port given (commit/core pagingTellingPort) in place of NOT_TOLD_YET. The schema is
// fresh, migrated with every migration, seeded with K-04's seeds (the three businesses, their people and handles, the
// owner's role, the phones' open chats, the registry's row of bundle v0) and dropped when the file ends. Alex's sealing
// key is made as the gateway makes it at the first sight of his number (K-05 v1.2 item 29), under a wrapping key made for
// this run alone.
//
// Real here: the Tool API base with K-09's checks, the gate, the commit, runCore with the safety service and T-319's
// paging service behind the port, every K-05 call (the six safety reads and readOpenHolds on the call's own transaction
// as rosie_app, readBusinessOwner, the read-only sealer and commitTurn each in a runtime transaction of their own as
// rosie_job), row-level security and the two application roles. T-307's and T-317's reads (the record's own line) run on
// the runtime side (rosie_job), as the wiring binds them where rosie_app holds no grant (phones, person_handles). Given:
// bundle v0 (K-01 v1's bundle-v0-skeleton.json) through the frontier's fake bundles, and the runtime's PagingReader
// (T-1444's, not built yet) as T-319's in-memory reader over the same rows this schema holds: Sam the barbershop's owner
// in his open chat, and Rosie's team of two (placeholder people with no name, on handles in the fixtures' range, as
// j3-safety-arrival-crisis-rows.json names them: handle-team-1 and handle-team-2).
//
// The card's three lines:
//   - a crisis-words turn with the port given commits, and writes the owner's alert ('Urgent: a customer may need help')
//     and the team's page rows under the record's business;
//   - on staging, every recipient is a roster test phone or the console;
//   - with NOT_TOLD_YET the old answers are unchanged.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import type { Tx } from "../../../../../db/repo/scope";
import type { WrappingKeys } from "../../../../../db/repo/sealing";
import type { GateAndCommitRequest } from "../../../commit";
import { pagingTellingPort } from "../../../commit/core";
import { openCommitDatabase, seed, snapshot, type CommitDatabase } from "../../../commit/pg/test-support";
import { flagsReaderOf } from "../../../domain/flags";
import { contractJson } from "../../../domain/messages-consent/test-support";
import { messagesReaderOf } from "../../../domain/messages-consent";
import { pagingWorld, readerOn } from "../../../domain/paging/test-support";
import {
  NOT_TOLD_YET,
  PLUGIN_LISTS_NO_STOP_WORDS,
  type SafetyResult,
  type TellingPort,
} from "../../../domain/safety";
import { captureLog, checks, fakeBundles, sampleBundle } from "../../../frontier/assemble/test-support";
import { traceFor } from "../../test-support";
import { NOTHING_OPEN_AT } from "../commit";
import type { GateAndCommitCallAnswer, TurnFace } from "../turn-face";
import { pgTurnCalls, pgTurnFace } from "./index";

type Json = Record<string, unknown>;

const SLOW = { timeout: 60_000 };
const POOL = 4;
const BARBERSHOP = "biz-lees-barbershop";
const ALEX = "person-alex";
const SAM = "person-sam";
/** The moment of the crisis record (j3-safety-arrival-crisis-rows.json's). */
const NOW = "2026-10-23T14:30:03Z";
/** What the owner hears of crisis words, and all they hear (master A3-25; K-36 hand_offs.summary; DL-930). */
const URGENT_LINE = "Urgent: a customer may need help";

/** Rosie's team of two, as the paging world names them: placeholder people with no name, each on a stand-in handle. */
const TEAM = [
  { personId: "person-rosie-team-1", handleId: "handle-team-1", number: "+15555550190" },
  { personId: "person-rosie-team-2", handleId: "handle-team-2", number: "+15555550191" },
] as const;

const { validator, checker } = checks();
const BUNDLE = sampleBundle("bundle-v0-skeleton.json");
const BUNDLE_ID = BUNDLE.manifest.bundleId as { hash: string; build: number };

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

let cdb: CommitDatabase;

beforeAll(async () => {
  cdb = await openCommitDatabase("turn_face_telling", POOL);
  await seed(cdb, ["seed-bundle-registry.json", "seed-phone-chat-open.json"]);
  for (const member of TEAM) {
    await cdb.db.sql`insert into persons (id, name) values (${member.personId}, null)`;
    await cdb.db
      .sql`insert into handles (id, kind, address) values (${member.handleId}, 'phone', ${member.number})`;
    await cdb.db.sql`
      insert into person_handles (person_id, handle_id) values (${member.personId}, ${member.handleId})
    `;
  }
  // Alex's key, made as the gateway makes it at the first sight of his number (K-05 v1.2 item 29).
  const sighted = await handleSealingKey(cdb.runtime, KEYS, {
    handle: { kind: "phone", address: "+15555550101" },
    newHandleId: "handle-t1443-unused",
    newPersonId: "person-t1443-unused",
    wrappingKeyName: "SEALING_WRAP_KEY",
  });
  if (!("result" in sighted.outcome) || sighted.outcome.personId !== ALEX) {
    throw new Error("first sight did not give Alex's key");
  }
}, 120_000);

afterAll(async () => {
  await cdb.close();
});

/** The turn face on this schema, who is told as given. */
function faceTelling(telling: TellingPort<Tx>): TurnFace {
  const bundles = fakeBundles(BUNDLE);
  return pgTurnFace(cdb.runtime, {
    bundles,
    validator,
    checker,
    log: captureLog().sink,
    calls: pgTurnCalls(cdb.runtime, cdb.toolApi, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling,
      now: () => new Date(NOW),
      safetyExtra: {
        flagsReader: () => flagsReaderOf(cdb.runtime),
        messagesReader: () => messagesReaderOf(cdb.runtime),
      },
    }),
  });
}

/** The paging telling port over T-319's reader of the rows this schema holds (the top of this file). */
function portWith(environment: string | null, roster: readonly string[] | null): TellingPort<Tx> {
  return pagingTellingPort<Tx>({ environment, roster, reader: () => readerOn(pagingWorld()) });
}

/** Alex's crisis words (K-02 v1 safety-crisis-words.json) as text `eventId`, recorded in a turn of its own at the barbershop. */
function crisisTurn(turnId: string, eventId: string): GateAndCommitRequest {
  const traceId = `trace-${turnId}`;
  const caller = {
    kind: "turn" as const,
    turnId,
    requestId: turnId,
    businessId: BARBERSHOP,
    personId: ALEX,
    traceId,
  };
  const safety = {
    ...(structuredClone(contractJson("model/fixtures/safety-crisis-words.json")) as SafetyResult),
    eventId,
  };
  return {
    caller,
    turn: {
      id: turnId,
      handleId: "handle-alex",
      eventIds: [eventId],
      bundleId: { ...BUNDLE_ID },
      traceId,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "coreOnly" },
    core: [
      {
        call: "recordSafetyOutcome",
        request: { caller, safety, handleId: "handle-alex", bookingId: null, sentByActor: null },
      },
    ],
    now: NOW,
  };
}

async function commitThrough(
  face: TurnFace,
  request: GateAndCommitRequest,
): Promise<GateAndCommitCallAnswer> {
  return face.gateAndCommit(structuredClone(request), NOTHING_OPEN_AT, traceFor(request).trace);
}

/** What one turn wrote of who is told, as the owner reads it: its hand-off, its page and its rows in commit order. */
async function toldIn(turnId: string) {
  const { sql } = cdb.db;
  const handOffs = await sql<Json[]>`
    select id, business_id, kind, safety_outcome_id, told_person_id, told_as, alert_outbox_row_id, summary,
           escalation_clock_row_id, (escalate_at = handed_at) as at_once, (escalated_at = handed_at) as escalated
    from hand_offs where turn_id = ${turnId}
  `;
  const pages = await sql<Json[]>`
    select id, reason, business_id, hand_off_id, repeat_minutes, next_page_clock_row_id, state
    from team_pages where turn_id = ${turnId}
  `;
  const rows = await sql<
    { id: string; to: string; person: string | null; business_id: string; send_class: string }[]
  >`
    select id, recipient_handle_id as to, recipient_person_id as person, business_id, send_class
    from outbox_rows where turn_id = ${turnId} order by commit_seq
  `;
  const entries = await sql<{ business_id: string | null; summary: string | null }[]>`
    select business_id, new_values ->> 'summary' as summary from event_log
    where turn_id = ${turnId} and kind = 'hand_off.created'
  `;
  return { handOffs, pages, rows, entries };
}

describe("a crisis-words turn with the paging telling port given, on local PostgreSQL (T-1443)", () => {
  it(
    "commits, and writes the owner's alert ('Urgent: a customer may need help') and the team's page rows under the record's business",
    SLOW,
    async () => {
      const turnId = "turn-t1443-crisis-production";
      const answer = await commitThrough(
        faceTelling(portWith("production", null)),
        crisisTurn(turnId, "evt-t1443-1"),
      );
      expect(answer, JSON.stringify(answer)).toMatchObject({ result: "committed", turnId, repeated: false });
      expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
      const [core] = (answer as unknown as { core: Json[] }).core;
      expect(core).toMatchObject({
        call: "recordSafetyOutcome",
        error: null,
        response: {
          outcomes: ["Crisis words"],
          safetyLine: { fixedLineId: "safetyCrisis" },
          told: [
            { who: "owner", via: "handOff" },
            { who: "team", via: "teamPage" },
          ],
        },
      });

      const told = await toldIn(turnId);
      // The hand-off: told to Sam as the barbershop's owner at once, its summary A3-25's line alone, under the barbershop.
      expect(told.handOffs).toHaveLength(1);
      const [handOff] = told.handOffs;
      expect(handOff).toMatchObject({
        business_id: BARBERSHOP,
        kind: "crisis_words",
        told_person_id: SAM,
        told_as: "owner",
        summary: URGENT_LINE,
        escalation_clock_row_id: null,
        at_once: true,
        escalated: true,
      });
      expect(told.entries).toEqual([{ business_id: BARBERSHOP, summary: URGENT_LINE }]);
      // The team's page for it, opened at once under the barbershop, paged once (crisis words alone repeat no page).
      expect(told.pages).toEqual([
        expect.objectContaining({
          reason: "hand_off",
          business_id: BARBERSHOP,
          hand_off_id: handOff?.id,
          repeat_minutes: null,
          state: "open",
        }),
      ]);
      // The rows in commit order: Alex's own crisis line first, then Sam's alert, then one row to each member; every one
      // send class safety under the barbershop, by handle id.
      expect(
        told.rows.map(({ to, person, business_id, send_class }) => ({ to, person, business_id, send_class })),
      ).toEqual([
        { to: "handle-alex", person: ALEX, business_id: BARBERSHOP, send_class: "safety" },
        { to: "handle-sam", person: SAM, business_id: BARBERSHOP, send_class: "safety" },
        { to: "handle-team-1", person: "person-rosie-team-1", business_id: BARBERSHOP, send_class: "safety" },
        { to: "handle-team-2", person: "person-rosie-team-2", business_id: BARBERSHOP, send_class: "safety" },
      ]);
      expect(handOff?.alert_outbox_row_id).toBe(told.rows[1]?.id);
    },
  );

  it(
    "on staging, every alert and page row goes to a roster test phone, and everyone else waits in the console",
    SLOW,
    async () => {
      const roster = ["handle-sam", "handle-team-1"];
      const turnId = "turn-t1443-crisis-staging";
      const answer = await commitThrough(
        faceTelling(portWith("staging", roster)),
        crisisTurn(turnId, "evt-t1443-2"),
      );
      expect(answer, JSON.stringify(answer)).toMatchObject({ result: "committed", turnId });
      const told = await toldIn(turnId);
      expect(told.handOffs).toHaveLength(1);
      expect(told.pages).toHaveLength(1);
      // Alex's own line answers his text; every row of who is told goes to a roster test phone, and member 2 gets none.
      const [line, ...toldRows] = told.rows;
      expect(line?.to).toBe("handle-alex");
      expect(toldRows.map((row) => row.to)).toEqual(["handle-sam", "handle-team-1"]);
      for (const row of toldRows) expect(roster).toContain(row.to);
      for (const row of told.rows)
        expect(row).toMatchObject({ business_id: BARBERSHOP, send_class: "safety" });

      // No roster at all, and an ENVIRONMENT that is not exactly production: nothing but Alex's line is written, and the
      // hand-off (with no alert row) and the page wait in the test console.
      const closedTurn = "turn-t1443-crisis-no-roster";
      const closed = await commitThrough(
        faceTelling(portWith("Production", null)),
        crisisTurn(closedTurn, "evt-t1443-3"),
      );
      expect(closed, JSON.stringify(closed)).toMatchObject({ result: "committed", turnId: closedTurn });
      const waiting = await toldIn(closedTurn);
      expect(waiting.rows.map((row) => row.to)).toEqual(["handle-alex"]);
      expect(waiting.handOffs).toEqual([
        expect.objectContaining({ alert_outbox_row_id: null, summary: URGENT_LINE }),
      ]);
      expect(waiting.pages).toHaveLength(1);
    },
  );

  it("with NOT_TOLD_YET the old answer is unchanged: notBuilt, and nothing is written", SLOW, async () => {
    const before = await snapshot(cdb);
    const answer = await commitThrough(
      faceTelling(NOT_TOLD_YET),
      crisisTurn("turn-t1443-not-told", "evt-t1443-4"),
    );
    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(await snapshot(cdb)).toEqual(before);
    const told = await toldIn("turn-t1443-not-told");
    expect(told).toEqual({ handOffs: [], pages: [], rows: [], entries: [] });
  });
});
