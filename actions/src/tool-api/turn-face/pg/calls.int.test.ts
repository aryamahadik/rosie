// T-1141's integration proof of the turn face's gate and commit on local PostgreSQL (`npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/turn-face`): turn 1, Sam's first text (K-09 v1.5 commit-s1-01.json),
// through the Tool API base on the Tool API's own client (rosie_app, one business-scoped transaction per call), with every
// K-05 call real: readOpenHolds and six safety reads on the call's transaction, readBusinessOwner, the read-only sealer and
// commitTurn (T-306) each in a runtime transaction of its own (rosie_job). The schema is fresh, migrated with every
// migration, seeded with the fixture's business heads, the bundle registry's row of the bundle the turn pins and T-1148's
// seed for D-017 (Sam with no role, no phone row), and dropped when the file ends (test-support.ts). Sam's sealing key is
// made as the gateway makes it at first sight (K-05 v1.2 item 29), under a wrapping key made for this run alone.
//
// Real here: the base, the gate and its limits as registered (limit 1 given bundle v0's step cards), the commit, the walk,
// runCore with the safety service, every data-access call, row-level security and the two application roles. Given: bundle
// v0 (K-01 v1's bundle-v0-skeleton.json, which the turn pins) through the frontier's fake bundles, as T-315's proof gives it.
//
// The card's proofs (round 2: DL-364, DL-370): one turn commits under one turn id and one trace id S1-01's thread, S1-02's
// open question, its clock row and outbox-s1-02-sam-1, and replaying it writes nothing twice; and the card's integration
// line, the whole turn from gate and commit through compose input to finalize, which writes the row's final parts: one
// open question, its clock row and one outbox row with its final parts, all under one turn id and one trace id, nothing
// written twice on replay. Finalize writes final parts only on a bundle that carries the privacy link (T-314; K-09 v1.5
// open gap 121) and, for this row to Sam with no role, read by S1-02's sign-up line as the owner on S1-02 (which does not
// need business), the sign-up opener (K-01 README default 19, T-1510; T-1511), so that turn is pinned to bundle v2 as
// bundles/v2 holds it (T-1477: S1-01 and S1-02 as bundle v0 as published holds them, T-1146), its own schema's registry
// row; its first text opens with S1-02's own words, never the seed business's name.
//
// T-1190: the seed gives the barbershop its barber kind of work with no switch on (T-1197; CQ-185), so K-05 v1.6's
// readOutboxRow reads the row's sensitive switch as false, and compose input gives compose-input-s1-02-v1.6.json's input
// word for word, routine, as T-1175's recording 4 has it.
//
// T-1410 (T-1368's new task a; its architect's note a; DL-832): pgCallScope opens each call's transaction for the K-09
// call the Tool API base names, handing its ScopeCall on to db/repo/scope.ts withBusiness (its `call` and `transient`).
// Each of gateAndCommit, composeInput and finalizeMessage runs through pgTurnFace and pgTurnCalls as the turn makes it, on
// a Tool API client whose transaction cannot start: lost as it starts (the socket destroyed just as the begin is to be
// written, so postgres.js rejects it with its own CONNECTION_CLOSED, the server's host and port on it), never opened (a
// local port nothing listens on), or refused at its start with the database named (a local server that answers each
// session as PostgreSQL does with 3D000, 42501 or 55000, a planted database in its message). A lost or never opened start
// answers the call's K-09 transient, and a refused one is thrown scrubbed under the call's own name, never transient and
// never under "withBusiness"; where a call's errors had no transient (a validator that is the frozen contract's but for
// that call's errors), a lost start is thrown scrubbed under its name too. Each time the handler never ran: nothing was
// sent on the runtime side's client, and nothing of the connection is in the answer, the thrown error (message, stack and
// own properties), a span or the face's log. The probe's user, password and database are made up here.

import { once } from "node:events";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePrimaryUrl } from "../../../../../db/repo/client";
import { DataAccessDatabaseError } from "../../../../../db/repo/clocks";
import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import type { Sql } from "../../../../../db/repo/scope";
import { seal, unsealText, type WrappingKeys } from "../../../../../db/repo/sealing";
import { inRuntimeTransaction, type TransientError } from "../../../../../db/repo/targets";
import { readOutboxRow } from "../../../../../db/repo/turn-face-reads";
import { TEST_OWNER_1 } from "../../../../../db/seeds/skeleton";
import type { Span } from "../../../../../runtime/src/trace";
import type { GateAndCommitRequest } from "../../../commit";
import { S1_01_IDS } from "../../../commit/core/test-support";
import { footprint, rowOf, snapshot, type CommitDatabase } from "../../../commit/pg/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import {
  captureLog,
  checks,
  fakeBundles,
  sampleBundle,
  type BundleDocument,
  type LogCapture,
} from "../../../frontier/assemble/test-support";
import { fixture, traceFor } from "../../test-support";
import type { ToolApiValidator } from "../../validator";
import {
  SAM_KEY,
  commitRequestAfter,
  commitS101,
  composeS102,
  publishedBundleV2,
} from "../calls-test-support";
import { NOTHING_OPEN_AT } from "../commit";
import { TurnFaceRefusedError } from "../errors";
import type { GateAndCommitCallAnswer, TurnFace } from "../turn-face";
import { pgReadOnlySealer, pgTurnCalls, pgTurnFace } from "./index";
import { openTurnFaceDatabase } from "./test-support";

type Json = Record<string, unknown>;

const SLOW = { timeout: 60_000 };
const POOL = 4;
const TURN = "turn-s1-01-sam";
const TRACE = "trace-sam-0000";
const ROW = "outbox-s1-02-sam-1";
const QUESTION = "oq-s1-02-sam-1";
const SAM = TEST_OWNER_1.personId;
/** A person with no sealing key, written for the sealer's refusal (a test id, no one's data). */
const NO_KEY = "person-t1141-no-key";

const { validator, checker } = checks();

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

let cdb: CommitDatabase;

beforeAll(async () => {
  ({ cdb } = await openTurnFaceDatabase(POOL, ["seed-bundle-registry.json"], "turn_face_calls"));
  await cdb.db.sql`insert into persons (id, name) values (${NO_KEY}, null)`;
  // Sam's key, made as the gateway makes it at the first sight of his number (K-05 v1.2 item 29).
  const sighted = await handleSealingKey(cdb.runtime, KEYS, {
    handle: { kind: "phone", address: "+15555550100" },
    newHandleId: "handle-t1141-unused",
    newPersonId: "person-t1141-unused",
    wrappingKeyName: "SEALING_WRAP_KEY",
  });
  if (!("result" in sighted.outcome) || sighted.outcome.personId !== SAM) {
    throw new Error("first sight did not give Sam's key");
  }
}, 120_000);

afterAll(async () => {
  await cdb.close();
});

/** The turn face on this schema: the frontier as T-315 binds it, and the calls after it on both application roles. */
function face(): TurnFace {
  const bundles = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  return pgTurnFace(cdb.runtime, {
    bundles,
    validator,
    checker,
    log: captureLog().sink,
    calls: pgTurnCalls(cdb.runtime, cdb.toolApi, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
      now: () => new Date(commitS101().given.now),
      turnKey: () => SAM_KEY,
      safetyExtra: { ids: S1_01_IDS },
    }),
  });
}

async function commitTurnOne(): Promise<GateAndCommitCallAnswer> {
  const request = commitRequestAfter(undefined);
  return face().gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
}

describe("gateAndCommit for turn 1 on local PostgreSQL (T-1141)", () => {
  it(
    "one turn commits under one turn id and one trace id: S1-01's thread, S1-02's question, its clock row and outbox-s1-02-sam-1; replaying it writes nothing twice",
    SLOW,
    async () => {
      const before = await snapshot(cdb);
      const first = await commitTurnOne();
      expect(first, JSON.stringify(first)).toMatchObject({
        result: "committed",
        turnId: TURN,
        repeated: false,
        parts: commitS101().outcome.parts,
        openQuestions: { opened: [QUESTION], closed: [] },
      });
      expect(validator.check("gateAndCommit", "response", first)).toEqual([]);

      // The turn row, committed, with the turn's trace; every event-log entry under the turn id and its trace.
      const [turn] = await cdb.db.sql<{ state: string; trace_id: string }[]>`
        select state, trace_id from turns where id = ${TURN}
      `;
      expect(turn).toEqual({ state: "committed", trace_id: TRACE });
      const entries = await cdb.db.sql<{ turn_id: string | null; trace_id: string; kind: string }[]>`
        select turn_id, trace_id, kind from event_log where turn_id = ${TURN} or trace_id = ${TRACE}
      `;
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect([entry.turn_id, entry.trace_id]).toEqual([TURN, TRACE]);

      // Sam's text's safety record, No, under the turn, its words sealed under Sam's own key.
      const [record] = await cdb.db.sql<
        { id: string; turn_id: string; outcomes: string[]; sealed_words: Uint8Array | null }[]
      >`select id, turn_id, outcomes, sealed_words from safety_outcomes where event_id = 'evt-sam-s1-01'`;
      expect(record).toMatchObject({ id: "safety-outcome-sam-s1-01", turn_id: TURN, outcomes: ["No"] });
      if (record?.sealed_words == null) throw new Error("the read's words are sealed");
      // Since T-1185 the commit stores the sealed value's own bytes (SEALED_WAITING is gone, DL-364 ruling 3): they open
      // under Sam's own key, and nothing of them reads as K-04's text form.
      const stored = new Uint8Array(record.sealed_words);
      expect(new TextDecoder().decode(stored.slice(0, 2))).not.toBe("\\x");
      const words = JSON.parse(await unsealText(cdb.runtime, KEYS, SAM, stored)) as {
        labels: unknown[];
      };
      expect(words.labels).toHaveLength(1);

      // S1-01's thread with the turn's chat id; one open question, its clock row (and its never_delivered row once note
      // 37's task merges: CQ-156 b), one outbox row with no plan yet, each under the turn id.
      const rows = await footprint(cdb, TURN);
      expect(rows).toMatchObject({ turns: 1, outbox: 1, questions: 1, effects: 0 });
      expect(rows.clocks).toBeGreaterThanOrEqual(1);
      const thread = ["handle_id", "kind", "booking_id", "linq_chat_id"];
      expect(await rowOf(cdb, "threads", "thread-s1-01-sam-1", thread)).toEqual({
        version: 1,
        handle_id: "handle-sam",
        kind: "chat",
        booking_id: null,
        linq_chat_id: "linq-chat-demo-sam",
      });
      const [outbox] = await cdb.db.sql<
        { id: string; state: string; channel: string; send_class: string; open_question_id: string }[]
      >`
        select id, state, channel, send_class, open_question_id from outbox_rows where turn_id = ${TURN}
      `;
      expect(outbox).toEqual({
        id: ROW,
        state: "planned",
        channel: "imessage",
        send_class: "quick_reply",
        open_question_id: QUESTION,
      });

      // Replaying the same turn answers the first commit and writes nothing at all.
      const written = await snapshot(cdb);
      expect(written).not.toEqual(before);
      const again = await commitTurnOne();
      expect(again).toMatchObject({ result: "committed", turnId: TURN, repeated: true });
      expect((again as { written: { written: unknown[] } }).written.written).toEqual([]);
      expect(await snapshot(cdb)).toEqual(written);
      expect(await footprint(cdb, TURN)).toEqual(rows);
    },
  );

  it(
    "two commits of the same turn at once give one commit: each answers it, and the rows are written once",
    SLOW,
    async () => {
      const before = await footprint(cdb, TURN);
      const [one, two] = await Promise.all([commitTurnOne(), commitTurnOne()]);
      for (const answer of [one, two]) expect(answer).toMatchObject({ result: "committed", turnId: TURN });
      expect(await footprint(cdb, TURN)).toEqual(before);
    },
  );
});

describe("the card's integration line: one turn from gate and commit to finalize's final parts, on PostgreSQL (bundle v2)", () => {
  /** This describe's own schema: T-1148's seed, Sam's key, and bundle v2 in the bundle registry. */
  let whole: CommitDatabase;
  let wholeFace: TurnFace;
  const published: BundleDocument = publishedBundleV2();
  const bundleId = published.manifest.bundleId as { hash: string; build: number };

  /** commit-s1-01.json's request, the turn pinned to bundle v2: its turn's, context's and decide's id. */
  function pinnedRequest(): GateAndCommitRequest {
    const request = commitRequestAfter(undefined);
    if (request.turn === null || request.input.kind !== "decided")
      throw new Error("turn 1 is a decided turn");
    request.turn.bundleId = { ...bundleId };
    request.input.decided.context.bundleId = { ...bundleId };
    request.input.decided.decide.bundleId = { ...bundleId };
    return request;
  }

  beforeAll(async () => {
    ({ cdb: whole } = await openTurnFaceDatabase(POOL, ["seed-bundle-registry.json"], "turn_face_whole"));
    await whole.db.sql`
      insert into bundles (hash, build, manifest_key, built_at, published_at, active)
      values (${bundleId.hash}, ${bundleId.build}, ${`bundle/${bundleId.hash}/${String(bundleId.build)}/manifest`},
              '2026-11-10T08:00:00Z', '2026-11-10T08:05:00Z', false)
    `;
    const sighted = await handleSealingKey(whole.runtime, KEYS, {
      handle: { kind: "phone", address: "+15555550100" },
      newHandleId: "handle-t1141-unused",
      newPersonId: "person-t1141-unused",
      wrappingKeyName: "SEALING_WRAP_KEY",
    });
    if (!("result" in sighted.outcome) || sighted.outcome.personId !== SAM) {
      throw new Error("first sight did not give Sam's key");
    }
    const bundles = fakeBundles(published);
    wholeFace = pgTurnFace(whole.runtime, {
      bundles,
      validator,
      checker,
      log: captureLog().sink,
      calls: pgTurnCalls(whole.runtime, whole.toolApi, {
        bundles,
        wrappingKeys: KEYS,
        stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
        telling: NOT_TOLD_YET,
        now: () => new Date(commitS101().given.now),
        turnKey: () => SAM_KEY,
        safetyExtra: { ids: S1_01_IDS },
        finalizeNow: () => "2026-10-19T18:05:07Z",
        finalizeLog: () => undefined,
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await whole.close();
  });

  /**
   * The turn's three calls after the frontier, in turn order, each on the turn's trace, with the spans they left: none of
   * the base's since T-1193, the handle actor's turn recording those hops itself.
   */
  async function runTurn() {
    const request = pinnedRequest();
    const commitTrace = traceFor(request);
    const committed = await wholeFace.gateAndCommit(request, NOTHING_OPEN_AT, commitTrace.trace);
    const compose = fixture("compose-input-s1-02.json") as { request: Json };
    const composeTrace = traceFor(compose.request);
    const composed = await wholeFace.composeInput(structuredClone(compose.request), composeTrace.trace);
    const finalize = fixture("finalize-pass.json") as { request: Json };
    const finalizeTrace = traceFor(finalize.request);
    const finalized = await wholeFace.finalizeMessage(structuredClone(finalize.request), finalizeTrace.trace);
    const spans = [...commitTrace.spans, ...composeTrace.spans, ...finalizeTrace.spans];
    return { committed, composed, finalized, spans };
  }

  it(
    "one open question, its clock row and one outbox row with its final parts, all under one turn id and one trace id; replaying the turn writes nothing twice",
    SLOW,
    async () => {
      const before = await snapshot(whole);
      const first = await runTurn();
      expect(first.committed, JSON.stringify(first.committed)).toMatchObject({
        result: "committed",
        turnId: TURN,
        repeated: false,
        parts: commitS101().outcome.parts,
      });
      expect(validator.check("composeInput", "response", first.composed)).toEqual([]);
      expect(first.composed).toMatchObject({
        result: "compose",
        input: { row: ROW, audience: { role: "owner", name: "Sam" } },
      });
      // T-1190: the seed's barbershop holds its barber kind of work, no switch on, so the read gives the switch false
      // and the row is routine: compose-input-s1-02-v1.6.json's input word for word.
      const read = await readOutboxRow(whole.runtime, {
        outboxRowId: ROW,
        businessId: TEST_OWNER_1.businessId,
      });
      expect(read).toMatchObject({ result: "outboxRow", outboxRowId: ROW, businessSensitive: false });
      expect(first.composed).toEqual({ result: "compose", input: composeS102().outcome.input });
      expect(validator.check("finalizeMessage", "response", first.finalized)).toEqual([]);
      const finalized = first.finalized as unknown as Json & {
        finalParts: { fixedLines: string[]; sends: { text: string }[] };
      };
      expect(finalized.outcome).toBe("send");
      // T-1148's seed holds no phone row, so the opt-out line was never delivered: it rides with the opener and the link.
      // Sam holds no role and is read by S1-02's sign-up line as the owner, on a step that does not need business, so
      // the opener is signUpOpener, S1-02's own words (K-01 README default 19), and the seed's business is named nowhere.
      expect(finalized.finalParts.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
      const text = finalized.finalParts.sends[0]?.text ?? "";
      expect(text.startsWith("Hi! I'm Rosie, an automated assistant. ")).toBe(true);
      expect(text).not.toContain("Lee's Barbershop");
      expect(text).not.toContain("booking assistant for");
      expect(text.split("\n").at(-1)).toBe("Privacy notice: rosfield.com/test/privacy");

      // One open question, its clock row, one outbox row with its final parts: each under the turn id.
      const rows = await footprint(whole, TURN);
      expect(rows).toMatchObject({ turns: 1, outbox: 1, questions: 1, effects: 0 });
      const questions = await whole.db.sql<{ id: string; step: string }[]>`
        select id, step from open_questions where turn_id = ${TURN}
      `;
      expect(questions).toEqual([{ id: QUESTION, step: "S1-02" }]);
      const clocks = await whole.db.sql<{ id: string; kind: string }[]>`
        select id, kind from clock_rows where created_by_turn_id = ${TURN} order by id
      `;
      expect(clocks.map((clock) => clock.id)).toContain(`clock-${QUESTION}`);
      expect(clocks.find((clock) => clock.id === `clock-${QUESTION}`)?.kind).toBe("question");
      expect(await rowOf(whole, "outbox_rows", ROW, ["turn_id", "state", "final_parts"])).toEqual({
        version: 2,
        turn_id: TURN,
        state: "checked",
        final_parts: finalized.finalParts,
      });
      // ...and one trace id: the turn row's, and every event-log entry of the turn (none under the trace for another).
      const [turn] = await whole.db.sql<
        { trace_id: string }[]
      >`select trace_id from turns where id = ${TURN}`;
      expect(turn?.trace_id).toBe(TRACE);
      const entries = await whole.db.sql<{ turn_id: string | null; trace_id: string }[]>`
        select turn_id, trace_id from event_log where turn_id = ${TURN} or trace_id = ${TRACE}
      `;
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect([entry.turn_id, entry.trace_id]).toEqual([TURN, TRACE]);
      // No span of the base's: the turn records the gate, the commit and each row's fillAndChecks itself, and the face
      // tells the base so (T-1193; DL-376), so each of those hops is the turn's alone.
      expect(first.spans).toEqual([]);

      // Replaying the turn writes nothing twice: the commit answers the first, repeated; compose input and finalize each
      // answer alreadyPlanned for the row that holds its plan, finalize with the parts written; no row, version or entry
      // changes.
      const written = await snapshot(whole);
      expect(written).not.toEqual(before);
      const again = await runTurn();
      expect(again.committed).toMatchObject({ result: "committed", turnId: TURN, repeated: true });
      expect((again.committed as { written: { written: unknown[] } }).written.written).toEqual([]);
      expect(again.composed).toEqual({ error: "alreadyPlanned", outboxRowId: ROW });
      expect(again.finalized).toEqual({
        error: "alreadyPlanned",
        outboxRowId: ROW,
        finalParts: finalized.finalParts,
      });
      expect(await snapshot(whole)).toEqual(written);
      expect(await footprint(whole, TURN)).toEqual(rows);
    },
  );
});

describe("the safety record's sealer never makes a key (DL-344; the security reviewer's note a on T-1140)", () => {
  it(
    "a person with no key is refused, and no key row is made; Sam's existing key seals what opens again",
    SLOW,
    async () => {
      const sealer = pgReadOnlySealer(cdb.runtime, KEYS);
      await expect(sealer.seal("words", NO_KEY)).rejects.toBeInstanceOf(TurnFaceRefusedError);
      const keys = await cdb.db.sql<{ n: number }[]>`
      select count(*)::int as n from sealing_keys where person_id = ${NO_KEY}
    `;
      expect(keys[0]?.n).toBe(0);
      const sealed = await sealer.seal("Sam's words", SAM);
      expect(await unsealText(cdb.runtime, KEYS, SAM, sealed)).toBe("Sam's words");
    },
  );

  it(
    "its transaction is read only: a seal that would make a key is refused by PostgreSQL itself (25006)",
    SLOW,
    async () => {
      await expect(
        inRuntimeTransaction(cdb.runtime, { readOnly: true }, (tx) => seal(tx, KEYS, NO_KEY, "words")),
      ).rejects.toMatchObject({ code: "25006" });
    },
  );
});

// ---- T-1410: each call's transaction is opened for the K-09 call the base names ---------------------------------------

const PROBE_USER = "t1410_probe_user";
const PROBE_PASSWORD = "t1410-probe-password";
const PROBE_DATABASE = "t1410_probe_db";

/** The three calls after the frontier, as the turn makes them: each one's K-09 errors have K-05's transient. */
const START_CALLS = ["gateAndCommit", "composeInput", "finalizeMessage"] as const;
type StartCall = (typeof START_CALLS)[number];

/** K-05's transient as a call's start answers it: a connection lost as it starts, or one that never opened. */
const LOST: TransientError = { error: "transient", sqlstate: "08006" };
const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };

/**
 * PostgreSQL's refusals of a session at its start that name the database (postinit.c), each with the planted database in
 * its message as the server words it (as T-1368's frontier test plants it).
 */
const DATABASE_REFUSALS: readonly { code: string; text: string }[] = [
  { code: "3D000", text: `database "${PROBE_DATABASE}" does not exist` },
  { code: "42501", text: `permission denied for database "${PROBE_DATABASE}"` },
  { code: "55000", text: `database "${PROBE_DATABASE}" is not currently accepting connections` },
];

/** Each call's request as the turn sends it: K-09 v1.5's commit-s1-01.json, compose-input-s1-02.json, finalize-pass.json. */
function startRequest(call: StartCall): unknown {
  if (call === "gateAndCommit") return commitRequestAfter(undefined);
  const file = call === "composeInput" ? "compose-input-s1-02.json" : "finalize-pass.json";
  return (fixture(file) as { request: Json }).request;
}

/**
 * The frozen contract's checks but for `call`'s errors, which refuse K-05's transient: as K-09 would check a call whose
 * errors had none (none of the three is one today).
 */
function noTransientFor(call: StartCall): ToolApiValidator {
  return {
    check: (name, part, value) =>
      name === call && part === "errors" && (value as { error?: unknown } | null)?.error === "transient"
        ? ["(root) this call's errors have no transient"]
        : validator.check(name, part, value),
    checkSpan: (value) => validator.checkSpan(value),
    laneChecks: (version, name) => validator.laneChecks(version, name),
  };
}

// What an outcome must never hold.

type Secrets = Readonly<Record<string, RegExp>>;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
  const secrets: Record<string, RegExp> = {};
  for (const [name, value] of Object.entries(values)) {
    secrets[name] =
      typeof value === "number"
        ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
        : new RegExp(escaped(value));
  }
  return secrets;
}

/** The probe's connection on a local port: the host, the port, the user, the password and the database. */
const probeSecrets = (port: number): Secrets =>
  secretsOf({
    host: "127.0.0.1",
    port,
    user: PROBE_USER,
    password: PROBE_PASSWORD,
    database: PROBE_DATABASE,
  });

/** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
function textsOf(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return [String(value)];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const texts: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    texts.push(key, ...textsOf((value as Record<string, unknown>)[key], seen));
  }
  return texts;
}

/** The names of the secrets `value` holds anywhere, never their values. */
function leaksOf(value: unknown, secrets: Secrets): string[] {
  const texts = textsOf(value);
  return Object.entries(secrets)
    .filter(([, secret]) => texts.some((text) => secret.test(text)))
    .map(([name]) => name);
}

// The clients and servers.

/** The local server (DATABASE_URL, else the local default): its connection string, host and port, never printed. */
function localServer(): { url: string; host: string; port: number } {
  const url = resolvePrimaryUrl();
  const { hostname, port } = new URL(url);
  return { url, host: hostname, port: port === "" ? 5432 : Number(port) };
}

/** A client and each statement's text as postgres.js built it, in order (its `debug` hook): never a value. */
interface WatchedClient {
  readonly sql: Sql;
  readonly sent: string[];
}

/**
 * The runtime side's client for these calls: the local server, one connection, which postgres.js opens only once a
 * statement is made, each statement written down. A call whose handler never ran sends nothing on it.
 */
function watchedRuntime(): WatchedClient {
  const sent: string[] = [];
  const options = {
    max: 1,
    onnotice: () => undefined,
    debug: (_connection: number, text: string) => {
      sent.push(text);
    },
  };
  return { sql: postgres(localServer().url, options), sent };
}

/**
 * A Tool API client of the local server, one connection, whose socket is destroyed just as its transaction's begin is to
 * be written (postgres.js's `debug` hook sees each statement as it is built; its `socket` option gives the socket): the
 * begin never goes, and postgres.js rejects it with its own CONNECTION_CLOSED (T-1368's tool-api.int.test.ts lostAtBegin).
 */
function lostAtBegin(): WatchedClient {
  const { url, host, port } = localServer();
  const sent: string[] = [];
  let cutNext = false;
  const options = {
    max: 1,
    onnotice: () => undefined,
    connection: { application_name: "rosie-t1410-turn-face" },
    debug: (_connection: number, text: string) => {
      sent.push(text);
      if (text.trim() === "begin") cutNext = true;
    },
    socket: () => {
      const socket = createConnection(port, host);
      const write = socket.write.bind(socket);
      socket.write = ((...args: Parameters<typeof write>) => {
        if (!cutNext) return write(...args);
        cutNext = false;
        socket.destroy();
        return true;
      }) as typeof socket.write;
      return socket;
    },
  };
  return { sql: postgres(url, options), sent };
}

/** A local port nothing listens on: one the system just handed out and took back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

/** PostgreSQL's ErrorResponse message ('E', its length, then each field's type byte and text, then a zero). */
function errorResponse(fields: Readonly<Record<string, string>>): Uint8Array {
  const texts = Object.entries(fields).map(([type, text]) => `${type}${text}\u0000`);
  const body = new TextEncoder().encode(`${texts.join("")}\u0000`);
  const message = new Uint8Array(body.length + 5);
  const view = new DataView(message.buffer);
  view.setUint8(0, "E".charCodeAt(0));
  view.setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
}

/** A local server that refuses each session at its start, as PostgreSQL does, with `code` and `message`, then closes. */
async function refusingServer(
  code: string,
  message: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.end(errorResponse({ S: "FATAL", V: "FATAL", C: code, M: message }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

/** The probe's connection string: the made-up user, password and database on a local port. */
function probeUrl(port: number): string {
  return `postgres://${PROBE_USER}:${PROBE_PASSWORD}@127.0.0.1:${String(port)}/${PROBE_DATABASE}`;
}

// One call through the face, and what it must leave.

/** How one call ended through the face, the spans its trace kept, and the face's log. */
interface StartRun {
  readonly settled: { answer: unknown } | { thrown: unknown };
  readonly spans: Span[];
  readonly log: LogCapture;
}

/**
 * One call through the turn face as the turn makes it: pgTurnFace with pgTurnCalls, the calls' scope pgCallScope over
 * `toolApi` and the runtime side on `runtime`, the base checking by `checks`.
 */
async function callThroughFace(
  call: StartCall,
  runtime: Sql,
  toolApi: Sql,
  checks: ToolApiValidator = validator,
): Promise<StartRun> {
  const bundles = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  const log = captureLog();
  const startFace = pgTurnFace(runtime, {
    bundles,
    validator: checks,
    checker,
    log: log.sink,
    calls: pgTurnCalls(runtime, toolApi, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
    }),
  });
  const request = startRequest(call);
  const { trace, spans } = traceFor(request);
  const made: Promise<unknown> =
    call === "gateAndCommit"
      ? startFace.gateAndCommit(request, NOTHING_OPEN_AT, trace)
      : call === "composeInput"
        ? startFace.composeInput(request, trace)
        : startFace.finalizeMessage(request, trace);
  const settled = await made.then(
    (answer) => ({ answer }),
    (thrown: unknown) => ({ thrown }),
  );
  return { settled, spans, log };
}

/** The start's failure thrown scrubbed: the K-09 call's own name and the SQLSTATE alone, never "withBusiness". */
function expectScrubbedUnder(thrown: unknown, call: StartCall, code: string): void {
  expect(thrown, call).toBeInstanceOf(DataAccessDatabaseError);
  expect(Object.getOwnPropertyNames(thrown).sort(), call).toEqual([
    "call",
    "code",
    "constraint",
    "message",
    "name",
    "stack",
    "table",
  ]);
  expect(thrown, call).toMatchObject({ call, code, table: null, constraint: null });
  expect((thrown as Error).message, call).toBe(`${call}: the database refused the call (SQLSTATE ${code})`);
}

/**
 * What a start the database could not make, or refused, leaves for `call`: the transient `answer` (held to the call's
 * K-09 errors), else `thrown` scrubbed to its SQLSTATE under the call's name; no span of the base's (the turn records the
 * call's hop itself) and nothing logged; nothing of the connection anywhere.
 */
function expectStartOutcome(
  run: StartRun,
  call: StartCall,
  expected: { answer: TransientError } | { thrown: string },
  secrets: Secrets,
): void {
  for (const seen of [run.settled, run.spans, run.log.lines])
    expect(leaksOf(seen, secrets), call).toEqual([]);
  expect(run.spans, call).toEqual([]);
  expect(run.log.lines, call).toEqual([]);
  if ("answer" in expected) {
    expect(run.settled, call).toEqual({ answer: expected.answer });
    expect(validator.check(call, "errors", expected.answer), call).toEqual([]);
    return;
  }
  expect("thrown" in run.settled, call).toBe(true);
  expectScrubbedUnder((run.settled as { thrown: unknown }).thrown, call, expected.thrown);
}

describe("each call's transaction is opened for the K-09 call the Tool API base names (T-1410)", () => {
  it(
    "lost as it starts (postgres.js's CONNECTION_CLOSED, the server's host and port on it): gateAndCommit, composeInput and finalizeMessage each answer K-09's transient 08006, the handler never run and nothing sent on the runtime side",
    SLOW,
    async () => {
      const { host, port } = localServer();
      const secrets = secretsOf({ "server host": host, "server port": port });
      // What postgres.js rejects the begin with on such a client: its own CONNECTION_CLOSED, the host and port in it.
      const probe = lostAtBegin();
      try {
        const raw = await probe.sql
          .begin(() => Promise.resolve("never"))
          .then(
            () => {
              throw new Error("the begin went");
            },
            (error: unknown) => error,
          );
        expect(raw).toMatchObject({ code: "CONNECTION_CLOSED" });
        expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["server host", "server port"]));
        expect(probe.sent.at(-1)?.trim()).toBe("begin");
      } finally {
        await probe.sql.end({ timeout: 0 });
      }

      for (const call of START_CALLS) {
        const runtime = watchedRuntime();
        const toolApi = lostAtBegin();
        try {
          const run = await callThroughFace(call, runtime.sql, toolApi.sql);
          expectStartOutcome(run, call, { answer: LOST }, secrets);
          // The begin was the last statement built on the Tool API's client, and nothing went on the runtime side's.
          expect(toolApi.sent.at(-1)?.trim(), call).toBe("begin");
          expect(runtime.sent, call).toEqual([]);
        } finally {
          await Promise.all([toolApi.sql.end({ timeout: 0 }), runtime.sql.end({ timeout: 0 })]);
        }
      }
    },
  );

  it(
    "a connection that never opens (a closed port, Node's ECONNREFUSED): each call answers K-09's transient 08001, the handler never run",
    SLOW,
    async () => {
      const port = await closedPort();
      const secrets = probeSecrets(port);
      for (const call of START_CALLS) {
        const runtime = watchedRuntime();
        const toolApi = postgres(probeUrl(port), { max: 1, onnotice: () => undefined });
        try {
          const run = await callThroughFace(call, runtime.sql, toolApi);
          expectStartOutcome(run, call, { answer: NEVER_OPENED }, secrets);
          expect(runtime.sent, call).toEqual([]);
        } finally {
          await Promise.all([toolApi.end({ timeout: 0 }), runtime.sql.end({ timeout: 0 })]);
        }
      }
    },
  );

  it.each(DATABASE_REFUSALS)(
    "a session PostgreSQL refuses at its start with $code, the planted database in its message, is never transient: each call throws it scrubbed under its own K-09 name, the handler never run",
    async ({ code, text }) => {
      const server = await refusingServer(code, text);
      const secrets = probeSecrets(server.port);
      try {
        for (const call of START_CALLS) {
          const runtime = watchedRuntime();
          const toolApi = postgres(probeUrl(server.port), { max: 1, onnotice: () => undefined });
          try {
            // What postgres.js rejects the begin with on this client: PostgreSQL's refusal, the database in it.
            const raw = await toolApi
              .begin(() => Promise.resolve("never"))
              .then(
                () => {
                  throw new Error("the begin went");
                },
                (error: unknown) => error,
              );
            expect(raw, call).toMatchObject({ name: "PostgresError", code });
            expect(leaksOf(raw, secrets), call).toEqual(expect.arrayContaining(["database"]));

            const run = await callThroughFace(call, runtime.sql, toolApi);
            expectStartOutcome(run, call, { thrown: code }, secrets);
            expect(runtime.sent, call).toEqual([]);
          } finally {
            await Promise.all([toolApi.end({ timeout: 0 }), runtime.sql.end({ timeout: 0 })]);
          }
        }
      } finally {
        await server.close();
      }
    },
  );

  it(
    "where a call's errors had no transient, a start lost as it starts is thrown scrubbed under that call's own name (08006), never under withBusiness",
    SLOW,
    async () => {
      const { host, port } = localServer();
      const secrets = secretsOf({ "server host": host, "server port": port });
      for (const call of START_CALLS) {
        const checks = noTransientFor(call);
        expect(checks.check(call, "errors", LOST), call).not.toEqual([]);
        const runtime = watchedRuntime();
        const toolApi = lostAtBegin();
        try {
          const run = await callThroughFace(call, runtime.sql, toolApi.sql, checks);
          expectStartOutcome(run, call, { thrown: LOST.sqlstate }, secrets);
          expect(toolApi.sent.at(-1)?.trim(), call).toBe("begin");
          expect(runtime.sent, call).toEqual([]);
        } finally {
          await Promise.all([toolApi.sql.end({ timeout: 0 }), runtime.sql.end({ timeout: 0 })]);
        }
      }
    },
  );
});
