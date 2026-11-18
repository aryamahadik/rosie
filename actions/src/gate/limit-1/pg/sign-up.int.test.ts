// T-1459: default 14's facts read for real on local PostgreSQL (`npm run db:up`, then `npm run test:integration --
// actions/src/gate/limit-1`; DL-961). The schema comes from migrating a fresh test schema (the commit path's
// pg/test-support.ts openCommitDatabase), dropped when the file ends.
//
// Real here: the shipped limit 1 (index.ts limit1: T-308's service, S13-45's one rule over K-04's links, and default 14's
// facts through signUpFactsOver, all on the call's transaction, with no proof codes and no step cards), and PostgreSQL
// with every migration and the application roles. Default 14's read is K-05 v1.2's readTurnState (db/repo/setup/
// turn-state.ts readTurnStateIn) of the turn's handle at the call's business with business_setup.control_proven_at. It
// reads handles, persons, phones and, for when a question went out, outbox_parts, which rosie_job alone may read (0012),
// so the limit runs as rosie_job under the test business's scope, as limit 4's reload test runs (limit-4/pg). As rosie_app
// under the same scope (the Tool API's own side) that read is refused at its first table (42501): the transaction is then
// aborted, postgres.js fails it with that refusal (its transaction keeps a statement's first error, caught or not), and
// the part goes with the whole call, never passed.
//
// Rows (rule 9): K-04's seed bundle, and the roster-owner seed's shape for its first place (db/seeds/roster-owner.ts): the
// test business biz-roster-owner-1 (K-04 seed-business-head.json's barbershop, value for value, but its id), its one
// person with no name and no language, linked to one handle at a 555-01xx number, and no role anywhere. Beside them, made
// here: the business's K-23 business_setup row, control not proven (the card's integration shape; the roster-owner set
// itself writes none), and what turn 1 left for that handle (ADR-013 section 4): its turn, S1-02's open question to that
// person, and its outbox row with one delivered part. Nothing here logs.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBusiness, type Sql, type Tx } from "../../../../../db/repo/scope";
import { insertRow, openCommitDatabase, seed, type CommitDatabase } from "../../../commit/pg/test-support";
import type { GateRequest } from "../../framework";
import { askedDeciderOutcome, limit1, signUpFactsOver, type AllowedDecision } from "../index";
import { SECOND_TURN_FIXTURE, decidedIn, exchangeRequest, partOf, turnOf } from "../test-support";

const SLOW = { timeout: 60_000 };
/** Connections per client. */
const POOL = 2;

/** The roster-owner seed's ids for its first place (db/seeds/roster-owner.ts rosterOwnerIds). */
const BUSINESS = "biz-roster-owner-1";
const PERSON = "person-roster-owner-1";
const HANDLE = "handle-roster-owner-1";
/** A number in the fiction range (555-0100 to 555-0199), never a roster phone's. */
const NUMBER = "+15555550184";
/** Turn 1's rows for that handle, under ids made as K-09 v1.5 default 131 makes them. */
const TURN_1 = "turn-s1-01-roster-owner-1";
const S1_02 = "oq-s1-02-roster-owner-1";
const OUTBOX = "outbox-s1-02-roster-owner-1";
/** When S1-02's question went out to the handle: its one part, sent and then delivered. */
const SENT_AT = "2026-10-19T18:05:07Z";

const CONTRACTS = new URL("../../../../../contracts/", import.meta.url);

type Values = Record<string, unknown>;

/** K-04 seed-business-head.json's barbershop row's values. */
function barbershopHead(): Values {
  const file = JSON.parse(
    readFileSync(new URL("db-schema/core/fixtures/seed-business-head.json", CONTRACTS), "utf8"),
  ) as { rows: { table: string; values: Values }[] };
  const row = file.rows.find(
    (each) => each.table === "businesses" && each.values.id === "biz-lees-barbershop",
  );
  if (row === undefined) throw new Error("seed-business-head.json holds no barbershop");
  return row.values;
}

/** K-04 seed-bundle-registry.json's bundle: the one the open question and the turns were made under. */
const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };

let cdb: CommitDatabase;
/** The jsonb and bytea columns of this file's schema, by `table.column`. */
let typed: Map<string, string>;

beforeAll(async () => {
  cdb = await openCommitDatabase("limit_1_sign_up", POOL);
  await seed(cdb, ["seed-bundle-registry.json"]);
  const { sql } = cdb.db;
  const columns = await sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${cdb.db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typed = new Map(columns.map((column) => [column.key, column.type]));
  await sql.begin(async (tx) => {
    await insertRow(tx, typed, "businesses", { ...barbershopHead(), id: BUSINESS });
    await insertRow(tx, typed, "persons", { id: PERSON, name: null, language: null });
    await insertRow(tx, typed, "handles", { id: HANDLE, kind: "phone", address: NUMBER });
    await insertRow(tx, typed, "person_handles", { person_id: PERSON, handle_id: HANDLE });
    await insertRow(tx, typed, "business_setup", { business_id: BUSINESS });
    await insertRow(tx, typed, "turns", {
      id: TURN_1,
      handle_id: HANDLE,
      event_ids: ["evt-roster-owner-1-join"],
      state: "committed",
      bundle_hash: BUNDLE.hash,
      bundle_build: BUNDLE.build,
      trace_id: "trace-roster-owner-1-0000",
      committed_at: "2026-10-19T18:05:05Z",
    });
    await insertRow(tx, typed, "open_questions", {
      id: S1_02,
      turn_id: TURN_1,
      handle_id: HANDLE,
      person_id: PERSON,
      business_id: BUSINESS,
      booking_id: null,
      step: "S1-02",
      options: [],
      readback: null,
      versions_read: [],
      bundle_hash: BUNDLE.hash,
      bundle_build: BUNDLE.build,
      clock: null,
      ask_count: 1,
      status: "open",
    });
    await insertRow(tx, typed, "outbox_rows", {
      id: OUTBOX,
      turn_id: TURN_1,
      recipient_handle_id: HANDLE,
      recipient_person_id: PERSON,
      business_id: BUSINESS,
      booking_id: null,
      channel: "imessage",
      send_class: "quick_reply",
      versions_read: [],
      open_question_id: S1_02,
      state: "delivered",
      bundle_hash: BUNDLE.hash,
      bundle_build: BUNDLE.build,
      trace_id: "trace-roster-owner-1-0000",
    });
    await insertRow(tx, typed, "outbox_parts", {
      outbox_row_id: OUTBOX,
      part_no: 1,
      try_no: 1,
      idempotency_key: `${OUTBOX}/1/1`,
      attempts: 1,
      kind: "words",
      linq_message_id: "linq-msg-roster-owner-1-0001",
      state: "delivered",
      sent_at: SENT_AT,
      delivered_at: "2026-10-19T18:05:08Z",
    });
  });
}, 180_000);

afterAll(async () => {
  await cdb.close();
});

/**
 * K-09 v1.5's turn 2 (commit-s1-02.json: "Barbershop, plumbing, electrical", choosing "All on the list") as the roster
 * owner sends it: the test business, its person, on its handle, answering S1-02's question as stored for them.
 */
function secondTurn(): GateRequest {
  const request = exchangeRequest(SECOND_TURN_FIXTURE);
  request.caller.businessId = BUSINESS;
  request.caller.personId = PERSON;
  if (request.turn === null) throw new Error(`${SECOND_TURN_FIXTURE}'s request has no turn`);
  request.turn.handleId = HANDLE;
  const { context, decide } = decidedIn(request);
  for (const choice of context.choices) {
    choice.target.businessId = BUSINESS;
    if (choice.question !== null) choice.question = S1_02;
  }
  for (const each of decide.parts) {
    if (each.part.verb === "choose") each.part.question = S1_02;
  }
  return request;
}

/** The shipped limit 1's decision on turn 2's part, reading through `tx`. */
function decideOn(tx: Tx): Promise<AllowedDecision> {
  const request = secondTurn();
  return limit1.decide(partOf(request), turnOf(request, tx));
}

/** As `client`'s role under the test business's scope, as a Tool API call runs. */
const under = (client: Sql): Promise<AllowedDecision> => withBusiness(client, BUSINESS, decideOn);

/** Nobody to ask: the test business has no owner before S1-75, so S1-02's safe default runs (default 7). */
const NOBODY_ALLOWED: AllowedDecision = {
  result: "fail",
  why: "nobodyDecides",
  outcome: askedDeciderOutcome(),
  next: { kind: "nobodyDecides", why: "nobodyAllowed", step: "S1-02" },
};

describe("T-1459: limit 1 reads a sign-up's own answer from the stored rows, on the call's transaction (default 14)", () => {
  it(
    "as rosie_job under the test business's scope: the three facts read from their rows, and the role-less signer's answer to S1-02's question passes",
    SLOW,
    async () => {
      const facts = await withBusiness(cdb.runtime, BUSINESS, async (tx) => {
        const read = signUpFactsOver(tx, BUSINESS, HANDLE);
        return {
          question: await read.question(S1_02),
          linked: await read.linked(PERSON),
          another: await read.linked("person-roster-owner-2"),
          control: await read.control(),
        };
      });
      expect(facts).toEqual({
        question: {
          openQuestionId: S1_02,
          handleId: HANDLE,
          personId: PERSON,
          businessId: BUSINESS,
          bookingId: null,
          step: "S1-02",
          options: [],
          readback: null,
          versionsRead: [],
          sentAt: SENT_AT,
          pollId: null,
          askCount: 1,
        },
        linked: true,
        another: false,
        control: { provenAt: null },
      });
      expect(await under(cdb.runtime)).toEqual({ result: "pass", why: "decider" });
    },
  );

  it(
    "control proven (with still no role): as today, the business's settings, which nobody there can decide yet",
    SLOW,
    async () => {
      const { sql } = cdb.db;
      await sql`
        update business_setup
        set control_proven_at = '2026-10-19T18:20:00Z', control_proven_via = 'listing_code', version = version + 1
        where business_id = ${BUSINESS}
      `;
      try {
        expect(await under(cdb.runtime)).toEqual(NOBODY_ALLOWED);
      } finally {
        await sql`
          update business_setup set control_proven_at = null, control_proven_via = null, version = version + 1
          where business_id = ${BUSINESS}
        `;
      }
      expect(await under(cdb.runtime)).toEqual({ result: "pass", why: "decider" });
    },
  );

  it("no business_setup row (a fact missing): as today, never a pass", SLOW, async () => {
    const { sql } = cdb.db;
    await sql`delete from business_setup where business_id = ${BUSINESS}`;
    try {
      expect(await under(cdb.runtime)).toEqual(NOBODY_ALLOWED);
    } finally {
      await insertRow(sql, typed, "business_setup", { business_id: BUSINESS });
    }
    expect(await under(cdb.runtime)).toEqual({ result: "pass", why: "decider" });
  });

  it(
    "as rosie_app under the same scope: the read is refused at its first table (42501), and the call's transaction fails with that refusal, so the part goes with the call, never passed",
    SLOW,
    async () => {
      await expect(
        withBusiness(cdb.toolApi, BUSINESS, (tx) => signUpFactsOver(tx, BUSINESS, HANDLE).question(S1_02)),
      ).rejects.toMatchObject({ code: "42501" });
      // Limit 1 answers the part as today once the read is refused, but the transaction is aborted, and postgres.js fails
      // it with the first statement's error, the refusal, even though limit 1 caught it.
      await expect(under(cdb.toolApi)).rejects.toMatchObject({ code: "42501" });
    },
  );
});
