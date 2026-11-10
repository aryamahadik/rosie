// T-1141's integration proof of the turn face's compose input and finalize on local PostgreSQL (`npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/turn-face`), on the row K-05's own commit-s1-01-sam.json writes
// (S1-02's question, its clock row and outbox-s1-02-sam-1), committed for real by T-306's commitTurn in the world K-05
// v1.3's read-outbox-row-s1-02.json reads it in (K-04's business heads, Sam holding his owner role, his phone): the row
// read by Sam's role (K-05 v1.5 item 44's by-role branch, row-reader-s1-02-owner.json). The turn face's own commit of
// turn 1 on T-1148's seed, where Sam holds no role and the row is read by S1-02's sign-up line, is calls.int.test.ts's,
// with the whole turn to its final parts. Every read and write is real: the Tool API base on rosie_app, K-05 v1.3's
// readOutboxRow and readFixedLineFacts and finalize's writePlan on rosie_job, each its own transaction. Given: bundle v0
// (K-01 v1's bundle-v0-skeleton.json, which the row pins) through the frontier's fake bundles.
//
// The proofs: compose input gives K-09's compose-input-s1-02.json's input for the row (gentle while the sensitive switch
// is treated as on: DL-326 note b), with the inbound words only once the runtime handed them through gateAndCommit;
// finalize with finalize-pass.json's plan refuses Rosie's first text whole on bundle v0, lineNotInBundle for privacyLink
// (K-09 v1.5 open gap 121), and writes nothing; on bundle v0 as published (T-1146) it writes the row's final parts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commitTurn } from "../../../../../db/repo/commit-turn";
import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import type { WrappingKeys } from "../../../../../db/repo/sealing";
import { S1_01_IDS } from "../../../commit/core/test-support";
import { k05Exchange } from "../../../commit/test-support";
import {
  openCommitDatabase,
  rowOf,
  seed,
  seedRows,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import { FixedLineRefusedError } from "../../../finalize/fixed-lines";
import { captureLog, checks, fakeBundles, sampleBundle } from "../../../frontier/assemble/test-support";
import { fixture, traceFor } from "../../test-support";
import { SAM_KEY, commitRequestAfter, publishedBundleV0 } from "../calls-test-support";
import { NOTHING_OPEN_AT } from "../commit";
import type { TurnFace } from "../turn-face";
import { pgTurnCalls, pgTurnFace } from "./index";

const SLOW = { timeout: 60_000 };
const POOL = 4;
const ROW = "outbox-s1-02-sam-1";

type Json = Record<string, unknown>;

const { validator, checker } = checks();

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

/** K-05 v1.3 read-outbox-row-s1-02.json's world (its given k04Seeds), in which K-05's turn 1 commit is written. */
const SEEDS = ["seed-bundle-registry.json", "seed-person-roles.json", "seed-phone-chat-open.json"];

let cdb: CommitDatabase;
let face: TurnFace;

beforeAll(async () => {
  cdb = await openCommitDatabase("turn_face_rows", POOL);
  await seed(cdb, SEEDS);
  const exchange = k05Exchange("commit-s1-01-sam.json") as unknown as {
    given: { now: string };
    request: Parameters<typeof commitTurn>[1];
  };
  const committed = await commitTurn(cdb.runtime, exchange.request, { now: new Date(exchange.given.now) });
  if (!("result" in committed)) throw new Error("K-05's turn 1 commit did not commit");
  // Sam's key, made as the gateway makes it at the first sight of his number (K-05 v1.2 item 29).
  const handle = seedRows(SEEDS).find((row) => row.table === "handles" && row.values.id === "handle-sam");
  const address = handle?.values.address;
  if (typeof address !== "string") throw new Error("K-04's seed gives Sam's handle");
  const sighted = await handleSealingKey(cdb.runtime, KEYS, {
    handle: { kind: "phone", address },
    newHandleId: "handle-t1141-unused",
    newPersonId: "person-t1141-unused",
    wrappingKeyName: "SEALING_WRAP_KEY",
  });
  if (!("result" in sighted.outcome)) throw new Error("first sight gave no key");
  const bundles = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  face = pgTurnFace(cdb.runtime, {
    bundles,
    validator,
    checker,
    log: captureLog().sink,
    calls: pgTurnCalls(cdb.runtime, cdb.toolApi, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
      turnKey: () => SAM_KEY,
      safetyExtra: { ids: S1_01_IDS },
      finalizeLog: () => undefined,
    }),
  });
}, 120_000);

afterAll(async () => {
  await cdb.close();
});

const compose = (): { request: Json; outcome: { input: Json } } =>
  fixture("compose-input-s1-02.json") as { request: Json; outcome: { input: Json } };

describe("compose input and finalize on PostgreSQL, on the row turn 1's commit wrote (T-1141)", () => {
  it(
    "compose input gives compose-input-s1-02.json's input (gentle: DL-326 note b), its inbound words only once the runtime handed them through gateAndCommit",
    SLOW,
    async () => {
      const { request, outcome } = compose();
      const before = await face.composeInput(structuredClone(request), traceFor(request).trace);
      expect(validator.check("composeInput", "response", before)).toEqual([]);
      expect(before).toEqual({
        result: "compose",
        input: { ...outcome.input, situation: "gentle", inbound: null },
      });

      // The turn's gateAndCommit hands the face its words: K-05 answers the first commit (the same turn id), repeated.
      const turn = commitRequestAfter(undefined);
      const again = await face.gateAndCommit(turn, NOTHING_OPEN_AT, traceFor(turn).trace);
      expect(again).toMatchObject({ result: "committed", turnId: "turn-s1-01-sam", repeated: true });

      const after = await face.composeInput(structuredClone(request), traceFor(request).trace);
      expect(after).toEqual({ result: "compose", input: { ...outcome.input, situation: "gentle" } });
    },
  );

  it("a call under another business's scope reads nothing of this row: notFound", SLOW, async () => {
    const { request } = compose();
    const other = structuredClone(request) as Json & { caller: Json };
    other.caller.businessId = "biz-yoga-studio";
    const answer = await face.composeInput(other, traceFor(other).trace);
    expect(answer).toEqual({ error: "notFound", table: "outbox_rows", rowId: ROW });
  });

  it(
    "finalize with finalize-pass.json's plan refuses Rosie's first text whole on bundle v0 (lineNotInBundle: privacyLink) and writes nothing",
    SLOW,
    async () => {
      const before = await rowOf(cdb, "outbox_rows", ROW, ["state", "plan", "final_parts"]);
      const finalize = fixture("finalize-pass.json") as { request: Json };
      await expect(
        face.finalizeMessage(structuredClone(finalize.request), traceFor(finalize.request).trace),
      ).rejects.toBeInstanceOf(FixedLineRefusedError);
      await expect(
        face.finalizeMessage(structuredClone(finalize.request), traceFor(finalize.request).trace),
      ).rejects.toMatchObject({ fault: "lineNotInBundle", line: "privacyLink" });
      expect(before).toEqual({ version: 1, state: "planned", plan: null, final_parts: null });
      expect(await rowOf(cdb, "outbox_rows", ROW, ["state", "plan", "final_parts"])).toEqual(before);
    },
  );
});

describe("finalize on PostgreSQL with bundle v0 as published with privacyLink (T-1146): the row's final parts written", () => {
  /** This describe's own schema: the same world, K-05's turn 1 commit pinned to bundle v0 as bundles/v0 publishes it. */
  let v0: CommitDatabase;
  let v0Face: TurnFace;
  const published = publishedBundleV0();
  const bundleId = published.manifest.bundleId as { hash: string; build: number };

  beforeAll(async () => {
    v0 = await openCommitDatabase("turn_face_rows_v0", POOL);
    await seed(v0, SEEDS);
    await v0.db.sql`
      insert into bundles (hash, build, manifest_key, built_at, published_at, active)
      values (${bundleId.hash}, ${bundleId.build}, ${`bundle/${bundleId.hash}/${String(bundleId.build)}/manifest`},
              '2026-11-10T08:00:00Z', '2026-11-10T08:05:00Z', false)
    `;
    const exchange = k05Exchange("commit-s1-01-sam.json") as unknown as {
      given: { now: string };
      request: Parameters<typeof commitTurn>[1];
    };
    // K-05's own turn 1 commit, its turn pinned to the published bundle (the one id it names), nothing else changed.
    const request = { ...exchange.request, turn: { ...exchange.request.turn, bundleId } };
    const committed = await commitTurn(v0.runtime, request, { now: new Date(exchange.given.now) });
    if (!("result" in committed)) throw new Error("K-05's turn 1 commit did not commit under bundle v0");
    const bundles = fakeBundles(published);
    v0Face = pgTurnFace(v0.runtime, {
      bundles,
      validator,
      checker,
      log: captureLog().sink,
      calls: pgTurnCalls(v0.runtime, v0.toolApi, {
        bundles,
        wrappingKeys: KEYS,
        stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
        telling: NOT_TOLD_YET,
        finalizeNow: () => "2026-10-19T18:05:07Z",
        finalizeLog: () => undefined,
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await v0.close();
  });

  it(
    "finalize-pass.json's plan sends: the final parts carry the bundle's opener and privacy link (Q-30), written with the plan by K-05's writePlan",
    SLOW,
    async () => {
      const finalize = fixture("finalize-pass.json") as { request: Json };
      const answer = (await v0Face.finalizeMessage(
        structuredClone(finalize.request),
        traceFor(finalize.request).trace,
      )) as unknown as Json & { finalParts: { fixedLines: string[]; sends: { text: string }[] } };
      expect(validator.check("finalizeMessage", "response", answer)).toEqual([]);
      expect(answer.outcome).toBe("send");
      // Sam's number had the opt-out line delivered before (K-04's seed-phone-chat-open.json), so it does not ride again.
      expect(answer.finalParts.fixedLines).toEqual(["opener", "privacyLink"]);
      const text = answer.finalParts.sends[0]?.text ?? "";
      expect(text.startsWith("This is Rosie, the automated booking assistant for Lee's Barbershop.")).toBe(
        true,
      );
      expect(text.split("\n").at(-1)).toBe("Privacy notice: rosfield.com/test/privacy");

      const row = await rowOf(v0, "outbox_rows", ROW, ["state", "final_parts"]);
      expect(row).toEqual({ version: 2, state: "checked", final_parts: answer.finalParts });

      // A second finalize of the same row answers alreadyPlanned with the parts written, and writes nothing more.
      const again = await v0Face.finalizeMessage(
        structuredClone(finalize.request),
        traceFor(finalize.request).trace,
      );
      expect(again).toEqual({ error: "alreadyPlanned", outboxRowId: ROW, finalParts: answer.finalParts });
      expect(await rowOf(v0, "outbox_rows", ROW, ["state", "final_parts"])).toEqual(row);
    },
  );
});
