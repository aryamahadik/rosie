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
// open gap 121), so that turn is pinned to bundle v0 as bundles/v0 publishes it (T-1146), its own schema's registry row.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import { seal, unsealText, type WrappingKeys } from "../../../../../db/repo/sealing";
import { inRuntimeTransaction } from "../../../../../db/repo/targets";
import { TEST_OWNER_1 } from "../../../../../db/seeds/skeleton";
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
} from "../../../frontier/assemble/test-support";
import { fixture, traceFor } from "../../test-support";
import { SAM_KEY, commitRequestAfter, commitS101, publishedBundleV0 } from "../calls-test-support";
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

describe("the card's integration line: one turn from gate and commit to finalize's final parts, on PostgreSQL (bundle v0 as published)", () => {
  /** This describe's own schema: T-1148's seed, Sam's key, and bundle v0 as published in the bundle registry. */
  let whole: CommitDatabase;
  let wholeFace: TurnFace;
  const published: BundleDocument = publishedBundleV0();
  const bundleId = published.manifest.bundleId as { hash: string; build: number };

  /** commit-s1-01.json's request, the turn pinned to bundle v0 as published: its turn's, context's and decide's id. */
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

  /** The turn's three calls after the frontier, in turn order, each on the same turn's trace. */
  async function runTurn() {
    const request = pinnedRequest();
    const committed = await wholeFace.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
    const compose = fixture("compose-input-s1-02.json") as { request: Json };
    const composed = await wholeFace.composeInput(
      structuredClone(compose.request),
      traceFor(compose.request).trace,
    );
    const finalize = fixture("finalize-pass.json") as { request: Json };
    const finalized = await wholeFace.finalizeMessage(
      structuredClone(finalize.request),
      traceFor(finalize.request).trace,
    );
    return { committed, composed, finalized };
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
      expect(validator.check("finalizeMessage", "response", first.finalized)).toEqual([]);
      const finalized = first.finalized as unknown as Json & {
        finalParts: { fixedLines: string[]; sends: { text: string }[] };
      };
      expect(finalized.outcome).toBe("send");
      // T-1148's seed holds no phone row, so the opt-out line was never delivered: it rides with the opener and the link.
      expect(finalized.finalParts.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
      expect((finalized.finalParts.sends[0]?.text ?? "").split("\n").at(-1)).toBe(
        "Privacy notice: rosfield.com/test/privacy",
      );

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
