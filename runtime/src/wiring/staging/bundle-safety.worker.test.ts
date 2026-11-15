// T-1397: staging's bundle-backed BundleSafety (./bundle-safety.ts; the D-017 path audit's P3b; the lead's notes DL-341,
// DL-351, DL-757 and DL-761), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key BUNDLE_SAFETY).
// This file's database is migrated, holds bundle v0 as the rig publishes it, active, and the bundles ./bundle-safety.seed.ts
// writes beside it (none active). Every K-05 read here is db/repo's own (K-05 v1 item 7, readActiveBundle and
// readBundleValue) on a client of T-1254's handle over this file's job pair (HYPERDRIVE_JOB_BUNDLE_SAFETY, as
// rosie_worker_job), through ./part.ts stagingDb: the bundle port P2b binds (T-1395), made here by the test. The actor's
// BUNDLES KV is a double the test fills as a publish fills it.
//
//   - bundle v0 passes the check, read from PostgreSQL's copy while the KV is empty and from the KV once it is filled, and
//     the three reads then answer from v0's own manifest;
//   - through checkedPin and the real pin over a HandleActor's storage: v0 is pinned, each refused bundle is not;
//   - before any check passed each read throws its named error; the ruled seam (DL-757, option (c)): the first safety
//     read in a new isolate, with no pin before it, reads its bundle's lines and gets a verdict, and a bundle whose check
//     fails or that cannot be read gives no lines and fails the read closed before any model call;
//   - across a switch the reads answer for the bundle whose check passed last, which the adapter names;
//   - a read that fails inside the check (the pool's own HYPERDRIVE_JOB, on rosie_rig_none) rejects and keeps nothing;
//   - the words rule agrees with the core's (pinnedSafetyLines); production builds none; nothing logged holds a word.
// The active id of a bundle other than v0 is answered by a stand-in for K-05's readActiveBundle (K-05's own shape, as
// ../../bundle/test-support.ts answers one): this file's logins cannot switch the active bundle, which is the deploy's
// step; every value is still read from PostgreSQL's copy through the handle. Test values only (rule 9): the master's
// sample words as K-01's fixtures and bundle v0 carry them, and made-up ids.
import type { FrontierBundles } from "@rosie/actions/src/frontier/assemble/types";
import { NotBuiltError } from "@rosie/actions/src/tool-api/errors";
import { pinnedSafetyLines } from "@rosie/actions/src/tool-api/turn-face/commit";
import { readActiveBundle, readBundleValue } from "@rosie/db/repo/bundles";
import { runInDurableObject } from "cloudflare:test";
import { env as poolEnv, exports } from "cloudflare:workers";
import { afterEach, describe, expect, inject, it, vi } from "vitest";

import type { HandleActor } from "../../actor";
import { BundlePins, type PinEntry, type PinRequest } from "../../bundle";
import type { BundleDeps, BundleKv } from "../../bundle/types";
import { SAFETY_OUTCOMES, type SafetyReadRequest } from "../../safety/types";
import { isLabel, type BundleId, type Span } from "../../trace";
import { NoStateReadError, realBundles, type BundleReadCalls } from "../real";
import { composeRoot, type Root } from "../root";
import { JOIN_TEXT, skeletonFakes } from "../test-support";
import {
  answeringBundleOf,
  BUNDLE_CHECKS,
  bundleBackedSafety,
  BundleRefusedError,
  BundleUnreadableError,
  fixedLinesWithWords,
  KEPT_BUNDLES,
  stagingBundleSafety,
  type BundleBackedLines,
  type BundleSafetyCheckLine,
} from "./bundle-safety";
import {
  bundleOf,
  MINI_FLOW_A,
  seedBundles,
  V0_FLOW_A,
  V0_ID,
  V0_MANIFEST,
  withoutWords,
  type SeedBundle,
  type SeedBundleName,
} from "./bundle-safety.seed";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { NO_STAGING_INPUTS, stagingOptions, type StagingBuilders } from "./options";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { NO_ROW_INPUTS } from "./tool-api-rows";

type Json = Record<string, unknown>;

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "BUNDLE_SAFETY";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;

const TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
const EVENT = "evt-sam-s1-01";

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

/** Staging's vars, as the pool gives them. */
const STAGING_VARS = { ENVIRONMENT: "staging", BASE_PATH: "/test", DB_SCHEMA: "", GIT_SHA: "test-sha" };
const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };

/** The Worker's env over one job binding (and this file's app binding, which nothing here reads). */
function envOver(job: Hyperdrive): StagingEnv {
  return { ...STAGING_VARS, HYPERDRIVE_JOB: job, HYPERDRIVE_APP: poolBinding(APP) };
}

// ---- what the file's tests log ----------------------------------------------------------------------------------------

/** Every line any test wrote: the adapter's check lines, the handle's dbCall lines and the spans (console.log). */
const everyLine: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

/** Keeps what the root logs (its spans: one JSON line each on console.log) among the file's lines. */
function keepConsole(): void {
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    everyLine.push(args.map((arg) => String(arg)).join(" "));
  });
}

// ---- the bundle port over this file's job pair --------------------------------------------------------------------------

interface CountedReads {
  readonly calls: BundleReadCalls;
  /** Each K-05 call made, in order: its name and, for a value, the key's part (manifest, flow/A). */
  readonly made: string[];
}

const partOf = (key: string): string => key.split("/").slice(3).join("/");
const keyIn = (bundleId: BundleId, part: string): string =>
  `bundle/${bundleId.hash}/${String(bundleId.build)}/${part}`;

/** T-1254's handle over a job binding, each call's dbCall line kept. */
function dbOver(job: Hyperdrive): StagingDb {
  return stagingDb(envOver(job), { write: (line) => everyLine.push(line) });
}

/** K-05 v1 item 7's two reads, db/repo's own, each on a client of the handle (the runtime side). */
function readsOver(db: StagingDb): CountedReads {
  const made: string[] = [];
  return {
    made,
    calls: {
      readActiveBundle: () => {
        made.push("readActiveBundle");
        return db.runtime("readActiveBundle", (sql) => readActiveBundle(sql));
      },
      readBundleValue: (request) => {
        made.push(`readBundleValue ${partOf(request.key)}`);
        return db.runtime("readBundleValue", (sql) => readBundleValue(sql, request));
      },
    },
  };
}

/** The same reads with `bundleId` answered as the active one (K-05's readActiveBundle shape; the top of this file). */
function activeAs(calls: BundleReadCalls, bundleId: BundleId): BundleReadCalls {
  return {
    readActiveBundle: () =>
      Promise.resolve({
        result: "active",
        bundleId: { hash: bundleId.hash, build: bundleId.build },
        manifestKey: keyIn(bundleId, "manifest"),
        activatedAt: "2026-11-14T12:00:00Z",
      }),
    readBundleValue: calls.readBundleValue,
  };
}

/** The reads of a port nothing may reach: each call is kept and fails. */
function noReads(): CountedReads {
  const made: string[] = [];
  const refuse = (call: string): Promise<never> => {
    made.push(call);
    return Promise.reject(new Error("no K-05 read is expected here"));
  };
  return {
    made,
    calls: {
      readActiveBundle: () => refuse("readActiveBundle"),
      readBundleValue: (request) => refuse(`readBundleValue ${partOf(request.key)}`),
    },
  };
}

// ---- the actor's BUNDLES KV, as a double --------------------------------------------------------------------------------

interface KvDouble {
  readonly kv: BundleKv;
  readonly held: Map<string, string>;
  /** Each key asked, in order. */
  readonly gets: string[];
  /** Holds every value of these bundles, as a publish writes them. */
  fill(...bundles: readonly Pick<SeedBundle, "values">[]): void;
}

function kvDouble(): KvDouble {
  const held = new Map<string, string>();
  const gets: string[] = [];
  return {
    held,
    gets,
    kv: {
      get(key) {
        gets.push(key);
        return Promise.resolve(held.get(key) ?? null);
      },
    },
    fill(...bundles) {
      for (const bundle of bundles) for (const value of bundle.values) held.set(value.key, value.text);
    },
  };
}

/** Bundle v0's own values as the rig published them: bundles/v0's manifest and flow A, as JSON text. */
const V0: Pick<SeedBundle, "bundleId" | "manifest" | "flows" | "values"> = {
  bundleId: V0_ID,
  manifest: V0_MANIFEST,
  flows: { A: V0_FLOW_A },
  values: [
    {
      key: keyIn(V0_ID, "manifest"),
      kind: "manifest",
      text: JSON.stringify(V0_MANIFEST),
      bytes: 0,
      sha256: "",
    },
    { key: keyIn(V0_ID, "flow/A"), kind: "flow", text: JSON.stringify(V0_FLOW_A), bytes: 0, sha256: "" },
  ],
};

// ---- the adapter under test ---------------------------------------------------------------------------------------------

interface Rig {
  readonly adapter: BundleBackedLines;
  /** The adapter's check lines, parsed, in order. */
  readonly lines: BundleSafetyCheckLine[];
  readonly kv: KvDouble;
  readonly reads: CountedReads;
  /** The bundle port the pin's check is handed (../real.ts realBundles over the reads: no KV of its own). */
  readonly port: BundleDeps;
}

/** One adapter, as a fresh isolate's: over this file's job pair unless `reads` says otherwise, the KV empty. */
function rig(reads: CountedReads = readsOver(dbOver(poolBinding(JOB)))): Rig {
  const kv = kvDouble();
  const lines: BundleSafetyCheckLine[] = [];
  const env = envOver(poolBinding(JOB));
  const adapter = bundleBackedSafety(
    { env, db: dbOver(poolBinding(JOB)), kv: () => kv.kv, bundleReads: reads.calls },
    {
      write: (line) => {
        everyLine.push(line);
        lines.push(JSON.parse(line) as BundleSafetyCheckLine);
      },
    },
  );
  return { adapter, lines, kv, reads, port: realBundles({ calls: reads.calls }) };
}

/** A root for staging over the adapter and its reads, with the recorded-model double's safety readers. */
function rootOver(
  made: Rig,
  bundleReads: BundleReadCalls = made.reads.calls,
): { root: Root; models: ReturnType<typeof skeletonFakes>["models"] } {
  const { models } = skeletonFakes();
  const root = composeRoot({
    environment: "staging",
    actors: null,
    vars: VARS,
    bundleReads,
    bundleSafety: made.adapter,
    safetyReaders: models.readers,
  });
  return { root, models };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

function thrownBy(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to throw");
}

/** Each of the three reads throws its named error, naming the read: no bundle answers. */
function expectNoBundleAnswers(
  adapter: Pick<BundleBackedLines, "fixedLine" | "outcomeLine" | "dangerWords">,
) {
  const reads = {
    fixedLine: () => adapter.fixedLine("safetyEmergency"),
    outcomeLine: () => adapter.outcomeLine("An emergency"),
    dangerWords: () => adapter.dangerWords(),
  };
  for (const [name, read] of Object.entries(reads)) {
    const thrown = thrownBy(read);
    expect(thrown, name).toBeInstanceOf(NoStateReadError);
    expect((thrown as Error).message, name).toBe(new NoStateReadError(name).message);
  }
}

interface FixedLineEntry {
  readonly id: string;
  readonly lang: string;
  readonly status: string;
  readonly text: string | null;
}

/** A manifest's fixed lines, as it lists them. */
const linesIn = (manifest: Json): FixedLineEntry[] =>
  (manifest.lists as { fixedLines: { lines: FixedLineEntry[] } }).fixedLines.lines;

/** The words a manifest holds for a fixed line, read here from the manifest itself: its English, asWritten line's text. */
function wordsIn(manifest: Json, id: string): string {
  const line = linesIn(manifest).find((entry) => entry.id === id && entry.lang === "en");
  if (line?.status !== "asWritten" || line.text === null)
    throw new Error(`the manifest holds no words for ${id}`);
  return line.text;
}

/** Every word-bearing text of the bundles this file reads: none may reach a log line, a span or an error. */
function everyWordsOf(bundles: readonly Pick<SeedBundle, "manifest" | "flows">[]): string[] {
  const texts = new Set<string>();
  for (const bundle of bundles) {
    for (const line of linesIn(bundle.manifest)) if (line.text !== null) texts.add(line.text);
    for (const flow of Object.values(bundle.flows)) {
      const steps = (flow as { steps?: Record<string, { say?: { text?: string; plainText?: string }[] }> })
        .steps;
      for (const step of Object.values(steps ?? {})) {
        for (const message of step.say ?? []) {
          if (typeof message.text === "string") texts.add(message.text);
          if (typeof message.plainText === "string") texts.add(message.plainText);
        }
      }
    }
  }
  // Texts of several words: a label has no space, so such a text is in a log line only if it was logged.
  return [...texts].filter((text) => text.trim().includes(" "));
}

/** A log line as JSON, or null for a line that is not JSON. */
function parsedLine(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

const seeded = await seedBundles();
const REFUSED_FOR_WORDS: readonly (readonly [SeedBundleName, string])[] = [
  ["noEmergencyWords", BUNDLE_CHECKS.safetyEmergency],
  ["noCrisisWords", BUNDLE_CHECKS.safetyCrisis],
  ["noAskWords", BUNDLE_CHECKS.safetyAsk],
];
const REFUSED: readonly (readonly [SeedBundleName, string])[] = [
  ...REFUSED_FOR_WORDS,
  ["harmStep", BUNDLE_CHECKS.hotline],
];

function request(bundleId: BundleId): SafetyReadRequest {
  return {
    eventId: EVENT,
    source: "text",
    traceId: TRACE,
    bundleId,
    words: { body: JOIN_TEXT, subject: null },
  };
}

// ---- the rig ----------------------------------------------------------------------------------------------------------

describe("this file's database and its seed", () => {
  it("the rig made this file's database, with bundle v0 active and the seeded bundles in PostgreSQL's copy, none of them active", async () => {
    expect(inject("rosieRigDatabases")?.[KEY]).toMatch(/^rosie_rig_[0-9a-f]{8}_bundle_safety$/);
    const reads = readsOver(dbOver(poolBinding(JOB)));

    expect(await reads.calls.readActiveBundle()).toMatchObject({
      result: "active",
      bundleId: V0_ID,
      manifestKey: keyIn(V0_ID, "manifest"),
    });
    // Each seeded bundle's manifest, as the seed wrote it (the tests below read their flow graphs from the same copy).
    for (const bundle of Object.values(seeded)) {
      const [manifest] = bundle.values;
      expect(manifest?.kind).toBe("manifest");
      expect(await reads.calls.readBundleValue({ key: manifest?.key ?? "" })).toEqual({
        result: "value",
        value: {
          key: manifest?.key,
          kind: "manifest",
          bytes: manifest?.bytes,
          sha256: manifest?.sha256,
          text: manifest?.text,
        },
      });
    }
    // Each seeded bundle has an id of its own, and none is v0's.
    const ids = [V0_ID, ...Object.values(seeded).map((bundle) => bundle.bundleId)].map(
      (id) => `${id.hash}/${String(id.build)}`,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---- bundle v0 passes, and the three reads -----------------------------------------------------------------------------

describe("bundle v0, as T-1253's rig publishes it", () => {
  it("passes the check read from PostgreSQL's copy while the KV is empty: the KV is asked first, then K-05 readBundleValue through the handle, for the manifest and the flow graph it lists", async () => {
    const made = rig();
    expectNoBundleAnswers(made.adapter);
    expect(made.adapter.answersFor()).toBeNull();

    await made.adapter.checkPin({ bundleId: V0_ID, bundles: made.port });

    expect(made.kv.gets).toEqual([keyIn(V0_ID, "manifest"), keyIn(V0_ID, "flow/A")]);
    expect(made.reads.made).toEqual(["readBundleValue manifest", "readBundleValue flow/A"]);
    expect(made.lines).toEqual([
      {
        level: "info",
        msg: "bundleSafetyCheck",
        bundle_id: V0_ID,
        outcome: "passed",
        checks: [],
        error_code: null,
        call: null,
        sqlstate: null,
        parts: ["manifest", "flow/A"],
        from: ["postgres", "postgres"],
        answers_for: V0_ID,
        environment: "staging",
        version: "test-sha",
      },
    ]);
    expect(made.adapter.answersFor()).toEqual(V0_ID);
    expect(answeringBundleOf(made.adapter)).toEqual(V0_ID);
  });

  it("passes the check read from the KV once it is filled, with no K-05 read; kept, a second check reads nothing and writes no line", async () => {
    const made = rig(noReads());
    made.kv.fill(V0);

    await made.adapter.checkPin({ bundleId: V0_ID, bundles: made.port });

    expect(made.lines).toMatchObject([
      { outcome: "passed", parts: ["manifest", "flow/A"], from: ["kv", "kv"], answers_for: V0_ID },
    ]);
    expect(made.reads.made).toEqual([]);

    const gets = made.kv.gets.length;
    await made.adapter.checkPin({ bundleId: { ...V0_ID }, bundles: made.port });
    expect(made.kv.gets).toHaveLength(gets);
    expect(made.reads.made).toEqual([]);
    expect(made.lines).toHaveLength(1);
    expect(made.adapter.answersFor()).toEqual(V0_ID);
  });

  it("then fixedLine answers safetyEmergency's, safetyCrisis's, safetyAsk's and outage's words exactly as v0's manifest holds them, a pendingJay line and a line the bundle lacks null; outcomeLine null for each of K-02's outcomes; dangerWords []", async () => {
    const made = rig();
    await made.adapter.checkPin({ bundleId: V0_ID, bundles: made.port });
    const { adapter } = made;

    for (const id of ["safetyEmergency", "safetyCrisis", "safetyAsk", "outage"]) {
      expect(adapter.fixedLine(id), id).toEqual({ id, text: wordsIn(V0_MANIFEST, id) });
    }
    // v0 lists optOutLine in English and in Spanish (bundles/v0/build.mjs): the English line answers.
    expect(linesIn(V0_MANIFEST).filter((line) => line.id === "optOutLine")).toHaveLength(2);
    expect(adapter.fixedLine("optOutLine")).toEqual({
      id: "optOutLine",
      text: wordsIn(V0_MANIFEST, "optOutLine"),
    });
    // The lines that wait for Jay (Q-01), and a line no bundle holds.
    const pending = linesIn(V0_MANIFEST).filter((line) => line.status === "pendingJay");
    expect(pending.map((line) => line.id).sort()).toEqual(["helpReply", "startReply", "stopReply"]);
    for (const line of pending) expect(adapter.fixedLine(line.id), line.id).toBeNull();
    expect(adapter.fixedLine("noSuchLine")).toBeNull();
    expect(adapter.fixedLine("constructor")).toBeNull();

    // Bundle v0 holds S1-01 and S1-02 only: no outcome step.
    expect(Object.keys((V0_FLOW_A.steps ?? {}) as Json).sort()).toEqual(["S1-01", "S1-02"]);
    for (const outcome of SAFETY_OUTCOMES) expect(adapter.outcomeLine(outcome), outcome).toBeNull();
    expect(adapter.dangerWords()).toEqual([]);

    // A caller cannot change what the adapter holds.
    const line = adapter.fixedLine("safetyEmergency");
    if (line !== null) line.text = "";
    expect(adapter.fixedLine("safetyEmergency")).toEqual({
      id: "safetyEmergency",
      text: wordsIn(V0_MANIFEST, "safetyEmergency"),
    });
  });
});

// ---- the pin, through checkedPin ---------------------------------------------------------------------------------------

type Namespace = DurableObjectNamespace<HandleActor>;

let actors = 0;

/** Whole fiction-range numbers (555-01xx), one per actor, so each actor name is distinct. */
const ACTOR_PHONES: readonly string[] = [
  "+15555550130",
  "+15555550131",
  "+15555550132",
  "+15555550133",
  "+15555550134",
  "+15555550135",
  "+15555550136",
  "+15555550137",
  "+15555550138",
  "+15555550139",
];

/** A HandleActor of its own for each pin, so no pin meets another's stored rows. */
function actorStub(): DurableObjectStub<HandleActor> {
  const ns = (exports as unknown as { HandleActor: Namespace }).HandleActor;
  const phone = ACTOR_PHONES[actors];
  actors += 1;
  if (phone === undefined) throw new Error("more pins than fiction-range numbers in ACTOR_PHONES");
  return ns.get(ns.idFromName(`phone:${phone}`));
}

/** What the lease hands the pin when it starts a turn's first run (T-248), the turn's first text under bundle v0. */
const PIN_REQUEST: PinRequest = {
  turnId: "turn-t1397-pin",
  traceId: TRACE,
  joinedTraceIds: [],
  texts: 1,
  tries: 1,
  restart: false,
  leaseMs: 60_000,
  arrivedUnder: V0_ID,
};

interface PinRun {
  /** The bundle the run pinned, or null: no pin, so the run's work does not start. */
  readonly pinned: { readonly bundleId: unknown; readonly manifestOf: unknown } | null;
  /** Every pin the actor's storage holds after the run. */
  readonly pins: PinEntry[];
  /** The pin's own spans (its lease hop). */
  readonly spans: Json[];
}

/**
 * One pin by the real pin (../../bundle/pin.ts) inside a HandleActor's own storage, reading through what the root
 * installed (`setBundleDeps(root.pin)`: on staging, checkedPin over the bundle port). The actor has no KV.
 */
async function pinWith(root: Root): Promise<PinRun> {
  const restore = root.install();
  try {
    return await runInDurableObject(actorStub(), async (_actor, state) => {
      const spans: Json[] = [];
      const pins = new BundlePins({
        storage: state.storage,
        now: () => 3000,
        kv: () => null,
        spanSink: () => (span: Span) => {
          spans.push(span as unknown as Json);
        },
      });
      const pin = await pins.pin(PIN_REQUEST, new AbortController().signal);
      const pinned =
        pin === null ? null : { bundleId: pin.bundleId, manifestOf: pin.bundle.manifest.bundleId };
      return { pinned, pins: pins.read(), spans };
    });
  } finally {
    restore();
  }
}

describe("through checkedPin and the real pin over a HandleActor's storage (DL-341, DL-351)", () => {
  it("bundle v0, the active bundle, is pinned: the check read it once, and the lines then answer for it", async () => {
    keepConsole();
    const made = rig();
    const { root } = rootOver(made);

    const run = await pinWith(root);

    expect(run.pinned).toEqual({ bundleId: V0_ID, manifestOf: V0_ID });
    expect(run.pins).toEqual([{ turnId: PIN_REQUEST.turnId, bundleId: V0_ID, pinnedAt: 3000 }]);
    expect(run.spans).toMatchObject([
      { hop: "lease", outcome: "ok", got: { manifestFrom: "postgres" }, decided: { bundlePinned: true } },
    ]);
    // K-05's active id, the check's two values, then the pin's own manifest read.
    expect(made.reads.made).toEqual([
      "readActiveBundle",
      "readBundleValue manifest",
      "readBundleValue flow/A",
      "readBundleValue manifest",
    ]);
    expect(made.lines).toMatchObject([{ outcome: "passed", bundle_id: V0_ID, answers_for: V0_ID }]);
    expect(root.safety.bundle.fixedLine("safetyAsk")).toEqual({
      id: "safetyAsk",
      text: wordsIn(V0_MANIFEST, "safetyAsk"),
    });
  });

  it.each(REFUSED)(
    "%s is not pinned: the check refuses it (%s), nothing is stored for the turn, the lease span's code is noAnswer, and no line answers",
    async (name, check) => {
      keepConsole();
      const bundle = seeded[name];
      const made = rig();
      const { root } = rootOver(made, activeAs(made.reads.calls, bundle.bundleId));

      const run = await pinWith(root);

      expect(run.pinned).toBeNull();
      expect(run.pins).toEqual([]);
      expect(run.spans).toMatchObject([
        { hop: "lease", outcome: "failed", error_code: "noAnswer", decided: { bundlePinned: false } },
      ]);
      // Refused at the check, before the pin reads the manifest: the check's own two values, from PostgreSQL's copy.
      expect(made.reads.made).toEqual(["readBundleValue manifest", "readBundleValue flow/A"]);
      expect(made.lines).toEqual([
        expect.objectContaining({
          level: "error",
          bundle_id: bundle.bundleId,
          outcome: "refused",
          checks: [check],
          from: ["postgres", "postgres"],
          answers_for: null,
        }),
      ]);
      expect(made.adapter.answersFor()).toBeNull();
      expectNoBundleAnswers(root.safety.bundle);
      // The check's own answer names the failed check's label, and nothing else of the bundle.
      const refusal = await rejectionOf(
        made.adapter.checkPin({ bundleId: bundle.bundleId, bundles: made.port }),
      );
      expect(refusal).toBeInstanceOf(BundleRefusedError);
      expect((refusal as BundleRefusedError).checks).toEqual([check]);
      expect((refusal as Error).message).toBe(
        `the bundle's safety lines' check refused the bundle: ${check}`,
      );
    },
  );

  it("a bundle that fails several checks names each, in order", async () => {
    const lines = withoutWords("safetyEmergency").map((line) =>
      line.id === "safetyAsk" ? { ...line, text: null, status: "pendingJay" } : line,
    );
    const steps = MINI_FLOW_A.steps as Record<string, Json>;
    const flow = { ...MINI_FLOW_A, steps: { ...steps, "A3-49": { ...steps["A3-24"], id: "A3-49" } } };
    const bundle = await bundleOf(51, { A: flow }, lines);
    const made = rig(noReads());
    made.kv.fill(bundle);

    const refusal = await rejectionOf(
      made.adapter.checkPin({ bundleId: bundle.bundleId, bundles: made.port }),
    );

    expect((refusal as BundleRefusedError).checks).toEqual([
      BUNDLE_CHECKS.safetyEmergency,
      BUNDLE_CHECKS.safetyAsk,
      BUNDLE_CHECKS.hotline,
    ]);
    expect(made.reads.made).toEqual([]);
  });
});

// ---- before any check passed, and the ruled seam (DL-757, option (c)) --------------------------------------------------

describe("the safety read through realSafetyRead (DL-757, option (c))", () => {
  it("before any check passed, each of the three reads throws its named error, through the adapter and through the root", () => {
    const made = rig(noReads());
    const { root } = rootOver(made);

    expectNoBundleAnswers(made.adapter);
    expectNoBundleAnswers(root.safety.bundle);
    expect(made.reads.made).toEqual([]);
    expect(made.kv.gets).toEqual([]);
  });

  it("the first arrival in a new isolate, with no pin before it, reads the active bundle's lines and gets a verdict", async () => {
    keepConsole();
    const made = rig();
    const { root, models } = rootOver(made);
    expectNoBundleAnswers(root.safety.bundle);

    const read = await root.safety.read.read(request(V0_ID));

    expect(read.result.outcomes).toEqual(["No"]);
    expect(models.calls.map((call) => call.text)).toEqual([JOIN_TEXT]);
    // The check ran for the text's own bundle, through the bound bundle port, before the danger words were read.
    expect(made.reads.made).toEqual(["readBundleValue manifest", "readBundleValue flow/A"]);
    expect(made.lines).toMatchObject([{ outcome: "passed", bundle_id: V0_ID, answers_for: V0_ID }]);
    expect(root.safety.bundle.dangerWords()).toEqual([]);
    expect(root.safety.bundle.fixedLine("safetyEmergency")).toEqual({
      id: "safetyEmergency",
      text: wordsIn(V0_MANIFEST, "safetyEmergency"),
    });

    // The next text's read finds the bundle kept: nothing is read again.
    const again = await root.safety.read.read(request(V0_ID));
    expect(again.result.outcomes).toEqual(["No"]);
    expect(made.reads.made).toHaveLength(2);
    expect(made.lines).toHaveLength(1);
  });

  it.each(REFUSED)(
    "a text under %s: the check fails (%s), so no lines, and the read fails closed before any model call (the fetch double counts 0)",
    async (name, check) => {
      keepConsole();
      const bundle = seeded[name];
      const made = rig(noReads());
      made.kv.fill(bundle);
      const { root, models } = rootOver(made);

      const failed = await rejectionOf(root.safety.read.read(request(bundle.bundleId)));

      expect(failed).toBeInstanceOf(BundleRefusedError);
      expect((failed as BundleRefusedError).checks).toEqual([check]);
      expect(models.calls).toEqual([]);
      expectNoBundleAnswers(root.safety.bundle);
    },
  );

  it("a text under a bundle no copy holds: the check cannot read it, so the read fails closed before any model call, and names no value", async () => {
    keepConsole();
    const made = rig();
    const { root, models } = rootOver(made);
    const unknown: BundleId = { hash: "a1".repeat(32), build: 7 };

    const failed = await rejectionOf(root.safety.read.read(request(unknown)));

    expect(failed).toBeInstanceOf(BundleUnreadableError);
    expect(failed).toMatchObject({ code: "notFound", call: null, sqlstate: null });
    expect((failed as Error).message).toBe("the bundle's safety lines could not be read: notFound");
    expect(models.calls).toEqual([]);
    expect(made.lines).toEqual([
      expect.objectContaining({
        level: "error",
        bundle_id: unknown,
        outcome: "unreadable",
        error_code: "notFound",
        parts: [],
        answers_for: null,
      }),
    ]);
    expectNoBundleAnswers(root.safety.bundle);
  });

  it("after v0 passed, a text under a refused bundle still fails its read closed, and the lines stay v0's", async () => {
    keepConsole();
    const made = rig(noReads());
    made.kv.fill(V0, seeded.noCrisisWords);
    const { root, models } = rootOver(made);
    await root.safety.read.read(request(V0_ID));
    expect(models.calls).toHaveLength(1);

    const failed = await rejectionOf(root.safety.read.read(request(seeded.noCrisisWords.bundleId)));

    expect(failed).toBeInstanceOf(BundleRefusedError);
    expect(models.calls).toHaveLength(1);
    expect(made.adapter.answersFor()).toEqual(V0_ID);
    expect(root.safety.bundle.fixedLine("safetyCrisis")).toEqual({
      id: "safetyCrisis",
      text: wordsIn(V0_MANIFEST, "safetyCrisis"),
    });
  });

  it("with no reader bound the read fails as before, and no bundle is read for it", async () => {
    const made = rig(noReads());
    const root = composeRoot({
      environment: "staging",
      actors: null,
      vars: VARS,
      bundleReads: made.reads.calls,
      bundleSafety: made.adapter,
    });

    const failed = await rejectionOf(root.safety.read.read(request(V0_ID)));

    expect((failed as Error).name).toBe("NoSafetyReaderError");
    expect(made.kv.gets).toEqual([]);
    expect(made.reads.made).toEqual([]);
  });

  it("in the test environment, where the fake set's state reads answer, the read asks nothing of the lines it is handed", async () => {
    keepConsole();
    const made = rig(noReads());
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: VARS,
      bundleSafety: made.adapter,
      safetyReaders: fakes.models.readers,
    });

    const read = await root.safety.read.read(request(V0_ID));

    // The fake set's own bundle gave the danger words; the adapter was never asked, as at the test environment's pin.
    expect(read.result.outcomes).toEqual(["No"]);
    expect(fakes.models.calls).toHaveLength(1);
    expect(root.safety.bundle).toBe(fakes.ports.stateReads.safety.bundle);
    expect(made.kv.gets).toEqual([]);
    expect(made.reads.made).toEqual([]);
    expect(made.lines).toEqual([]);
    expect(made.adapter.answersFor()).toBeNull();
  });
});

// ---- across a switch -----------------------------------------------------------------------------------------------------

describe("across a switch", () => {
  it("the reads answer for the bundle whose check passed last, which the adapter names; a refused bundle leaves the admitted one answering; the two newest are kept", async () => {
    const made = rig();
    const { adapter, port } = made;
    const { second, noAskWords, emergencyStep } = seeded;
    const outage = { id: "outage", text: wordsIn(V0_MANIFEST, "outage") };
    // The KV holds the refused bundle and the third one; v0 and the second are read from PostgreSQL's copy.
    made.kv.fill(noAskWords, emergencyStep);

    await adapter.checkPin({ bundleId: V0_ID, bundles: port });
    expect(adapter.answersFor()).toEqual(V0_ID);
    expect(adapter.fixedLine("outage")).toEqual(outage);

    // The second bundle, read from PostgreSQL's copy: its outage line has no words, v0's has.
    await adapter.checkPin({ bundleId: second.bundleId, bundles: port });
    expect(adapter.answersFor()).toEqual(second.bundleId);
    expect(adapter.fixedLine("outage")).toBeNull();
    expect(adapter.fixedLine("safetyAsk")).toEqual({
      id: "safetyAsk",
      text: wordsIn(second.manifest, "safetyAsk"),
    });

    // A refused bundle after an admitted one: the admitted one still answers.
    await expect(adapter.checkPin({ bundleId: noAskWords.bundleId, bundles: port })).rejects.toBeInstanceOf(
      BundleRefusedError,
    );
    expect(adapter.answersFor()).toEqual(second.bundleId);
    expect(adapter.fixedLine("outage")).toBeNull();

    // A switch back (a rollback): v0 is kept, so nothing is read, and the reads answer for it again.
    const before = made.reads.made.length;
    await adapter.checkPin({ bundleId: V0_ID, bundles: port });
    expect(made.reads.made).toHaveLength(before);
    expect(adapter.answersFor()).toEqual(V0_ID);
    expect(adapter.fixedLine("outage")).toEqual(outage);

    expect(made.lines.map((line) => [line.outcome, line.bundle_id, line.answers_for])).toEqual([
      ["passed", V0_ID, V0_ID],
      ["passed", second.bundleId, second.bundleId],
      ["refused", noAskWords.bundleId, second.bundleId],
      ["answering", V0_ID, V0_ID],
    ]);

    // A third admitted bundle: the two newest are kept (v0 and it), so the second is read again when it is next asked.
    expect(KEPT_BUNDLES).toBe(2);
    await adapter.checkPin({ bundleId: emergencyStep.bundleId, bundles: port });
    expect(adapter.answersFor()).toEqual(emergencyStep.bundleId);
    const kept = made.reads.made.length;
    await adapter.checkPin({ bundleId: V0_ID, bundles: port });
    expect(made.reads.made).toHaveLength(kept);
    await adapter.checkPin({ bundleId: second.bundleId, bundles: port });
    expect(made.reads.made.slice(kept)).toEqual(["readBundleValue manifest", "readBundleValue flow/A"]);
    expect(adapter.answersFor()).toEqual(second.bundleId);
  });
});

// ---- the outcome steps (K-01 v1's flow graph) ----------------------------------------------------------------------------

/** A step's message, as K-01 v1 writes one. */
const message = (from: string, to: string, text: string, plainText = text): Json => ({
  from,
  to,
  text,
  plainText,
});

/** A flow's danger check with these outcomes' steps, and the steps given (a small K-01 v1 flow graph, by hand). */
function flowWith(
  flow: "A" | "B",
  branches: Readonly<Record<string, string>>,
  steps: Readonly<Record<string, Json>>,
): Json {
  const check = flow === "A" ? "A3-22" : "B3-17";
  return {
    contract: "bundle.v1",
    flow,
    steps: {
      [check]: {
        id: check,
        type: "split",
        branches: Object.entries(branches).map(([label, step]) => ({ label, steps: [step] })),
      },
      ...steps,
    },
  };
}

/** The adapter once it has checked a bundle held in the KV alone (no K-05 read): its answer, or its refusal. */
async function checked(bundle: SeedBundle): Promise<{ made: Rig; refusal: unknown }> {
  const made = rig(noReads());
  made.kv.fill(bundle);
  let refusal: unknown = null;
  try {
    await made.adapter.checkPin({ bundleId: bundle.bundleId, bundles: made.port });
  } catch (error) {
    refusal = error;
  }
  expect(made.reads.made).toEqual([]);
  return { made, refusal };
}

describe("an outcome step's checked line, as K-01 v1 writes it in the flow graph", () => {
  const miniSteps = MINI_FLOW_A.steps as Record<
    string,
    { say?: { from: string; to: string; text: string }[]; branches?: { label: string; steps: string[] }[] }
  >;

  it("K-01's bundle-mini-a.json writes the outcomes as its danger check's branches: A3-22 gives an emergency A3-24 and harm to a child or older adult A3-49", () => {
    const branches = Object.fromEntries(
      (miniSteps["A3-22"]?.branches ?? []).map((branch) => [branch.label, branch.steps]),
    );
    expect(Object.keys(branches)).toEqual(SAFETY_OUTCOMES.filter((outcome) => outcome !== "Unsure"));
    expect(branches["An emergency"]).toEqual(["A3-24"]);
    expect(branches["Harm to a child or older adult"]).toEqual(["A3-49"]);
    expect(Object.keys(miniSteps)).toContain("A3-24");
    expect(Object.keys(miniSteps)).not.toContain("A3-49");
  });

  it("a bundle that holds A3-24 passes, read from PostgreSQL's copy: an emergency answers the step's own message under its id, every other outcome null", async () => {
    const made = rig();
    const bundle = seeded.emergencyStep;

    await made.adapter.checkPin({ bundleId: bundle.bundleId, bundles: made.port });

    const say = miniSteps["A3-24"]?.say?.[0];
    expect(say).toMatchObject({ from: "san", to: "agent" });
    expect(made.adapter.outcomeLine("An emergency")).toEqual({ id: "A3-24", text: say?.text });
    for (const outcome of SAFETY_OUTCOMES.filter((each) => each !== "An emergency")) {
      expect(made.adapter.outcomeLine(outcome), outcome).toBeNull();
    }
    expect(made.adapter.dangerWords()).toEqual([]);
    expect(made.lines).toMatchObject([{ outcome: "passed", from: ["postgres", "postgres"] }]);
  });

  it("a step's line is used only as written: the first message from Rosie to someone other than the owner, its text and plain text the same words, no slot, not blank; flow A's step before flow B's", async () => {
    const plain = "Test line one, as written.";
    const flowA = flowWith(
      "A",
      {
        "An emergency": "A3-24",
        "Crisis words": "A3-25",
        "A threat to staff or others": "A3-48",
        "Unsafe at home": "A3-50",
        "Needs the business's own line": "A3-26",
        "Safety steps, then go on": "A3-23",
      },
      {
        // The owner's message first, then the writer's: the writer's is the line.
        "A3-24": {
          id: "A3-24",
          say: [message("san", "owner", "Test line to the owner."), message("san", "agent", plain)],
        },
        // Its text and its plain text differ (an element turned into text): not used as written.
        "A3-25": {
          id: "A3-25",
          say: [message("san", "cust", "Test line with a button.", "Test line with a button. [Yes]")],
        },
        // The owner's alone (A3-48: no safety message to the one who threatens).
        "A3-48": { id: "A3-48", say: [message("san", "owner", "Test line to the owner alone.")] },
        // A slot left in.
        "A3-50": { id: "A3-50", say: [message("san", "agent", "Test line for {{name}}.")] },
        // Blank, and a message that is not Rosie's.
        "A3-26": {
          id: "A3-26",
          say: [message("san", "agent", "  "), message("cust", "san", "Test line from the customer.")],
        },
        // A3-23 is named by the check and not held.
      },
    );
    const flowB = flowWith(
      "B",
      { "An emergency": "B3-19", "Crisis words": "B3-20" },
      {
        "B3-19": { id: "B3-19", say: [message("san", "agent", "Test line of flow B, one.")] },
        "B3-20": { id: "B3-20", say: [message("san", "agent", "Test line of flow B, two.")] },
      },
    );

    const { made, refusal } = await checked(await bundleOf(61, { A: flowA, B: flowB }));

    expect(refusal).toBeNull();
    expect(made.lines).toMatchObject([{ outcome: "passed", parts: ["manifest", "flow/A", "flow/B"] }]);
    const { adapter } = made;
    expect(adapter.outcomeLine("An emergency")).toEqual({ id: "A3-24", text: plain });
    // Flow A's step gives no line as written, so flow B's does.
    expect(adapter.outcomeLine("Crisis words")).toEqual({ id: "B3-20", text: "Test line of flow B, two." });
    expect(adapter.outcomeLine("A threat to staff or others")).toBeNull();
    expect(adapter.outcomeLine("Unsafe at home")).toBeNull();
    expect(adapter.outcomeLine("Needs the business's own line")).toBeNull();
    expect(adapter.outcomeLine("Safety steps, then go on")).toBeNull();
    expect(adapter.outcomeLine("Harm to a child or older adult")).toBeNull();
    expect(adapter.outcomeLine("No")).toBeNull();
    expect(adapter.outcomeLine("Unsure")).toBeNull();
  });

  it("A3-49's step refuses the bundle in either flow (DL-351): by its id, as the step a flow B twin names, and as the step flow B's danger check gives the outcome", async () => {
    const harm = { say: [message("san", "agent", "Test line with no hotline.")] };
    const cases: readonly (readonly [string, SeedBundle])[] = [
      [
        "flow A holds A3-49",
        await bundleOf(71, { A: flowWith("A", {}, { "A3-49": { id: "A3-49", ...harm } }) }),
      ],
      [
        "a flow B step names A3-49 as its twin",
        await bundleOf(72, { B: flowWith("B", {}, { "B3-31": { id: "B3-31", text: "A3-49", ...harm } }) }),
      ],
      [
        "flow B's danger check gives the outcome a step the bundle holds",
        await bundleOf(73, {
          B: flowWith(
            "B",
            { "Harm to a child or older adult": "B3-31" },
            { "B3-31": { id: "B3-31", ...harm } },
          ),
        }),
      ],
    ];
    for (const [name, bundle] of cases) {
      const { made, refusal } = await checked(bundle);
      expect(refusal, name).toBeInstanceOf(BundleRefusedError);
      expect((refusal as BundleRefusedError).checks, name).toEqual([BUNDLE_CHECKS.hotline]);
      expect(made.adapter.answersFor(), name).toBeNull();
    }

    // The check names the outcome's step, but the bundle does not hold it: nothing to refuse, and the line falls to 911.
    const named = await checked(
      await bundleOf(74, { A: flowWith("A", { "Harm to a child or older adult": "A3-49" }, {}) }),
    );
    expect(named.refusal).toBeNull();
    expect(named.made.adapter.outcomeLine("Harm to a child or older adult")).toBeNull();
  });
});

// ---- a read that fails inside the check ---------------------------------------------------------------------------------

/** Whether `text` holds `part` as a whole name (not inside a longer name). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

describe("a read that fails inside the check", () => {
  it("through the pool's own HYPERDRIVE_JOB (rosie_rig_none): the check rejects and keeps nothing, reported by call name and SQLSTATE only; the next check, over this file's pair, passes", async () => {
    const none = poolBinding("HYPERDRIVE_JOB");
    expect(none.database).toBe("rosie_rig_none");
    const made = rig(readsOver(dbOver(none)));

    const failed = await rejectionOf(made.adapter.checkPin({ bundleId: V0_ID, bundles: made.port }));

    expect(failed).toBeInstanceOf(BundleUnreadableError);
    expect(failed).toMatchObject({ code: "noAnswer", call: "readBundleValue", sqlstate: "3D000" });
    expect((failed as Error).message).toBe(
      "the bundle's safety lines could not be read: noAnswer (readBundleValue, SQLSTATE 3D000)",
    );
    expect(made.lines).toEqual([
      {
        level: "error",
        msg: "bundleSafetyCheck",
        bundle_id: V0_ID,
        outcome: "unreadable",
        checks: [],
        error_code: "noAnswer",
        call: "readBundleValue",
        sqlstate: "3D000",
        parts: [],
        from: [],
        answers_for: null,
        environment: "staging",
        version: "test-sha",
      },
    ]);
    expect(made.reads.made).toEqual(["readBundleValue manifest"]);
    expect(made.adapter.answersFor()).toBeNull();
    expectNoBundleAnswers(made.adapter);
    // Nothing of the binding's string: no host, port, user, password or database name.
    const url = new URL(none.connectionString);
    const said = [(failed as Error).message, String((failed as Error).stack), JSON.stringify(made.lines)];
    const parts = [
      none.connectionString,
      url.host,
      url.hostname,
      url.port,
      none.user,
      none.password,
      none.database,
    ];
    for (const part of parts.filter((each) => each !== "")) {
      for (const text of said) expect(holds(text, part), "a part of the binding's string").toBe(false);
    }

    // Nothing was kept, so the same adapter reads again: over this file's pair, bundle v0 passes.
    const working = realBundles({ calls: readsOver(dbOver(poolBinding(JOB))).calls });
    await made.adapter.checkPin({ bundleId: V0_ID, bundles: working });
    expect(made.adapter.answersFor()).toEqual(V0_ID);
  });

  it("a value that is not the bundle's own (the KV's and PostgreSQL's copy both refused) and a K-05 transient answer reject the same way, by their codes", async () => {
    // The flow graph's bytes are not the ones the manifest lists, in the KV and in PostgreSQL's copy alike.
    const made = rig({
      made: [],
      calls: {
        readActiveBundle: () => Promise.reject(new Error("not read here")),
        readBundleValue: ({ key }) =>
          Promise.resolve({
            result: "value",
            value: { key, kind: "flow", bytes: 2, sha256: "0".repeat(64), text: "{}" },
          }),
      },
    });
    made.kv.fill(V0);
    made.kv.held.set(keyIn(V0_ID, "flow/A"), "{}");
    const unreadable = await rejectionOf(made.adapter.checkPin({ bundleId: V0_ID, bundles: made.port }));
    expect(unreadable).toMatchObject({ name: "BundleUnreadableError", code: "unreadable", call: null });
    expect(made.lines).toMatchObject([
      {
        outcome: "unreadable",
        error_code: "unreadable",
        parts: ["manifest"],
        from: ["kv"],
        answers_for: null,
      },
    ]);

    const transient = rig({
      made: [],
      calls: {
        readActiveBundle: () => Promise.reject(new Error("not read here")),
        readBundleValue: () => Promise.resolve({ error: "transient", sqlstate: "40001" }),
      },
    });
    const later = await rejectionOf(transient.adapter.checkPin({ bundleId: V0_ID, bundles: transient.port }));
    expect(later).toMatchObject({ code: "transient", call: "readBundleValue", sqlstate: "40001" });
    expectNoBundleAnswers(transient.adapter);
  });
});

// ---- which lines hold words, and the core's rule -----------------------------------------------------------------------

describe("which fixed lines hold words (fixedLinesWithWords)", () => {
  const line = (fields: Json): Json => ({
    id: "safetyAsk",
    lang: "en",
    status: "asWritten",
    text: "Test words.",
    ...fields,
  });
  const heldIn = (lines: unknown): string[] => [
    ...fixedLinesWithWords({ lists: { fixedLines: { lines } } }).keys(),
  ];

  it("holds a line with status asWritten and a text, in English and not blank; nothing else", () => {
    expect(heldIn([line({})])).toEqual(["safetyAsk"]);
    expect(heldIn([line({ status: "pendingJay", text: null })])).toEqual([]);
    expect(heldIn([line({ status: "pendingJay" })])).toEqual([]);
    expect(heldIn([line({ text: null })])).toEqual([]);
    expect(heldIn([line({ text: "" })])).toEqual([]);
    expect(heldIn([line({ text: " \n\t" })])).toEqual([]);
    expect(heldIn([line({ text: 911 })])).toEqual([]);
    expect(heldIn([line({ lang: "es" })])).toEqual([]);
    expect(heldIn([line({ id: 7 })])).toEqual([]);
    expect(heldIn([null, "safetyAsk", ["safetyAsk"]])).toEqual([]);
    for (const manifest of [
      null,
      undefined,
      "manifest",
      [],
      {},
      { lists: null },
      { lists: { fixedLines: { lines: "x" } } },
    ]) {
      expect([...fixedLinesWithWords(manifest).keys()]).toEqual([]);
    }
  });

  it("answers the first English line of an id that holds words", () => {
    const held = fixedLinesWithWords({
      lists: {
        fixedLines: {
          lines: [
            line({ lang: "es", text: "Test words, Spanish." }),
            line({ text: " " }),
            line({ text: "Test words, first." }),
            line({ text: "Test words, second." }),
          ],
        },
      },
    });
    expect([...held.values()]).toEqual([{ id: "safetyAsk", text: "Test words, first." }]);
  });

  it("for v0 and each refused bundle, agrees with the core's rule: pinnedSafetyLines chooses safetyCrisis and safetyEmergency exactly when the adapter holds their words", async () => {
    const coreOf = (bundle: Pick<SeedBundle, "bundleId" | "manifest" | "flows">) => {
      const bundles: FrontierBundles = {
        manifest: () => Promise.resolve(bundle.manifest),
        flow: (_bundleId, flow) => Promise.resolve(bundle.flows[flow] ?? null),
      };
      return pinnedSafetyLines(bundles, bundle.bundleId);
    };
    const expected: readonly (readonly [
      string,
      Pick<SeedBundle, "bundleId" | "manifest" | "flows">,
      boolean,
      boolean,
    ])[] = [
      ["v0", V0, true, true],
      ["noEmergencyWords", seeded.noEmergencyWords, false, true],
      ["noCrisisWords", seeded.noCrisisWords, true, false],
      ["noAskWords", seeded.noAskWords, true, true],
    ];
    for (const [name, bundle, emergency, crisis] of expected) {
      const held = fixedLinesWithWords(bundle.manifest);
      const core = await coreOf(bundle);
      expect(held.has("safetyEmergency"), name).toBe(emergency);
      expect(held.has("safetyCrisis"), name).toBe(crisis);
      expect(core.lineOf("An emergency", []) !== null, name).toBe(held.has("safetyEmergency"));
      expect(core.lineOf("Crisis words", []) !== null, name).toBe(held.has("safetyCrisis"));
      expect(core.lineOf("Unsure", ["other"]) !== null, name).toBe(held.has("safetyEmergency"));
      expect(core.lineOf("Unsure", ["selfHarm"]) !== null, name).toBe(held.has("safetyCrisis"));
      expect(core.outageLine() !== null, name).toBe(held.has("outage"));
    }
    // The second bundle's outage line has no words, in both rules.
    expect(fixedLinesWithWords(seeded.second.manifest).has("outage")).toBe(false);
    expect((await coreOf(seeded.second)).outageLine()).toBeNull();

    // The bundle that holds A3-49's step holds every line's words; the core reads no step's own line yet, so it refuses a
    // danger outcome's line for any bundle with a safety step (notBuilt), and the two rules still agree on the outage line.
    const harm = await coreOf(seeded.harmStep);
    const heldByHarm = fixedLinesWithWords(seeded.harmStep.manifest);
    expect(["safetyEmergency", "safetyCrisis", "safetyAsk"].every((id) => heldByHarm.has(id))).toBe(true);
    expect(() => harm.lineOf("Crisis words", [])).toThrow(NotBuiltError);
    expect(() => harm.lineOf("An emergency", [])).toThrow(NotBuiltError);
    expect(harm.outageLine() !== null).toBe(heldByHarm.has("outage"));
  });
});

// ---- stagingOptions: production builds none ------------------------------------------------------------------------------

/** The Worker's env for `environment`, with every binding the adapter's part could read present, each read counted. */
function countingEnv(environment: string): { env: StagingEnv; reads: string[]; kvGets: string[] } {
  const reads: string[] = [];
  const kvGets: string[] = [];
  const hyperdrive = (name: string): object => ({
    get connectionString() {
      reads.push(`${name}.connectionString`);
      return poolBinding(name === "HYPERDRIVE_JOB" ? JOB : APP).connectionString;
    },
  });
  const values: Record<string, unknown> = {
    ...STAGING_VARS,
    ENVIRONMENT: environment,
    HYPERDRIVE_JOB: hyperdrive("HYPERDRIVE_JOB"),
    HYPERDRIVE_APP: hyperdrive("HYPERDRIVE_APP"),
    BUNDLES: {
      get: (key: string) => {
        kvGets.push(key);
        return Promise.resolve(null);
      },
    },
  };
  const env = new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { env: env as unknown as StagingEnv, reads, kvGets };
}

/**
 * Every part but this card's, the turn's and the gate's, stood in by its nothing-bound answer (each stub's own, as T-1257
 * made it; ./k05-turn.worker.test.ts stands the others in the same way), so inputs built with these show this card's
 * binding alone, whatever the other parts read or bind as their cards land (DL-768: T-1393's flags part reads ENVIRONMENT
 * and HYPERDRIVE_JOB's presence at build). The adapter's own builder is left out, so it is the real one; a case names the
 * turn's and the gate's stand-ins itself.
 */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
};

describe("stagingOptions and the one adapter", () => {
  it("production builds none: stagingOptions reads ENVIRONMENT alone (0 binding reads), runs no builder and hands bundleSafety null", () => {
    for (const environment of ["production", "", "Staging", "preview"]) {
      const { env, reads, kvGets } = countingEnv(environment);
      const built = vi.fn(() => null);

      const inputs = stagingOptions(env, { builders: { bundleSafety: built } });

      expect(inputs, environment).toBe(NO_STAGING_INPUTS);
      expect(inputs.bundleSafety, environment).toBeNull();
      expect(built, environment).not.toHaveBeenCalled();
      expect(reads, environment).toEqual(["ENVIRONMENT"]);
      expect(kvGets, environment).toEqual([]);
    }
  });

  it("on staging with no bundle reads bound (P2b's stub), the builder gives null and reads nothing", () => {
    const { env, reads } = countingEnv("staging");
    const db = dbOver(poolBinding(JOB));

    expect(stagingBundleSafety({ env, db, kv: () => null, bundleReads: null })).toBeNull();
    expect(answeringBundleOf(null)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("on staging with P2b's bundle reads bound, stagingOptions makes one adapter, hands the same instance to the gate's part, reads no binding to make it, and the root's first safety read gets its verdict through it", async () => {
    keepConsole();
    const { env, reads, kvGets } = countingEnv("staging");
    const turn = readsOver(stagingDb(env, { write: (line) => everyLine.push(line) }));
    const handed: { gate?: unknown } = {};

    const inputs = stagingOptions(env, {
      builders: {
        ...EVERY_OTHER_PART_UNBOUND,
        turn: () => ({ ...NO_TURN_CALL_INPUTS, bundleReads: turn.calls }),
        gate: (part) => {
          handed.gate = part.bundleSafety;
          return null;
        },
      },
    });

    expect(inputs.bundleSafety).not.toBeNull();
    expect(handed.gate).toBe(inputs.bundleSafety);
    expect(reads).toEqual(["ENVIRONMENT"]);
    expect(answeringBundleOf(inputs.bundleSafety)).toBeNull();

    const { models } = skeletonFakes();
    const root = composeRoot({
      environment: "staging",
      actors: null,
      vars: VARS,
      ...inputs,
      safetyReaders: models.readers,
    });
    const read = await root.safety.read.read(request(V0_ID));

    expect(read.result.outcomes).toEqual(["No"]);
    expect(models.calls).toHaveLength(1);
    // The actor's BUNDLES KV was asked first, at the check (a miss), then PostgreSQL's copy through the handle.
    expect(kvGets).toEqual([keyIn(V0_ID, "manifest"), keyIn(V0_ID, "flow/A")]);
    expect(turn.made).toEqual(["readBundleValue manifest", "readBundleValue flow/A"]);
    expect(answeringBundleOf(inputs.bundleSafety)).toEqual(V0_ID);
    // What the gate's part was handed answers the same words (SafetyDeps.words: one source).
    expect((handed.gate as BundleBackedLines).fixedLine("safetyAsk")).toEqual({
      id: "safetyAsk",
      text: wordsIn(V0_MANIFEST, "safetyAsk"),
    });
  });
});

// ---- what was logged ------------------------------------------------------------------------------------------------------

describe("what the file's tests logged (the adapter's lines, the handle's dbCall lines and the spans)", () => {
  it("holds no line's words and no step's message: labels and the bundle id only", () => {
    const checkLines = everyLine
      .map(parsedLine)
      .filter((line): line is Json => line?.msg === "bundleSafetyCheck");
    // The tests above passed, refused and failed checks, read from both copies, and switched.
    expect(new Set(checkLines.map((line) => line.outcome))).toEqual(
      new Set(["passed", "answering", "refused", "unreadable"]),
    );
    expect(everyLine.some((line) => line.includes('"msg":"dbCall"'))).toBe(true);
    expect(everyLine.some((line) => line.includes('"hop":"portCall"'))).toBe(true);

    const words = everyWordsOf([V0, ...Object.values(seeded)]);
    expect(words.length).toBeGreaterThan(20);
    const logged = everyLine.join("\n");
    for (const text of words) expect(logged.includes(text), "a line's words were logged").toBe(false);
    expect(logged.includes(JOIN_TEXT)).toBe(false);

    // Each check line: its own fields, every string in it a label (K-08's form: no spaces, so no words).
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : typeof value === "object" && value !== null
            ? Object.values(value).flatMap(strings)
            : [];
    for (const line of checkLines) {
      expect(Object.keys(line)).toEqual([
        "level",
        "msg",
        "bundle_id",
        "outcome",
        "checks",
        "error_code",
        "call",
        "sqlstate",
        "parts",
        "from",
        "answers_for",
        "environment",
        "version",
      ]);
      for (const value of strings(line)) expect(isLabel(value), value).toBe(true);
    }
  });
});
