// T-1459: default 14's facts read for real on local PostgreSQL (`npm run db:up`, then `npm run test:integration --
// actions/src/gate/limit-1`; DL-961). The schema comes from migrating a fresh test schema (the commit path's
// pg/test-support.ts openCommitDatabase), dropped when the file ends.
//
// Real here: the shipped limit 1 (index.ts limit1: T-308's service, S13-45's one rule over K-04's links, and default 14's
// facts through signUpFactsOver, all on the call's transaction, with no proof codes and no step cards), and PostgreSQL
// with every migration and the application roles. The limit runs as rosie_job under the test business's scope, as limit
// 4's reload test runs (limit-4/pg), and as rosie_app under the same scope, the Tool API's own side and the gate's on
// staging (ADR-014; DL-950).
//
// T-1463 (the architect's N2 on T-1459; DL-964): T-1459 read default 14's facts through K-05 v1.2's readTurnState
// (db/repo/setup/turn-state.ts readTurnStateIn), whose first statement reads handles, which rosie_job alone may read
// (0012), so as rosie_app the part's call failed with 42501. Now (b) is limit 3's question read (db/repo/targets.ts
// liveOpenQuestionsOfHandle, through 0037 as rosie_app), and (c) and (d) are db/repo/sign-up-reads.ts's one read: the
// business's business_setup row under the call's scope, and the link through 0038's person_handles_linked as rosie_app
// (directly on person_handles as rosie_job). So as rosie_app default 14 reads its three facts and passes the role-less
// signer's answer as their own record (limit 1's rule, changeOf, on the call's transaction), and answers as today for
// every case that fails it. The part as a whole then reaches S13-45's one rule, whose read of the handle's people (T-308's
// sender: db/repo/phones.ts listPersonIdsOfHandle, on person_handles) rosie_app may still not make: that statement is
// refused (42501), the transaction is aborted, postgres.js fails it with that refusal (its transaction keeps a
// statement's first error, caught or not), and the part goes with the whole call, never passed. That read is outside
// this card (its "facts (c) and (d) alone"): the last case below pins where the call now stops.
//
// Rows (rule 9): K-04's seed bundle, and the roster-owner seed's shape for its first place (db/seeds/roster-owner.ts): the
// test business biz-roster-owner-1 (K-04 seed-business-head.json's barbershop, value for value, but its id), its one
// person with no name and no language, linked to one handle at a 555-01xx number, and no role anywhere. Beside them, made
// here: the business's K-23 business_setup row, control not proven (the card's integration shape; the roster-owner set
// itself writes none), and what turn 1 left for that handle (ADR-013 section 4): its turn, S1-02's open question to that
// person, and its outbox row with one delivered part. Made for one case each, and removed after it: a helper with no
// name writing from the same handle, and a second handle of the person's at another 555-01xx number, linked to them
// alone. Nothing here logs.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBusiness, type Sql, type Tx } from "../../../../../db/repo/scope";
import { readTurnStateIn } from "../../../../../db/repo/setup/turn-state";
import {
  TOOL_API_ROLE,
  insertRow,
  openCommitDatabase,
  seed,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { identityReaderOf } from "../../../domain/identity-access";
import type { GateRequest } from "../../framework";
import {
  NO_STEP_CARDS,
  askedDeciderOutcome,
  changeOf,
  identityOver,
  limit1,
  signUpFactsOver,
  type AllowedDecision,
  type Change,
} from "../index";
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
/** Made for one case: a helper with no name and no role, writing from the person's handle (S1-09's "Helps run it"). */
const HELPER = "person-t1463-helper-1";
/** Made for one case: a second handle of the person's, at another fiction-range number, with no question on it. */
const SECOND_HANDLE = "handle-t1463-second-1";
const SECOND_NUMBER = "+15555550186";
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
 * owner sends it: the test business, its person, on its handle, answering S1-02's question as stored for them; or, for
 * one case, as `personId` sends it from `handleId`.
 */
function secondTurn(personId = PERSON, handleId = HANDLE): GateRequest {
  const request = exchangeRequest(SECOND_TURN_FIXTURE);
  request.caller.businessId = BUSINESS;
  request.caller.personId = personId;
  if (request.turn === null) throw new Error(`${SECOND_TURN_FIXTURE}'s request has no turn`);
  request.turn.handleId = handleId;
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

/** Default 14 passes: the part is the sender's own record (3a's own). */
const OWN_RECORD: Change = { kind: "decided", matters: [{ kind: "own" }], inRole: false, twoRoles: false };
/** As today: S1-02's answer is the business's settings (defaults 3a and 13). */
const THE_BUSINESS_SETTINGS: Change = {
  kind: "decided",
  matters: [{ kind: "settings" }],
  inRole: false,
  twoRoles: false,
};

/**
 * What `request`'s part changes by limit 1's own rule (changeOf, where default 14 decides), with the reads the shipped
 * limit makes on `tx` (index.ts createLimit1's defaults: T-308's service, no step cards, signUpFactsOver).
 */
function changeOn(tx: Tx, request: GateRequest = secondTurn()): Promise<Change> {
  const turn = turnOf(request, tx);
  return changeOf(partOf(request), turn, {
    identity: () => identityOver(identityReaderOf(tx), turn.businessId),
    steps: () => NO_STEP_CARDS,
    signUps: (handleId) => signUpFactsOver(tx, turn.businessId, handleId),
  });
}

/** Default 14's three facts of the test handle at the test business, as `client`'s role reads them under its scope. */
function factsUnder(client: Sql): Promise<Record<string, unknown>> {
  return withBusiness(client, BUSINESS, async (tx) => {
    const read = signUpFactsOver(tx, BUSINESS, HANDLE);
    return {
      question: await read.question(S1_02),
      linked: await read.linked(PERSON),
      another: await read.linked("person-roster-owner-2"),
      control: await read.control(),
    };
  });
}

/** `read` in one transaction as rosie_app with no business scope: never set, or set and then ended (''). */
async function unscoped<T>(ended: boolean, read: (tx: Tx) => Promise<T>): Promise<T> {
  const answer = await cdb.toolApi.begin(async (tx) => {
    if (ended) await tx`select set_config('rosie.business_id', '', true)`;
    return { value: await read(tx) };
  });
  return answer.value;
}

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
    "as rosie_app under the same scope (T-1463): the three facts read from their rows, the question through 0037, the link through 0038 and the control under the call's scope, and the role-less signer's answer to S1-02's question passes default 14 as their own record, where T-1459's readTurnState is refused at its first table (42501)",
    SLOW,
    async () => {
      const facts = await factsUnder(cdb.toolApi);
      // Exactly what rosie_job reads under the same scope (the first case).
      expect(facts).toEqual(await factsUnder(cdb.runtime));
      expect(facts).toMatchObject({
        question: { openQuestionId: S1_02, personId: PERSON, businessId: BUSINESS, sentAt: SENT_AT },
        linked: true,
        another: false,
        control: { provenAt: null },
      });
      expect(await withBusiness(cdb.toolApi, BUSINESS, (tx) => changeOn(tx))).toEqual(OWN_RECORD);
      // The read T-1459's facts made, as main made it, is refused at its first table, handles.
      await expect(
        withBusiness(cdb.toolApi, BUSINESS, (tx) =>
          readTurnStateIn(tx, {
            handleId: HANDLE,
            businessId: BUSINESS,
            bookingIds: [],
            facts: [
              {
                key: "controlProvenAt",
                table: "business_setup",
                rowId: BUSINESS,
                column: "control_proven_at",
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: "42501", message: "permission denied for table handles" });
    },
  );

  it(
    "as rosie_app: control proven, no business_setup row, another person on the handle, a handle with no live question of the scoped business, and no scope each answer as today (the business's settings), never the sender's own record",
    SLOW,
    async () => {
      const { sql } = cdb.db;
      const asApp = (request?: GateRequest): Promise<Change> =>
        withBusiness(cdb.toolApi, BUSINESS, (tx) => changeOn(tx, request));

      // Control proven (with still no role).
      await sql`
        update business_setup
        set control_proven_at = '2026-10-19T18:20:00Z', control_proven_via = 'listing_code', version = version + 1
        where business_id = ${BUSINESS}
      `;
      try {
        expect(await asApp()).toEqual(THE_BUSINESS_SETTINGS);
      } finally {
        await sql`
          update business_setup set control_proven_at = null, control_proven_via = null, version = version + 1
          where business_id = ${BUSINESS}
        `;
      }

      // No business_setup row.
      await sql`delete from business_setup where business_id = ${BUSINESS}`;
      try {
        expect(await asApp()).toEqual(THE_BUSINESS_SETTINGS);
      } finally {
        await insertRow(sql, typed, "business_setup", { business_id: BUSINESS });
      }

      // Another person on the same handle: linked to it, but S1-02's question was asked of the person, not of them.
      await insertRow(sql, typed, "persons", { id: HELPER, name: null, language: null });
      await insertRow(sql, typed, "person_handles", { person_id: HELPER, handle_id: HANDLE });
      try {
        const helper = await withBusiness(cdb.toolApi, BUSINESS, async (tx) => ({
          linked: await signUpFactsOver(tx, BUSINESS, HANDLE).linked(HELPER),
          change: await changeOn(tx, secondTurn(HELPER, HANDLE)),
        }));
        expect(helper).toEqual({ linked: true, change: THE_BUSINESS_SETTINGS });
      } finally {
        await sql`delete from person_handles where person_id = ${HELPER} and handle_id = ${HANDLE}`;
        await sql`delete from persons where id = ${HELPER}`;
      }

      // The person's second handle, linked to them alone, with no live question of the business on it: the question is
      // not found there, and 0038 answers no link for it (its bound), as rosie_app.
      await insertRow(sql, typed, "handles", { id: SECOND_HANDLE, kind: "phone", address: SECOND_NUMBER });
      await insertRow(sql, typed, "person_handles", { person_id: PERSON, handle_id: SECOND_HANDLE });
      try {
        const second = await withBusiness(cdb.toolApi, BUSINESS, async (tx) => {
          const read = signUpFactsOver(tx, BUSINESS, SECOND_HANDLE);
          return {
            question: await read.question(S1_02),
            linked: await read.linked(PERSON),
            change: await changeOn(tx, secondTurn(PERSON, SECOND_HANDLE)),
          };
        });
        expect(second).toEqual({ question: null, linked: false, change: THE_BUSINESS_SETTINGS });
      } finally {
        await sql`delete from person_handles where person_id = ${PERSON} and handle_id = ${SECOND_HANDLE}`;
        await sql`delete from handles where id = ${SECOND_HANDLE}`;
      }

      // No scope, never set or ended: row-level security shows no question, and the link and the control are refused
      // before they are read (BusinessScopeError), so default 14 answers as today.
      for (const ended of [false, true]) {
        const none = await unscoped(ended, async (tx) => {
          const read = signUpFactsOver(tx, BUSINESS, HANDLE);
          return {
            question: await read.question(S1_02),
            linked: await read.linked(PERSON).catch((error: unknown) => (error as Error).name),
            control: await read.control().catch((error: unknown) => (error as Error).name),
            change: await changeOn(tx),
          };
        });
        expect(none, String(ended)).toEqual({
          question: null,
          linked: "BusinessScopeError",
          control: "BusinessScopeError",
          change: THE_BUSINESS_SETTINGS,
        });
      }

      // And with every row as it was, the part passes default 14 again.
      expect(await asApp()).toEqual(OWN_RECORD);
    },
  );

  it(
    "as rosie_app, the part as a whole: default 14's reads name no table that spans businesses, and the part then reaches S13-45's one rule, whose read of the handle's people is still refused (42501 on person_handles), so the call still fails as a whole, closed, until that read is the Tool API's too",
    SLOW,
    async () => {
      const sent: string[] = [];
      const watched = cdb.client(TOOL_API_ROLE, "rosie-limit-1-sign-up-watched", 1, (text) => {
        sent.push(text.trim());
      });
      try {
        await expect(under(watched)).rejects.toMatchObject({
          code: "42501",
          message: "permission denied for table person_handles",
        });
      } finally {
        await watched.end({ timeout: 5 });
      }
      // The refused statement: T-308's sender, db/repo/phones.ts listPersonIdsOfHandle, which the one rule reads.
      const refused = sent.findIndex((text) => /\bfrom\s+person_handles\b/u.test(text));
      expect(refused).toBeGreaterThan(0);
      expect(sent[refused]).toMatch(
        /^select person_id from person_handles where handle_id = \$1 order by person_id$/u,
      );
      // Before it, default 14 read its three facts: the question through 0037, the link through 0038 and the control.
      const before = sent.slice(0, refused);
      expect(before.some((text) => text.includes("open_questions_went_out("))).toBe(true);
      expect(before.some((text) => text.includes("person_handles_linked("))).toBe(true);
      expect(before.some((text) => text.includes("left join business_setup s"))).toBe(true);
      for (const text of before) {
        expect(text).not.toMatch(/\b(from|join)\s+(handles|persons|phones|person_handles|turns)\b/u);
      }
    },
  );
});
