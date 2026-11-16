// T-1413's integration proof of the keyword door on local PostgreSQL (`npm run db:up`, then `npm run test:integration`):
// the guard's keyword turn that names no business, through pgKeywordDoor on a runtime client as rosie_job, with every
// K-05 call real: the door's one runtime-side transaction (rosie.business_id set empty, rosie.person_id unset,
// assertRuntimeSide and the role checked before the first read, then read only), T-317's and T-307's reads and K-05 v1.4's
// record reads in their no-business forms on it, readOpenHolds with no business, the read-only sealer and commitTurn
// (T-306) each in a runtime transaction of their own. The schema is fresh, migrated with every migration, seeded with the
// fixtures' business heads, the bundle registry's row of the bundle the turns pin and T-1148's seed (test-support.ts),
// then Ben's rows before stop-recorded.json: K-04 seed-phone-stopped.json's own rows with his handle at the number K-09's
// fixtures name and his phone chat open, not stopped, at version 3 (T-317's world, as T-1163's proofs build it). Ben's
// sealing key is made as the gateway makes it at first sight (K-05 v1.2 item 29), under a wrapping key made for this run.
//
// The card's integration proofs (DL-864 lead note 3; DL-877): stop-recorded.json commits Ben's phone stopped, one K-29
// texts row with no business and the stop reply row; commitTurn writes the turn's K-08 entries, none naming a business,
// on the runtime side; a repeat answers repeated and writes nothing; START then lifts the stop; the door on a rosie_app
// client is refused before any read, with nothing written. Every read of the door's runs on its own connection inside its
// own transaction (C1, C2), which writes nothing; and no answer or span carries the number, its digits or Ben's words (C4).
// What K-05 names Ben's phone row by (K-05 v1, its number, until v1.17's cards: DL-875, DL-876) is not asserted here: the
// span's rows are checked to hold no number, whatever they hold.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePrimaryUrl } from "../../../../../db/repo/client";
import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import type { Sql } from "../../../../../db/repo/scope";
import type { WrappingKeys } from "../../../../../db/repo/sealing";
import type { Span } from "../../../../../runtime/src/trace";
import type { Committed, GateAndCommitRequest } from "../../../commit";
import {
  RUNTIME_ROLE,
  TOOL_API_ROLE,
  insertRow,
  snapshot,
  writesIn,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import { fakeBundles, sampleBundle } from "../../../frontier/assemble/test-support";
import { contractFile, stringsIn, traceFor } from "../../test-support";
import { createToolApiValidator } from "../../validator";
import { NOTHING_OPEN_AT } from "../commit";
import type { KeywordDoorAnswer } from "../door";
import { BEN, START_TURN, leaksIn, startTurn, stopRecorded } from "../door-test-support";
import { pgKeywordDoor } from "./calls";
import { openTurnFaceDatabase } from "./test-support";

const SLOW = { timeout: 60_000 };
const POOL = 4;
const STOP_TURN = "turn-ben-stop";

const validator = createToolApiValidator();

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

/** One statement a client sent: the connection it went on and its text, never its values. */
interface Sent {
  readonly connection: number;
  readonly text: string;
}

let cdb: CommitDatabase;
/** The runtime side's client the door runs on, as rosie_job, writing down every statement it sends; null until open. */
let runtime: Sql | null = null;
const sent: Sent[] = [];

/** The runtime side's client, once the file's setup has opened it. */
function runtimeClient(): Sql {
  if (runtime === null) throw new Error("the runtime side's client is not open");
  return runtime;
}

/** One client on this file's schema as `role`, writing each statement it sends to `into` (text and connection). */
function recordingClient(role: string, applicationName: string, into: Sent[]): Sql {
  return postgres(resolvePrimaryUrl(), {
    max: POOL,
    onnotice: () => undefined,
    debug: (connection: number, text: string) => {
      into.push({ connection, text });
    },
    connection: { application_name: applicationName, search_path: `${cdb.db.schema}, public`, role },
  });
}

/**
 * Ben's rows before stop-recorded.json, as the owner: K-04 seed-phone-stopped.json's own rows (Ben T., his handle, its
 * link, his customer role at the barbershop and his phone), his handle at the number K-09's fixtures name and his phone
 * chat open, not stopped, at version 3 (T-317's world: commit/core/core-flags.test.ts benWorld).
 */
async function seedBen(): Promise<void> {
  const { rows } = contractFile("db-schema/core/fixtures/seed-phone-stopped.json") as {
    rows: { table: string; values: Record<string, unknown> }[];
  };
  for (const { table, values } of rows) {
    const row =
      table === "handles"
        ? { ...values, address: BEN }
        : table === "phones"
          ? { ...values, number: BEN, stopped: false, stop_at: null, chat_open: true }
          : values;
    await insertRow(cdb.db.sql, new Map(), table, row);
  }
}

beforeAll(async () => {
  ({ cdb } = await openTurnFaceDatabase(POOL, ["seed-bundle-registry.json"], "turn_face_door"));
  await seedBen();
  // Ben's key, made as the gateway makes it at the first sight of his number (K-05 v1.2 item 29).
  const sighted = await handleSealingKey(cdb.runtime, KEYS, {
    handle: { kind: "phone", address: BEN },
    newHandleId: "handle-t1413-unused",
    newPersonId: "person-t1413-unused",
    wrappingKeyName: "SEALING_WRAP_KEY",
  });
  if (!("result" in sighted.outcome) || sighted.outcome.personId !== "person-ben") {
    throw new Error("first sight did not give Ben's key");
  }
  runtime = recordingClient(RUNTIME_ROLE, "rosie-turn-face-door-runtime", sent);
}, 120_000);

afterAll(async () => {
  // The setup may have stopped before the client was opened (a migration's lock timeout, 55P03, on a busy server).
  await runtime?.end({ timeout: 5 });
  await cdb.close();
});

/** The keyword door on `client` (the runtime side's, unless a test names another), at the commit's moment `now`. */
function door(now: string, client: Sql = runtimeClient()) {
  return pgKeywordDoor(client, {
    bundles: fakeBundles(sampleBundle("bundle-v0-skeleton.json")),
    wrappingKeys: KEYS,
    stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
    telling: NOT_TOLD_YET,
    now: () => new Date(now),
    validator,
  });
}

/** One call through the door on the request's own trace, with its spans. */
async function through(
  request: GateAndCommitRequest,
  client: Sql = runtimeClient(),
): Promise<{ answer: KeywordDoorAnswer; spans: Span[] }> {
  const { trace, spans } = traceFor(request);
  const answer = await door(request.now, client).gateAndCommit(
    structuredClone(request),
    NOTHING_OPEN_AT,
    trace,
  );
  return { answer, spans };
}

/** The committed answer, held to K-09 v1.5's response. */
function committedOf(answer: KeywordDoorAnswer): Committed {
  expect(validator.check("gateAndCommit", "response", answer), JSON.stringify(answer)).toEqual([]);
  if (!("result" in answer) || answer.result !== "committed") throw new Error("the turn did not commit");
  return answer;
}

/** The one span a call left; fails the test when there is not exactly one. */
function onlySpan(spans: readonly Span[]): Span {
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no span");
  return span;
}

/** Ben's phone row, as the owner reads it. */
async function bensPhone(): Promise<Record<string, unknown> | undefined> {
  const [phone] = await cdb.db.sql<Record<string, unknown>[]>`
    select stopped, chat_open, stop_at, start_at, version from phones where handle_id = 'handle-ben'
  `;
  return phone;
}

/** Ben's K-29 rows, as the owner reads them, oldest first. */
async function bensConsents(): Promise<Record<string, unknown>[]> {
  return cdb.db.sql<Record<string, unknown>[]>`
    select id, person_id, business_id, kind, revoked, handle_id, exact_words, channel, turn_id from consents
    where person_id = 'person-ben' order by at, id
  `;
}

/** The rows the door's turns may write that snapshot() does not count (K-29's and K-34's), each table's count. */
async function unversioned(): Promise<Record<string, unknown> | undefined> {
  const [row] = await cdb.db.sql<Record<string, unknown>[]>`
    select (select count(*)::int from consents) as consents, (select count(*)::int from safety_outcomes) as outcomes,
           (select count(*)::int from safety_holds) as holds
  `;
  return row;
}

/**
 * The statements of the transaction that made itself read only (the door's): those sent on its connection from its begin
 * to its commit or rollback, in order.
 */
function doorsStatements(statements: readonly Sent[]): string[] {
  const readOnly = statements.find((each) => /set transaction read only/iu.test(each.text));
  if (readOnly === undefined) throw new Error("no transaction was made read only");
  const own = statements.filter((each) => each.connection === readOnly.connection);
  const at = own.indexOf(readOnly);
  let begin = at;
  while (begin >= 0 && !/^\s*begin\b/iu.test(own[begin]?.text ?? "")) begin -= 1;
  const end = own.findIndex((each, index) => index > at && /^\s*(commit|rollback)\s*$/iu.test(each.text));
  if (begin < 0 || end < 0) throw new Error("the door's transaction has no begin or no end");
  return own.slice(begin, end + 1).map((each) => each.text);
}

describe("the keyword door on local PostgreSQL, as rosie_job on the runtime side (T-1413)", () => {
  it(
    "stop-recorded.json commits Ben's phone stopped, one K-29 texts row with no business and the stop reply; commitTurn writes the turn's K-08 entries with none on the runtime side",
    SLOW,
    async () => {
      const { request, outcome } = stopRecorded();
      sent.length = 0;
      const { answer, spans } = await through(request);
      const result = committedOf(answer);
      expect(result).toMatchObject({
        turnId: STOP_TURN,
        committedAt: request.now,
        repeated: false,
        parts: [],
        effects: [],
        openQuestions: { opened: [], closed: [] },
      });
      const [record, stop] = result.core;
      expect(record).toMatchObject({
        call: "recordSafetyOutcome",
        response: { outcomes: ["No"], hold: null, safetyLine: null, told: [], repeated: false },
        error: null,
      });
      // The STOP answers stop-recorded.json's, its rows named by the Worker's keyed ids.
      const fixtureStop = outcome.core[1];
      if (stop?.call !== "recordStopOrStart" || stop.response === null) throw new Error("the STOP recorded");
      if (fixtureStop?.call !== "recordStopOrStart" || fixtureStop.response === null) {
        throw new Error("stop-recorded.json records the STOP");
      }
      const { consentRowIds, reply } = stop.response;
      expect(stop.response).toEqual({ ...fixtureStop.response, consentRowIds, reply });
      expect(consentRowIds).toHaveLength(1);
      expect(reply?.fixedLineId).toBe(fixtureStop.response.reply?.fixedLineId);
      const replyRowId = reply?.outboxRowId ?? null;
      expect(result.written.outboxRows.map((row) => row.id)).toEqual([replyRowId]);

      // Ben's phone: stopped, its chat closed, at the STOP's time, compared and set on version 3 (RULES 4.1b).
      expect(await bensPhone()).toEqual({
        stopped: true,
        chat_open: false,
        stop_at: new Date(request.now),
        start_at: null,
        version: 4,
      });
      // One K-29 texts row for every business (business null), revoked, under Ben's turn, his own words.
      expect(await bensConsents()).toEqual([
        {
          id: consentRowIds[0],
          person_id: "person-ben",
          business_id: null,
          kind: "texts",
          revoked: true,
          handle_id: "handle-ben",
          exact_words: "STOP",
          channel: "text",
          turn_id: STOP_TURN,
        },
      ]);
      // The stop reply: one quick_reply row back to his mobile, naming no business, with no plan yet.
      expect(
        await cdb.db.sql`
          select id, recipient_handle_id, recipient_person_id, business_id, send_class, state from outbox_rows
          where turn_id = ${STOP_TURN}
        `,
      ).toEqual([
        {
          id: replyRowId,
          recipient_handle_id: "handle-ben",
          recipient_person_id: "person-ben",
          business_id: null,
          send_class: "quick_reply",
          state: "planned",
        },
      ]);
      // His text's record, under no business, and the turn row committed under its trace.
      expect(
        await cdb.db
          .sql`select id, business_id, turn_id, outcomes from safety_outcomes where event_id = 'evt-ben-0007'`,
      ).toEqual([
        {
          id: record?.call === "recordSafetyOutcome" ? record.response?.outcomeId : null,
          business_id: null,
          turn_id: STOP_TURN,
          outcomes: ["No"],
        },
      ]);
      expect(await cdb.db.sql`select state, trace_id from turns where id = ${STOP_TURN}`).toEqual([
        { state: "committed", trace_id: "trace-ben-0007" },
      ]);

      // The turn's K-08 entries, written by commitTurn on the runtime side: one per row, under the turn and its trace,
      // each naming no business (DL-864 lead note 3).
      const entries = await cdb.db.sql<{ kind: string; business_id: string | null; trace_id: string }[]>`
        select kind, business_id, trace_id from event_log where turn_id = ${STOP_TURN} order by kind
      `;
      expect(entries.map((entry) => entry.kind)).toEqual([
        "consent.withdrawn",
        "outbox_row.created",
        "phone.stopped",
        "safety_outcome.recorded",
      ]);
      for (const entry of entries) {
        expect(entry, entry.kind).toEqual({
          kind: entry.kind,
          business_id: null,
          trace_id: "trace-ben-0007",
        });
      }

      // C1, C2: the door's one transaction on one connection: read only, the flags service's reads and the record's on
      // it, and no write (commitTurn writes in its own transaction, on a connection of its own).
      const own = doorsStatements(sent);
      expect(writesIn(own)).toEqual([]);
      for (const table of ["phones", "consents", "person_handles", "safety_outcomes"]) {
        expect(
          own.some((text) => new RegExp(`\\bfrom\\s+"?${table}"?\\b`, "iu").test(text)),
          table,
        ).toBe(true);
      }

      // The gate hop's one span, with no business label, holding no number, digit run or words (C4).
      const span = onlySpan(spans);
      expect(span).toMatchObject({ hop: "gate", outcome: "ok", trace_id: "trace-ben-0007" });
      expect(span).not.toHaveProperty("business_id");
      expect(validator.checkSpan(span)).toEqual([]);
      for (const text of [...stringsIn(span), ...stringsIn(answer)]) expect(leaksIn(text), text).toEqual([]);
      expect(span.rows ?? []).not.toContainEqual(expect.objectContaining({ id: BEN }));
    },
  );

  it("a repeat of Ben's STOP answers repeated and writes nothing", SLOW, async () => {
    const { request } = stopRecorded();
    const before = {
      rows: await snapshot(cdb),
      unversioned: await unversioned(),
      consents: await bensConsents(),
    };
    const result = committedOf((await through(request)).answer);
    expect(result).toMatchObject({ turnId: STOP_TURN, repeated: true, written: { written: [] } });
    expect(result.core).toMatchObject([
      { call: "recordSafetyOutcome", response: { repeated: true }, error: null },
      { call: "recordStopOrStart", response: { repeated: true, stopped: true }, error: null },
    ]);
    expect({
      rows: await snapshot(cdb),
      unversioned: await unversioned(),
      consents: await bensConsents(),
    }).toEqual(before);
  });

  it(
    "START then lifts it: Ben's phone started, its chat open, a K-29 texts row with no business, the start reply",
    SLOW,
    async () => {
      const request = startTurn();
      const result = committedOf((await through(request)).answer);
      const [, start] = result.core;
      if (start?.call !== "recordStopOrStart" || start.response === null)
        throw new Error("the START recorded");
      expect(start.response).toMatchObject({
        stopped: false,
        chatOpen: true,
        phoneVersion: 5,
        repeated: false,
      });
      expect(start.response.reply?.fixedLineId).toBe("startReply");
      expect(await bensPhone()).toEqual({
        stopped: false,
        chat_open: true,
        stop_at: new Date(stopRecorded().request.now),
        start_at: new Date(request.now),
        version: 5,
      });
      const consents = await bensConsents();
      expect(consents).toHaveLength(2);
      expect(consents[1]).toEqual({
        id: start.response.consentRowIds[0],
        person_id: "person-ben",
        business_id: null,
        kind: "texts",
        revoked: false,
        handle_id: "handle-ben",
        exact_words: "START",
        channel: "text",
        turn_id: START_TURN,
      });
      expect(
        await cdb.db.sql`select id, business_id, send_class from outbox_rows where turn_id = ${START_TURN}`,
      ).toEqual([{ id: start.response.reply?.outboxRowId, business_id: null, send_class: "quick_reply" }]);
    },
  );

  it("the door on a rosie_app client is refused before any read, and nothing is written", SLOW, async () => {
    const appSent: Sent[] = [];
    const toolApi = recordingClient(TOOL_API_ROLE, "rosie-turn-face-door-tool-api", appSent);
    try {
      const before = { rows: await snapshot(cdb), unversioned: await unversioned() };
      const { request } = stopRecorded();
      const refused = await through(request, toolApi).then(
        () => null,
        (error: unknown) => error,
      );
      // The door's own check refused it (K-05's no-business reads would refuse rosie_app too, one read later).
      expect(refused).toMatchObject({ name: "BusinessScopeError" });
      expect(refused instanceof Error ? refused.message : "").toContain(
        "keyword door runs on the runtime side",
      );
      expect(appSent.some(({ text }) => /set transaction read only/iu.test(text))).toBe(false);
      // Nothing read: no statement named a table of the schema (postgres.js reads PostgreSQL's own type catalog,
      // pg_catalog, as a connection opens); the transaction rolled back; nothing written anywhere.
      expect(appSent.length).toBeGreaterThan(0);
      for (const { text } of appSent) expect(text).not.toMatch(/\b(from|join)\s+(?!pg_catalog\.)\S/iu);
      expect(appSent.at(-1)?.text).toMatch(/rollback/iu);
      expect({ rows: await snapshot(cdb), unversioned: await unversioned() }).toEqual(before);
    } finally {
      await toolApi.end({ timeout: 5 });
    }
  });
});
