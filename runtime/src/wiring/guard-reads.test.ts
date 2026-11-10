// T-556's join, hop 5 of D-017 (C-051; 02-contracts section 11, 'Guard: keywords, then targets': K-01 keywords; K-04
// phones, roles, open questions and booking heads through K-05 v1.2), under Node (Vitest project "unit"): the root's two
// ports this hop joins (./real.ts realBundles and realTargets), fed by the K-05 doubles of ./test-support.ts, and how the
// root binds them in each environment.
//
//   - The bundle port gives bundle v0 as bundles/v0 publishes it. Read as the pin reads it (the active id, then the
//     manifest under it from PostgreSQL's copy, checked against the id: T-249's own reader), its keyword list (K-01 v1
//     lists.keywords, read by the guard's own keywordsOf) is K-01's keywords.json: START, HELP and the 16 opt-out words,
//     CANCEL and CANCELAR flagging the visit. JOIN is none of them; a bare HELP is one.
//   - The targets port gives test owner 1's targets as targets-first-text.json does (no role, no open question, no
//     booking, no phone row), held to K-05 v1.2's schema, for the handle and person T-1148's seed writes
//     (db/seeds/skeleton.ts); the guard makes them K-09 v1's guardTargets with no target: the doors.
//   - With no database bound (the Worker until T-567), each port fails closed before any call, naming the call only.
//   - The root binds both real under test and on staging, closed in production; install() hands them to the pin and the
//     guard. Test values only (rule 9): the master's sample cast and the fixtures' ids.
import keywordsJson from "@rosie/contracts/bundle/fixtures/keywords.json";
import activeBundleJson from "@rosie/contracts/data-access/fixtures/active-bundle.json";
import targetsFirstText from "@rosie/contracts/data-access/fixtures/targets-first-text.json";
import { SKELETON_ROWS, TEST_OWNER_1 as SEEDED_OWNER } from "@rosie/db/seeds/skeleton";
import { afterEach, describe, expect, it } from "vitest";

import { BundleReader, readManifest } from "../bundle/values";
import { DEFAULT_BUNDLE_ID, readBundleId } from "../gateway/answer";
import { keywordsOf } from "../guard/keywords";
import { readTargets } from "../guard/targets";
import { contractProblems, K05_V1_2, K09_V1 } from "../guard/test-support";
import {
  composeRoot,
  NoDatabaseError,
  NotJoinedError,
  realBundles,
  realTargets,
  workerRoot,
  type BundleReadCalls,
  type HandleTargetsCall,
} from "./index";
import {
  BUNDLE_V0,
  fakeBundleReads,
  fakeHandleTargets,
  HELP_TEXT,
  JOIN_TEXT,
  skeletonFakes,
  TEST_OWNER_1,
} from "./test-support";

const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };
/** bundle v0's manifest key (K-01 v1 kvKey). */
const MANIFEST_KEY = `bundle/${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}/manifest`;
/** The doors: no target at all (arch 03 line 165), K-09 v1 guardTargets. */
const NO_TARGET = { roles: [], openQuestionIds: [], bookingIds: [], noTarget: true };

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("the K-05 doubles the joined ports are fed", () => {
  it("hold test owner 1 as T-1148's seed writes him: handle-sam at the fictional 555-0100, linked to person-sam, under Lee's Barbershop", () => {
    expect(TEST_OWNER_1).toMatchObject({
      handleId: SEEDED_OWNER.handleId,
      personId: SEEDED_OWNER.personId,
      businessId: SEEDED_OWNER.businessId,
    });
    expect(SKELETON_ROWS.handles).toEqual([
      { id: TEST_OWNER_1.handleId, kind: TEST_OWNER_1.handle.kind, address: TEST_OWNER_1.handle.address },
    ]);
    expect(SKELETON_ROWS.person_handles).toEqual([
      { person_id: TEST_OWNER_1.personId, handle_id: TEST_OWNER_1.handleId },
    ]);
  });

  it("answer test owner 1's handle as targets-first-text.json does, under his ids and held to K-05 v1.2's schema, and any other handle notFound", async () => {
    const targets = fakeHandleTargets();

    const answer = await targets.call({ handleId: TEST_OWNER_1.handleId });

    // The fixture's targets are none: one person with no role, no open question, no booking, no phone row.
    expect(targetsFirstText.outcome).toMatchObject({
      persons: [{ roles: [] }],
      openQuestions: [],
      bookings: [],
      phone: null,
    });
    expect(answer).toEqual({
      ...targetsFirstText.outcome,
      handleId: TEST_OWNER_1.handleId,
      persons: [{ personId: TEST_OWNER_1.personId, roles: [] }],
    });
    expect(contractProblems(K05_V1_2, "handleTargets.response", answer)).toEqual([]);
    expect(await targets.call({ handleId: "handle-alex" })).toEqual({
      error: "notFound",
      table: "handles",
      rowId: "handle-alex",
    });
    expect(targets.requests).toEqual([{ handleId: TEST_OWNER_1.handleId }, { handleId: "handle-alex" }]);
  });

  it("hold bundle v0 as bundles/v0 publishes it: read as the pin reads it, its manifest is its id's, every part is the bytes it lists, and its keyword list is K-01's", async () => {
    const reads = fakeBundleReads();
    const bundles = realBundles({ calls: reads.calls });

    expect(await bundles.registry.readActiveBundle({})).toEqual({
      ...activeBundleJson.outcome,
      bundleId: BUNDLE_V0,
      manifestKey: MANIFEST_KEY,
    });
    // The pin's own reader (T-249): KV left out, as in the Workers pool, so the manifest comes from PostgreSQL's copy.
    const reader = new BundleReader(bundles.registry, null);
    const manifest = await readManifest(reader, BUNDLE_V0);
    expect(reader.reads()).toEqual([{ key: MANIFEST_KEY, kind: "manifest", from: "postgres" }]);
    expect(manifest.bundleId).toEqual(BUNDLE_V0);
    for (const listed of manifest.storage.values) {
      expect(await bundles.registry.readBundleValue({ key: listed.key })).toMatchObject({
        result: "value",
        value: { key: listed.key, kind: listed.kind, bytes: listed.bytes, sha256: listed.sha256 },
      });
    }

    // The guard's keyword list is that manifest's: START, HELP, then the 16 opt-out words (K-01 keywords.json).
    const list = keywordsOf(manifest);
    expect(keywordsJson.optOut).toHaveLength(16);
    expect(list.all()).toEqual([
      { kind: "start", word: keywordsJson.start, flagsVisit: false },
      { kind: "help", word: keywordsJson.help, flagsVisit: false },
      ...keywordsJson.optOut.map((word) => ({
        kind: "stop",
        word,
        flagsVisit: keywordsJson.flagsVisit.includes(word),
      })),
    ]);
    expect(list.match(JOIN_TEXT)).toBeNull();
    expect(list.match(HELP_TEXT)).toEqual({ kind: "help", word: "HELP", flagsVisit: false });
    expect(await bundles.registry.readBundleValue({ key: `${MANIFEST_KEY}-missing` })).toEqual({
      error: "notFound",
      table: "bundle_values",
      rowId: `${MANIFEST_KEY}-missing`,
    });
  });
});

describe("the joined ports: K-05's calls with their database bound, or fail closed", () => {
  it("with no database bound (the Worker until T-567), every read fails closed before any call, naming the call and no value", async () => {
    const bundles = realBundles({ calls: null });
    const targets = realTargets({ call: null });

    await expect(bundles.registry.readActiveBundle({})).rejects.toThrow(
      new NoDatabaseError("readActiveBundle"),
    );
    await expect(bundles.registry.readBundleValue({ key: MANIFEST_KEY })).rejects.toThrow(
      new NoDatabaseError("readBundleValue"),
    );
    await expect(targets.handleTargets({ handleId: TEST_OWNER_1.handleId })).rejects.toThrow(
      new NoDatabaseError("handleTargets"),
    );
    expect(bundles.kv).toBeUndefined();
  });

  it("hands K-05 exactly the call's request and gives its answer back as it is: a transient answer, a notFound, nothing changed", async () => {
    const asked: unknown[] = [];
    const transient = { error: "transient", sqlstate: "40001" } as const;
    const calls: BundleReadCalls = {
      readActiveBundle: () => Promise.resolve(transient),
      readBundleValue: (request) => {
        asked.push(request);
        return Promise.resolve({ error: "notFound", table: "bundle_values", rowId: request.key });
      },
    };
    const call: HandleTargetsCall = (request) => {
      asked.push(request);
      return Promise.resolve(transient);
    };

    expect(await realBundles({ calls }).registry.readActiveBundle({})).toEqual(transient);
    expect(await realBundles({ calls }).registry.readBundleValue({ key: MANIFEST_KEY })).toEqual({
      error: "notFound",
      table: "bundle_values",
      rowId: MANIFEST_KEY,
    });
    // A request carrying more than K-05's fields reaches K-05 with its fields alone (K-05 requests: no other property).
    const wider = { handleId: TEST_OWNER_1.handleId, words: "JOIN" } as unknown as { handleId: string };
    expect(await realTargets({ call }).handleTargets(wider)).toEqual(transient);
    expect(asked).toEqual([{ key: MANIFEST_KEY }, { handleId: TEST_OWNER_1.handleId }]);
  });
});

describe("the root binds them", () => {
  it("under test: real, fed by the K-05 doubles; the gateway names bundle v0's id, and install() hands the targets port to the guard, which reads the doors for test owner 1", async () => {
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: VARS,
      bundleReads: fakes.bundleReads.calls,
      handleTargets: fakes.handleTargets.call,
    });

    expect(root.bindings.filter((binding) => ["bundles", "targets"].includes(binding.port))).toEqual([
      { port: "bundles", implementation: "real" },
      { port: "targets", implementation: "real" },
    ]);
    expect(await readBundleId(root.gateway)).toEqual(BUNDLE_V0);
    expect(fakes.bundleReads.reads).toEqual([{ call: "readActiveBundle", key: null }]);

    expect(await readTargets(TEST_OWNER_1.handleId)).toEqual({ result: "failed", errorCode: "unwired" });
    restore = root.install();
    const read = await readTargets(TEST_OWNER_1.handleId);
    expect(read).toEqual({
      result: "targets",
      targets: NO_TARGET,
      counts: { roles: 0, openQuestions: 0, bookings: 0 },
    });
    if (read.result !== "targets") throw new Error("no targets");
    expect(contractProblems(K09_V1, "guardTargets", read.targets)).toEqual([]);
    expect(fakes.handleTargets.requests).toEqual([{ handleId: TEST_OWNER_1.handleId }]);
  });

  it("on the Worker's staging: real, fed no database (until T-567): the active bundle id and the targets read fail closed, and the gateway's trace names bundle v0's stand-in", async () => {
    const root = workerRoot({ ENVIRONMENT: "staging", BASE_PATH: "", DB_SCHEMA: "" });

    expect(root.bindings.filter((binding) => ["bundles", "targets"].includes(binding.port))).toEqual([
      { port: "bundles", implementation: "real" },
      { port: "targets", implementation: "real" },
    ]);
    await expect(root.ports.bundles.registry.readActiveBundle({})).rejects.toThrow(
      new NoDatabaseError("readActiveBundle"),
    );
    await expect(root.ports.targets.handleTargets({ handleId: TEST_OWNER_1.handleId })).rejects.toThrow(
      new NoDatabaseError("handleTargets"),
    );
    expect(await readBundleId(root.gateway)).toEqual(DEFAULT_BUNDLE_ID);
  });

  it("on the Worker's production: closed", async () => {
    const root = workerRoot({ ENVIRONMENT: "production", BASE_PATH: "", DB_SCHEMA: "" });

    expect(root.bindings.filter((binding) => ["bundles", "targets"].includes(binding.port))).toEqual([
      { port: "bundles", implementation: "closed" },
      { port: "targets", implementation: "closed" },
    ]);
    await expect(root.ports.bundles.registry.readActiveBundle({})).rejects.toThrow(
      new NotJoinedError("bundles"),
    );
    await expect(root.ports.targets.handleTargets({ handleId: TEST_OWNER_1.handleId })).rejects.toThrow(
      new NotJoinedError("targets"),
    );
  });
});
