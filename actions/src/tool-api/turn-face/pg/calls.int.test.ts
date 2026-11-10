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
// The card's proof as far as main gives it: one turn commits under one turn id and one trace id, and replaying it writes
// nothing twice; limit 1 names no sign-up door yet (GATE_WAITING), so the turn commits its safety record alone, and the
// same tests expect S1-02's open question, its clock row and outbox-s1-02-sam-1 once limit 1 passes the door.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import { seal, unsealText, type WrappingKeys } from "../../../../../db/repo/sealing";
import { inRuntimeTransaction } from "../../../../../db/repo/targets";
import { TEST_OWNER_1 } from "../../../../../db/seeds/skeleton";
import { S1_01_IDS } from "../../../commit/core/test-support";
import { footprint, snapshot, type CommitDatabase } from "../../../commit/pg/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import { captureLog, checks, fakeBundles, sampleBundle } from "../../../frontier/assemble/test-support";
import { traceFor } from "../../test-support";
import { LIMIT_ONE_WAITS, SAM_KEY, commitRequestAfter, commitS101 } from "../calls-test-support";
import { NOTHING_OPEN_AT } from "../commit";
import { TurnFaceRefusedError } from "../errors";
import type { GateAndCommitCallAnswer, TurnFace } from "../turn-face";
import { pgReadOnlySealer, pgTurnCalls, pgTurnFace } from "./index";
import { openTurnFaceDatabase } from "./test-support";

const SLOW = { timeout: 60_000 };
const POOL = 4;
const TURN = "turn-s1-01-sam";
const TRACE = "trace-sam-0000";
const SAM = TEST_OWNER_1.personId;
/** A person with no sealing key, written for the sealer's refusal (a test id, no one's data). */
const NO_KEY = "person-t1141-no-key";

const { validator, checker } = checks();

/**
 * What main's commit cannot give yet, named and never faked (as GATE_WAITING): the safety service writes a sealed value
 * in K-04's bytea text form ("\x" and hex: domain/safety/record.ts default 8), and K-05's commitTurn passes it to
 * postgres.js as it is (db/repo/commit-turn.ts columnValues), whose bytea serializer takes a string's own bytes
 * (node_modules/postgres/src/types.js: '\\x' + Buffer.from(x)). So safety_outcomes.sealed_words holds the text's bytes,
 * not the sealed value, and does not open. Emptied once the commit writes the bytes themselves; the test then says so.
 */
const SEALED_WAITING: readonly { readonly waitsFor: string }[] = [
  {
    waitsFor:
      "commitTurn writes a bytea column given in K-04's text form as its bytes (a database task from T-1141's report)",
  },
];

/** The bytes of a hex string. */
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

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
    "one turn commits under one turn id and one trace id, as far as main's gate gives it; replaying it writes nothing twice",
    SLOW,
    async () => {
      const before = await snapshot(cdb);
      const first = await commitTurnOne();
      expect(first, JSON.stringify(first)).toMatchObject({
        result: "committed",
        turnId: TURN,
        repeated: false,
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
      const stored = new Uint8Array(record.sealed_words);
      let sealedValue: Uint8Array = stored;
      for (const waiting of SEALED_WAITING) {
        // Main stores the text form's own bytes ("\x01..."), which do not open (SEALED_WAITING); the sealed value inside
        // them is the sealer's, under Sam's own key. Once the commit stores the bytes, take SEALED_WAITING away.
        const asText = new TextDecoder().decode(stored);
        expect(asText, `the commit now stores the bytes: ${waiting.waitsFor}`).toMatch(/^\\x01[0-9a-f]+$/);
        await expect(unsealText(cdb.runtime, KEYS, SAM, stored)).rejects.toMatchObject({
          code: "bad_format",
        });
        sealedValue = fromHex(asText.slice(2));
      }
      const words = JSON.parse(await unsealText(cdb.runtime, KEYS, SAM, sealedValue)) as {
        labels: unknown[];
      };
      expect(words.labels).toHaveLength(1);

      const rows = await footprint(cdb, TURN);
      if (LIMIT_ONE_WAITS) {
        // Limit 1 stops the sign-up door (GATE_WAITING): no thread, question, clock row or outbox row yet.
        expect(rows).toMatchObject({ turns: 1, outbox: 0, questions: 0, clocks: 0, effects: 0 });
        expect(first).toMatchObject({
          parts: [{ part: 0, result: "stopped", stoppedBy: { limit: 1, action: "askedDecider" } }],
        });
      } else {
        // One open question, its clock row (and its never_delivered row once note 37's task merges: CQ-156 b), one
        // outbox row with no plan yet, each under the turn id.
        expect(rows).toMatchObject({ turns: 1, outbox: 1, questions: 1, effects: 0 });
        expect(rows.clocks).toBeGreaterThanOrEqual(1);
        const [outbox] = await cdb.db.sql<
          { id: string; state: string; channel: string; send_class: string }[]
        >`
          select id, state, channel, send_class from outbox_rows where turn_id = ${TURN}
        `;
        expect(outbox).toEqual({
          id: "outbox-s1-02-sam-1",
          state: "planned",
          channel: "imessage",
          send_class: "quick_reply",
        });
      }

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
