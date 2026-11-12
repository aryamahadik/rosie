// T-1242 (T-1154's part P1b; DL-492): the seams on staging, in the Workers runtime. On staging the state reads
// (stateReads) and the turn's plan calls (dataAccess) are real ports over RootOptions inputs that later parts of T-1154
// hand in (./real.ts realStateReads, realDataAccess and checkedPin; the seams' table there says which field feeds which
// read). Until a part hands its input in, each read fails closed with its named error, as every other staging input
// does. Here the root is composed for staging with every other input on its double (./test-support.ts skeletonFakes), so
// a test sees that no model, database or line is reached while a new read fails closed; then each new input is handed a
// fake in turn; and the real pin (../bundle/pin.ts, over the HandleActor's own storage) reads through Root.pin, behind the
// bundle's safety lines' check (DL-341, DL-351). The test environment keeps its fakes and an unchecked pin, and production
// keeps all twenty-one ports closed, whatever it is handed. Test values only (rule 9): the master's sample cast, the frozen
// fixtures' ids and the fictional 555-01xx numbers.
import unplannedAfterCrash from "@rosie/contracts/data-access/fixtures/unplanned-after-crash.json";
import writePlanJson from "@rosie/contracts/data-access/fixtures/write-plan.json";
import type { ReadActiveBundleResult } from "@rosie/db/repo/bundles";
import type { UnplannedRowsOutcome, WritePlanOutcome } from "@rosie/db/repo/outbox";
import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandleActor } from "../actor";
import { turnIdOf } from "../actor/lease";
import { BundlePins, type Manifest, type PinEntry, type PinRequest } from "../bundle";
import { actorNameOf } from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { FIXTURE_DANGER_WORDS, fixtureBundle } from "../safety/test-support";
import type { HandleDirectory, HandleIds, SafetyReadRequest, SafetyResult } from "../safety/types";
import type { Span } from "../trace";
import { safetyNoFor, SAM, storedText, testTurn } from "../turn/test-support";
import { runTurnLoop } from "../turn/turn";
import type { TurnDirectory, TurnSafety, WriteRowPlanRequest } from "../turn/types";
import { NotJoinedError } from "./closed";
import { PORTS } from "./ports";
import {
  NoDatabaseError,
  NoStateReadError,
  type BundleReadCalls,
  type BundleSafetyLines,
  type PinCheckRequest,
  type PlanCalls,
  type StoppedFlagRead,
} from "./real";
import { composeRoot, workerRoot, type Root, type RootOptions } from "./root";
import { BUNDLE_V0, JOIN_TEXT, skeletonFakes, type SkeletonFakes } from "./test-support";

type Json = Record<string, unknown>;

const ACTOR = actorNameOf(SAM.handle);
const TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
const EVENT = "evt-sam-s1-01";

/** The fictional numbers and words a read's request carries here: none may reach an error, in any form. */
const NEVER_NAMED = ["+15555550100", "15555550100", "5555550100", ACTOR, JOIN_TEXT];

type Environment = "staging" | "production";

/** The new inputs, as RootOptions names them (the seams' table in ./real.ts). */
type NewInput =
  "bundleSafety" | "handleDirectory" | "stoppedFlags" | "turnDirectory" | "turnSafety" | "planCalls";

/** Each read through the root that a new input feeds, and the input that feeds it. */
const READS = {
  fixedLine: "bundleSafety",
  outcomeLine: "bundleSafety",
  dangerWords: "bundleSafety",
  idsOf: "handleDirectory",
  isStopped: "stoppedFlags",
  partyOf: "turnDirectory",
  resultsOf: "turnSafety",
  unplannedRows: "planCalls",
  writePlan: "planCalls",
} as const satisfies Record<string, NewInput>;

type ReadName = keyof typeof READS;

const READ_NAMES = Object.keys(READS) as ReadName[];

/** The error each read fails closed with on staging while its input is null: a state read's, or the plan calls' database. */
function closedOnStaging(read: ReadName): Error {
  return READS[read] === "planCalls" ? new NoDatabaseError(read) : new NoStateReadError(read);
}

/** What a read through the root did: answered, or failed (a synchronous throw included) with this error's name and message. */
type Outcome =
  { readonly answered: unknown } | { readonly failed: { readonly name: string; readonly message: string } };

async function outcomeOf(read: () => unknown): Promise<Outcome> {
  try {
    return { answered: await read() };
  } catch (error) {
    const { name, message } = error as Error;
    return { failed: { name, message } };
  }
}

const failedWith = (error: Error): Outcome => ({ failed: { name: error.name, message: error.message } });

// ---- the requests ---------------------------------------------------------------------------------------------------

/** write-plan.json's request (Alex's confirmation row, its plan and final parts), as the turn's writePlan sends it. */
const WRITE_PLAN = structuredClone(writePlanJson.request) as unknown as WriteRowPlanRequest;
const UNPLANNED_TURN = unplannedAfterCrash.request.turnId;

/** Every read a new input feeds, through the root's own deps (the safety read's and the turn's), as their callers ask. */
async function readAll(root: Root): Promise<Record<ReadName, Outcome>> {
  return {
    fixedLine: await outcomeOf(() => root.safety.bundle.fixedLine("safetyEmergency")),
    outcomeLine: await outcomeOf(() => root.safety.bundle.outcomeLine("An emergency")),
    dangerWords: await outcomeOf(() => root.safety.bundle.dangerWords()),
    idsOf: await outcomeOf(() => root.safety.directory.idsOf(ACTOR)),
    isStopped: await outcomeOf(() => root.safety.isStopped(ACTOR)),
    partyOf: await outcomeOf(() => root.turn.directory.partyOf({ actorName: ACTOR, handle: SAM.handle })),
    resultsOf: await outcomeOf(() => root.turn.safety.resultsOf([EVENT])),
    unplannedRows: await outcomeOf(() => root.turn.rows.unplannedRows({ turnId: UNPLANNED_TURN })),
    writePlan: await outcomeOf(() => root.turn.rows.writePlan(WRITE_PLAN)),
  };
}

// ---- the fakes a test hands the new inputs ----------------------------------------------------------------------------

/** Sam's ids as K-04 names them (the safety read's calls). */
const SAM_IDS: HandleIds = {
  handleId: SAM.party.handleId,
  businessId: SAM.party.businessId,
  personId: SAM.party.personId,
  bookingId: null,
};

/** A bundle the fake's check refuses: a safety line with no words (DL-341). The message names the line only. */
class RefusedBundleError extends Error {
  constructor() {
    super("safetyAsk has no words in this bundle");
    this.name = "RefusedBundleError";
  }
}

interface FakeLines extends BundleSafetyLines {
  /** Each line read, by name, in order. */
  readonly asked: string[];
  /** Each pin check, in order. */
  readonly checked: PinCheckRequest[];
  /** While true, every pin check refuses its bundle. */
  refuse: boolean;
}

/** The bundle's safety lines over K-01's fixture bundle (../safety/test-support.ts fixtureBundle), with a pin check. */
function fakeLines(refuse = false): FakeLines {
  const bundle = fixtureBundle();
  const lines: FakeLines = {
    asked: [],
    checked: [],
    refuse,
    fixedLine(id) {
      lines.asked.push("fixedLine");
      return bundle.fixedLine(id);
    },
    outcomeLine(outcome) {
      lines.asked.push("outcomeLine");
      return bundle.outcomeLine(outcome);
    },
    dangerWords() {
      lines.asked.push("dangerWords");
      return bundle.dangerWords();
    },
    checkPin(request) {
      lines.checked.push(request);
      return lines.refuse ? Promise.reject(new RefusedBundleError()) : Promise.resolve();
    },
  };
  return lines;
}

/** One fake for each new input, each keeping what it was asked; the party and ids rows hold more than the ports take. */
interface HandedFakes {
  readonly inputs: { readonly [Input in NewInput]-?: NonNullable<RootOptions[Input]> };
  readonly lines: FakeLines;
  /** Each call any fake but the lines took, as "<read> <what it was asked>", in order. */
  readonly calls: string[];
}

function handedFakes(): HandedFakes {
  const calls: string[] = [];
  const lines = fakeLines();
  const handleDirectory: HandleDirectory = {
    idsOf(actorName) {
      calls.push(`idsOf ${actorName === ACTOR ? "Sam's actor" : "another actor"}`);
      // A row with more in it than the ids: the port hands on the four ids alone.
      const row = { ...SAM_IDS, address: SAM.handle.address };
      return Promise.resolve(row);
    },
  };
  const stoppedFlags: StoppedFlagRead = (actorName) => {
    calls.push(`isStopped ${actorName === ACTOR ? "Sam's actor" : "another actor"}`);
    return Promise.resolve(false);
  };
  const turnDirectory: TurnDirectory = {
    partyOf(request) {
      calls.push(`partyOf ${request.actorName === ACTOR ? "Sam's actor" : "another actor"}`);
      const row = { ...SAM.party, address: request.handle.address };
      return Promise.resolve(row);
    },
  };
  const turnSafety: TurnSafety = {
    resultsOf(eventIds) {
      calls.push(`resultsOf ${eventIds.join(",")}`);
      return Promise.resolve(eventIds.map((eventId): SafetyResult => safetyNoFor(eventId)));
    },
  };
  // K-05 v1's two plan calls as db/repo answers them: unplanned-after-crash.json's rows, write-plan.json's written row.
  const planCalls: PlanCalls = {
    unplannedRows(request) {
      calls.push(`unplannedRows ${JSON.stringify(request)}`);
      return Promise.resolve(structuredClone(unplannedAfterCrash.outcome) as unknown as UnplannedRowsOutcome);
    },
    writePlan(request) {
      // The request goes to K-05 field for field: write-plan.json's, as the turn sent it.
      calls.push(
        `writePlan ${JSON.stringify(request) === JSON.stringify(writePlanJson.request) ? "as sent" : "changed"}`,
      );
      return Promise.resolve(structuredClone(writePlanJson.outcome) as unknown as WritePlanOutcome);
    },
  };
  return {
    inputs: { bundleSafety: lines, handleDirectory, stoppedFlags, turnDirectory, turnSafety, planCalls },
    lines,
    calls,
  };
}

/** What each read answers through its fake (./real.ts: the party and ids field for field, every other answer as given). */
const ANSWERED: Record<ReadName, Outcome> = {
  fixedLine: { answered: fixtureBundle().fixedLine("safetyEmergency") },
  outcomeLine: { answered: fixtureBundle().outcomeLine("An emergency") },
  dangerWords: { answered: FIXTURE_DANGER_WORDS },
  idsOf: { answered: SAM_IDS },
  isStopped: { answered: false },
  partyOf: { answered: SAM.party },
  resultsOf: { answered: [safetyNoFor(EVENT)] },
  unplannedRows: { answered: unplannedAfterCrash.outcome },
  writePlan: { answered: writePlanJson.outcome },
};

/** What each fake was asked by readAll, by the input it feeds. */
const ASKED: Record<Exclude<NewInput, "bundleSafety">, string[]> = {
  handleDirectory: ["idsOf Sam's actor"],
  stoppedFlags: ["isStopped Sam's actor"],
  turnDirectory: ["partyOf Sam's actor"],
  turnSafety: [`resultsOf ${EVENT}`],
  planCalls: [`unplannedRows ${JSON.stringify({ turnId: UNPLANNED_TURN })}`, "writePlan as sent"],
};

// ---- the root -------------------------------------------------------------------------------------------------------

/**
 * The root for `environment` with every input that is not new handed its double, so a test sees that none of them is
 * reached; each new input null unless `inputs` hands it (or hands another input in a double's place).
 */
function rootFor(
  fakes: SkeletonFakes,
  inputs: Partial<Omit<RootOptions, "environment" | "actors" | "vars">> = {},
  environment: Environment = "staging",
): Root {
  return composeRoot({
    environment,
    actors: null,
    vars: { ENVIRONMENT: environment, GIT_SHA: "test-sha" },
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    retryQueue: fakes.retryQueue,
    armingCalls: fakes.arming.calls,
    bundleSafety: null,
    handleDirectory: null,
    stoppedFlags: null,
    turnDirectory: null,
    turnSafety: null,
    planCalls: null,
    ...inputs,
  });
}

/** How many calls each double the root was handed has taken: a key, a model, the database or the line. */
function reached(fakes: SkeletonFakes): Record<string, number> {
  return {
    handleKeys: fakes.handleKeys.requests.length,
    chatOpens: fakes.dispatch.chatOpens.length,
    safetyModels: fakes.models.calls.length,
    commits: fakes.turnRows.commits.length,
    parks: fakes.turnRows.parks.length,
    bundleReads: fakes.bundleReads.reads.length,
    targets: fakes.handleTargets.requests.length,
    frontierReads: fakes.frontier.reads.length,
    decideModels: fakes.decide.calls.length,
    gateScopes: fakes.gate.scopes.length,
    composeScopes: fakes.compose.scopes.length,
    composerModels: fakes.composer.calls.length,
    finalizeScopes: fakes.finalize.scopes.length,
    planWrites: fakes.finalize.writes.length,
    claims: fakes.dispatch.claims.length,
    sendStates: fakes.dispatch.stateReads.length,
    linqSends: fakes.linq.requests.length,
    arms: fakes.arming.arms.length,
  };
}

function nothingReached(fakes: SkeletonFakes): Record<string, number> {
  return Object.fromEntries(Object.keys(reached(fakes)).map((double) => [double, 0]));
}

/** A failed read's message, and the error's name: never a number, an actor name or a text's words. */
function expectNoValues(outcomes: Record<ReadName, Outcome>): void {
  const failures = JSON.stringify(Object.values(outcomes).filter((outcome) => "failed" in outcome));
  for (const value of NEVER_NAMED) expect(failures).not.toContain(value);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- staging, every new input null --------------------------------------------------------------------------------

describe("on staging with every new input null", () => {
  it("binds the state reads and the plan calls real (turnFace and linqDirect stay closed), as the Worker's own staging root does", () => {
    const root = rootFor(skeletonFakes());
    const worker = workerRoot({ ENVIRONMENT: "staging", BASE_PATH: "", DB_SCHEMA: "" });
    const implementationOf = (of: Root, port: string): string | undefined =>
      of.bindings.find((binding) => binding.port === port)?.implementation;

    for (const of of [root, worker]) {
      expect(implementationOf(of, "stateReads")).toBe("real");
      expect(implementationOf(of, "dataAccess")).toBe("real");
      expect(implementationOf(of, "turnFace")).toBe("closed");
      expect(implementationOf(of, "linqDirect")).toBe("closed");
    }
    expect(worker.bindings).toEqual(root.bindings);
  });

  it("fails each new read closed with its named error, naming the read and no value, and reaches no key, model, database or line", async () => {
    const fakes = skeletonFakes();
    const root = rootFor(fakes);

    const outcomes = await readAll(root);

    expect(outcomes).toEqual(
      Object.fromEntries(READ_NAMES.map((read) => [read, failedWith(closedOnStaging(read))])),
    );
    expect(outcomes.dangerWords).toEqual(failedWith(new NoStateReadError("dangerWords")));
    expect(outcomes.partyOf).toEqual(failedWith(new NoStateReadError("partyOf")));
    expect(outcomes.unplannedRows).toEqual(failedWith(new NoDatabaseError("unplannedRows")));
    expectNoValues(outcomes);
    expect(reached(fakes)).toEqual(nothingReached(fakes));
  });

  it("fails the deployed Worker's reads the same way (workerRoot hands every new input null), its pin failing at K-05's read as before", async () => {
    const worker = workerRoot({ ENVIRONMENT: "staging", BASE_PATH: "", DB_SCHEMA: "" });

    expect(await readAll(worker)).toEqual(
      Object.fromEntries(READ_NAMES.map((read) => [read, failedWith(closedOnStaging(read))])),
    );
    // No bundle reads are handed in either, so the pin fails at the active read itself, before any check is asked.
    await expect(worker.pin.registry.readActiveBundle({})).rejects.toThrow(
      new NoDatabaseError("readActiveBundle"),
    );
  });

  it("fails the safety read before any model call: with a reader handed in but no bundle safety lines, its danger words cannot be read", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fakes = skeletonFakes();
    const root = rootFor(fakes);
    const request: SafetyReadRequest = {
      eventId: EVENT,
      source: "text",
      traceId: TRACE,
      bundleId: BUNDLE_V0,
      words: { body: JOIN_TEXT, subject: null },
    };

    expect(await outcomeOf(() => root.safety.read.read(request))).toEqual(
      failedWith(new NoStateReadError("dangerWords")),
    );
    expect(fakes.models.calls).toEqual([]);
    expect(reached(fakes)).toEqual(nothingReached(fakes));

    // Handed the bundle's safety lines, the same read goes on to the reader (the recorded-model double), given their words.
    const lines = fakeLines();
    const handed = skeletonFakes();
    const read = await rootFor(handed, { bundleSafety: lines }).safety.read.read(request);
    expect(read.result.outcomes).toEqual(["No"]);
    expect(lines.asked).toEqual(["dangerWords"]);
    expect(handed.models.calls.map((call) => call.text)).toEqual([JOIN_TEXT]);
  });

  it("ends a turn's run as it does today: the directory fails closed (noDirectory) before any text is opened, read, decided or written", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fakes = skeletonFakes();
    const root = rootFor(fakes);
    const keys = fakeKeyStore();
    const entry = await storedText(
      { eventId: EVENT, body: JOIN_TEXT, sentAt: "2026-10-19T14:05:00Z", traceId: TRACE },
      SAM.handle,
      keys,
      BUNDLE_V0,
      1,
    );
    const manifest = {
      contract: "bundle.v1",
      bundleId: BUNDLE_V0,
      storage: { manifestKey: `bundle/${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}/manifest`, values: [] },
    } as Manifest;
    const run = testTurn({
      turnId: await turnIdOf([EVENT]),
      traceId: TRACE,
      bundleId: BUNDLE_V0,
      manifest,
      entries: [entry],
    });

    const restore = root.install();
    let outcome: Awaited<ReturnType<typeof runTurnLoop>>;
    try {
      outcome = await runTurnLoop(run.turn);
    } finally {
      restore();
    }

    expect(outcome).toEqual({ result: "notCommitted", why: "noDirectory", gateCalls: 0, replies: null });
    expect(run.commits).toEqual([]);
    expect(reached(fakes)).toEqual(nothingReached(fakes));
  });
});

// ---- staging, each new input handed a fake in turn --------------------------------------------------------------------

describe("on staging with each new input handed a fake in turn", () => {
  const inputs: readonly NewInput[] = [
    "bundleSafety",
    "handleDirectory",
    "stoppedFlags",
    "turnDirectory",
    "turnSafety",
    "planCalls",
  ];

  it.each(inputs)(
    "%s: its reads answer through the fake (a party or ids row as the ports' fields alone), and every other new read still fails closed",
    async (input) => {
      const fakes = skeletonFakes();
      const handed = handedFakes();
      const root = rootFor(fakes, { [input]: handed.inputs[input] });

      const outcomes = await readAll(root);

      expect(outcomes).toStrictEqual(
        Object.fromEntries(
          READ_NAMES.map((read) => [
            read,
            READS[read] === input ? ANSWERED[read] : failedWith(closedOnStaging(read)),
          ]),
        ),
      );
      expect(handed.lines.asked).toEqual(
        input === "bundleSafety" ? ["fixedLine", "outcomeLine", "dangerWords"] : [],
      );
      expect(handed.calls).toEqual(input === "bundleSafety" ? [] : ASKED[input]);
      expectNoValues(outcomes);
      expect(reached(fakes)).toEqual(nothingReached(fakes));
    },
  );
});

// ---- the pin's check (DL-341, DL-351) -------------------------------------------------------------------------------

type Namespace = DurableObjectNamespace<HandleActor>;

function stub(): DurableObjectStub<HandleActor> {
  const ns = (exports as unknown as { HandleActor: Namespace }).HandleActor;
  return ns.get(ns.idFromName(ACTOR));
}

const PIN_TURN = "turn-pin-check-1";

/** What the lease hands the pin when it starts a turn's first run (T-248), the turn's first text under bundle v0. */
const PIN_REQUEST: PinRequest = {
  turnId: PIN_TURN,
  traceId: TRACE,
  joinedTraceIds: [],
  texts: 1,
  tries: 1,
  restart: false,
  leaseMs: 60_000,
  arrivedUnder: BUNDLE_V0,
};

interface PinRun {
  /** The bundle the run pinned, or null: no pin, so the run's work does not start. */
  readonly pinned: { readonly bundleId: unknown; readonly manifestOf: unknown } | null;
  /** Every pin the actor's storage holds after the run (one row per turn id, written once). */
  readonly pins: PinEntry[];
  /** The pin's own spans (its lease hop). */
  readonly spans: Json[];
}

/**
 * One pin of PIN_TURN by the real pin (../bundle/pin.ts) inside the HandleActor's own storage, reading through what the
 * root installed (`setBundleDeps(root.pin)`). No KV: the manifest comes from PostgreSQL's copy (the bundle-reads double).
 */
async function pinWith(root: Root, times = 1): Promise<PinRun> {
  const restore = root.install();
  try {
    return await runInDurableObject(stub(), async (_actor, state) => {
      const spans: Json[] = [];
      const pins = new BundlePins({
        storage: state.storage,
        now: () => 3000,
        kv: () => null,
        spanSink: () => (span: Span) => {
          spans.push(span as unknown as Json);
        },
      });
      let pinned: PinRun["pinned"] = null;
      for (let run = 1; run <= times; run += 1) {
        const pin = await pins.pin({ ...PIN_REQUEST, tries: run }, new AbortController().signal);
        pinned = pin === null ? null : { bundleId: pin.bundleId, manifestOf: pin.bundle.manifest.bundleId };
      }
      return { pinned, pins: pins.read(), spans };
    });
  } finally {
    restore();
  }
}

const MANIFEST_KEY = `bundle/${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}/manifest`;

describe("the pin's check of the bundle's safety lines (DL-341, DL-351)", () => {
  it("a bundle the check refuses is not pinned: the pin fails at the active read, nothing is stored for the turn, and the check was asked once with bundle v0", async () => {
    const fakes = skeletonFakes();
    const lines = fakeLines(true);
    const root = rootFor(fakes, { bundleSafety: lines });

    const run = await pinWith(root);

    expect(run.pinned).toBeNull();
    expect(run.pins).toEqual([]);
    expect(lines.checked).toEqual([{ bundleId: BUNDLE_V0, bundles: root.ports.bundles }]);
    // Refused before the manifest is read: only the active id was asked of K-05.
    expect(fakes.bundleReads.reads).toEqual([{ call: "readActiveBundle", key: null }]);
    expect(run.spans).toMatchObject([
      { hop: "lease", outcome: "failed", error_code: "noAnswer", decided: { bundlePinned: false } },
    ]);
  });

  it("a bundle the check lets through is pinned as before, the manifest read from PostgreSQL's copy; a rerun keeps the id its turn stored and asks nothing again", async () => {
    const fakes = skeletonFakes();
    const lines = fakeLines(false);
    const root = rootFor(fakes, { bundleSafety: lines });

    const run = await pinWith(root, 2);

    expect(run.pinned).toEqual({ bundleId: BUNDLE_V0, manifestOf: BUNDLE_V0 });
    expect(run.pins).toEqual([{ turnId: PIN_TURN, bundleId: BUNDLE_V0, pinnedAt: 3000 }]);
    expect(lines.checked).toEqual([{ bundleId: BUNDLE_V0, bundles: root.ports.bundles }]);
    expect(fakes.bundleReads.reads).toEqual([
      { call: "readActiveBundle", key: null },
      { call: "readBundleValue", key: MANIFEST_KEY },
      { call: "readBundleValue", key: MANIFEST_KEY },
    ]);
    expect(run.spans).toMatchObject([
      { hop: "lease", outcome: "ok", decided: { bundlePinned: true, bundleKept: false } },
      { hop: "lease", outcome: "ok", decided: { bundlePinned: true, bundleKept: true } },
    ]);
  });

  it("with no bundle safety lines bound, no bundle is pinned (NoStateReadError checkPin), though K-05 answered bundle v0", async () => {
    const fakes = skeletonFakes();
    const root = rootFor(fakes);

    const run = await pinWith(root);

    expect(run.pinned).toBeNull();
    expect(run.pins).toEqual([]);
    expect(fakes.bundleReads.reads).toEqual([{ call: "readActiveBundle", key: null }]);
    await expect(root.pin.registry.readActiveBundle({})).rejects.toThrow(new NoStateReadError("checkPin"));
  });

  it("an answer the pin refuses itself keeps the pin's own code, and the check is never asked: no active bundle, or one not of K-01's form", async () => {
    const lines = fakeLines(false);
    const answers: { readonly answer: unknown; readonly code: string }[] = [
      { answer: { error: "noActiveBundle" }, code: "noActiveBundle" },
      { answer: { error: "transient", sqlstate: "40001" }, code: "transient" },
      {
        answer: {
          result: "active",
          bundleId: BUNDLE_V0,
          manifestKey: "bundle/other/1/manifest",
          activatedAt: "x",
        },
        code: "badAnswer",
      },
    ];
    for (const { answer, code } of answers) {
      const bundleReads: BundleReadCalls = {
        readActiveBundle: () => Promise.resolve(structuredClone(answer) as ReadActiveBundleResult),
        readBundleValue: () => Promise.reject(new Error("no value is read")),
      };
      const run = await pinWith(rootFor(skeletonFakes(), { bundleSafety: lines, bundleReads }));

      expect(run.pinned).toBeNull();
      expect(run.pins).toEqual([]);
      expect(run.spans).toMatchObject([{ hop: "lease", outcome: "failed", error_code: code }]);
    }
    expect(lines.checked).toEqual([]);
  });
});

// ---- the test environment and production ---------------------------------------------------------------------------

describe("elsewhere", () => {
  it("leaves the test environment as it was: the fake set's state reads and rows, and the pin reads the bundle port itself, whatever it is handed", () => {
    const fakes = skeletonFakes();
    const handed = handedFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
      bundleReads: fakes.bundleReads.calls,
      ...handed.inputs,
    });

    expect(root.ports.stateReads).toBe(fakes.ports.stateReads);
    expect(root.ports.dataAccess).toBe(fakes.ports.dataAccess);
    expect(root.safety.bundle).toBe(fakes.ports.stateReads.safety.bundle);
    expect(root.pin).toBe(root.ports.bundles);
    expect(handed.calls).toEqual([]);
  });

  it("keeps all twenty-one ports closed on production, even handed every new input: no fake is reached, and its pin reads the closed bundle port", async () => {
    const fakes = skeletonFakes();
    const handed = handedFakes();
    const root = rootFor(fakes, handed.inputs, "production");

    expect(root.bindings).toEqual(PORTS.map((port) => ({ port, implementation: "closed" })));
    expect(await readAll(root)).toEqual(
      Object.fromEntries(
        READ_NAMES.map((read) => [
          read,
          failedWith(new NotJoinedError(READS[read] === "planCalls" ? "dataAccess" : "stateReads")),
        ]),
      ),
    );
    expect(root.pin).toBe(root.ports.bundles);
    await expect(root.pin.registry.readActiveBundle({})).rejects.toThrow(new NotJoinedError("bundles"));
    expect(handed.calls).toEqual([]);
    expect(handed.lines.asked).toEqual([]);
    expect(handed.lines.checked).toEqual([]);
    expect(reached(fakes)).toEqual(nothingReached(fakes));
  });
});
