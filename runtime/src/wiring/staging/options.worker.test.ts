// T-1257: stagingOptions(env) and the later parts' seams (./options.ts; the D-017 path audit's P1a, its wiring part;
// critic_size B3, B9, N1 and N3; critic_collisions B2, B6, B7, N1 and N4; the lead's notes DL-757 and DL-760), inside the
// Workers runtime, where T-1254's handle (./db.ts) loads. No database of its own: every env here is the test's, its
// bindings doubles that count each read (a counting double), and T-1254's handle is reached only to show it fails closed.
//
//   - production: stagingOptions reads ENVIRONMENT and nothing else, and gives every input null; the Worker's production
//     root reads none of staging's bindings or secrets (critic_collisions N1);
//   - staging, before any part binds its input: with every binding and secret present, stagingOptions reads ENVIRONMENT
//     alone, every stub gives its port's nothing-bound input with no binding read and no database call, and through the
//     Worker's root every port fails exactly as with nothing bound;
//   - the seams (DL-757; critic_collisions B6): models.ts gets P2b's bundle reads, the actor's BUNDLES KV (read at each
//     call) and the fetch seam (critic_size B9); tool-api-gate.ts gets the one BundleSafety adapter RootOptions.bundleSafety
//     holds; every part gets the one handle and env; and install() sets the copies' sources where the root holds them;
//   - the SEALING_WRAP_KEY-only resolver (critic_collisions N4): every other name refused before anything is read, the
//     secret read at each call;
//   - each call's timing on its trace (DL-760): one dbCall line, labels and numbers only.
// Values are made up (rule 9): 555-01xx numbers, .invalid hosts, made-up secrets and ids.
import type { FetchLike } from "@rosie/ai/src/gateway/types";
import type { Sql } from "@rosie/db/repo/scope";
import { runInDurableObject } from "cloudflare:test";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActorCopies } from "../../actor/copies";
import type { CopyDeps, StoppedFlagSource } from "../../actor/copies/types";
import {
  composeRoot,
  NoDatabaseError,
  NoLinqLineError,
  NoSafetyReaderError,
  NotJoinedError,
  workerRoot,
  type BundleReadCalls,
  type Root,
} from "../index";
import type { BundleSafetyLines } from "../real";
import { skeletonFakes } from "../test-support";
import { stagingBundleSafety } from "./bundle-safety";
import { stagingCopies } from "./copies";
import {
  DB_SIDES,
  DbClosedError,
  DbGuardRefusal,
  type DbCallTiming,
  type DbHandle,
  type DbHandleOptions,
  type DbSide,
} from "./db";
import { stagingFlags } from "./flags";
import { NO_RECEIPT_INPUTS, stagingReceiptCalls } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS, stagingTurnCalls } from "./k05-turn";
import { NO_MODEL_READER_INPUTS, stagingModels } from "./models";
import { NO_STAGING_INPUTS, stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type StagingDb, type StagingEnv, type StagingPart } from "./part";
import { sealingWrapKeys, WrappingKeyNameError } from "./secrets";
import { NO_SEND_INPUTS, stagingSendCalls } from "./send";
import { NO_DIRECTORY_INPUTS, stagingDirectories } from "./state-reads";
import { stagingTestPhone } from "./test-phone";
import { stagingGateReads } from "./tool-api-gate";
import { NO_ROW_INPUTS, stagingRowCalls } from "./tool-api-rows";

const TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
const OTHER_TRACE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const NUMBER = "+15555550100";
/** A made-up wrapping key: 32 bytes of 0x2a as base64, never a key of anything. */
const MADE_UP_WRAP_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));

/** The names staging's parts may read from the Worker's env: its bindings and the secrets they take by name. */
const STAGING_NAMES = [
  "DB_SCHEMA",
  "HYPERDRIVE_JOB",
  "HYPERDRIVE_APP",
  "HYPERDRIVE",
  "BUNDLES",
  "TEST_PHONE_LINE",
  "ROSIE_NUMBER",
  "SEALING_WRAP_KEY",
  "ANTHROPIC_API_KEY",
  "LINQ_WEBHOOK_SECRET",
] as const;

/** Every read of an env double: its own names, and a Hyperdrive binding's connection string as `<name>.connectionString`. */
interface Counted {
  readonly env: StagingEnv;
  readonly reads: string[];
}

/** A Hyperdrive binding double whose connection string counts its reads: a made-up host, nothing to connect to. */
function hyperdriveDouble(name: string, reads: string[]): object {
  return {
    get connectionString() {
      reads.push(`${name}.connectionString`);
      return `postgres://${name.toLowerCase()}.invalid:5432/none?sslmode=disable`;
    },
  };
}

/** A KV double for BUNDLES: every key misses, and each get is kept. */
function kvDouble(): { kv: KVNamespace; gets: unknown[][] } {
  const gets: unknown[][] = [];
  const kv = {
    get: (...args: unknown[]) => {
      gets.push(args);
      return Promise.resolve(null);
    },
  };
  return { kv: kv as unknown as KVNamespace, gets };
}

/**
 * The Worker's env for `environment` with every binding and secret staging's parts may read present, each read counted:
 * the vars as wrangler.jsonc gives them, made-up secrets, and doubles for the bindings.
 */
function countingEnv(environment: string, kv: KVNamespace = kvDouble().kv): Counted {
  const reads: string[] = [];
  const values: Record<string, unknown> = {
    ENVIRONMENT: environment,
    BASE_PATH: environment === "staging" ? "/test" : "",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    LINK_HOST: "rosfield.com",
    HYPERDRIVE_JOB: hyperdriveDouble("HYPERDRIVE_JOB", reads),
    HYPERDRIVE_APP: hyperdriveDouble("HYPERDRIVE_APP", reads),
    // env.production's placeholder binding (wrangler.jsonc): the handle never reads it.
    HYPERDRIVE: hyperdriveDouble("HYPERDRIVE", reads),
    BUNDLES: kv,
    TEST_PHONE_LINE: { idFromName: () => ({}), get: () => ({}) },
    ROSIE_NUMBER: NUMBER,
    SEALING_WRAP_KEY: MADE_UP_WRAP_KEY,
    ANTHROPIC_API_KEY: "t1257-made-up-model-key",
    LINQ_WEBHOOK_SECRET: `whsec_${btoa("t1257 made-up webhook secret")}`,
  };
  const env = new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { env: env as unknown as StagingEnv, reads };
}

/** The reads of staging's own names (its bindings and secrets), in order. */
const stagingReads = (reads: readonly string[]): string[] =>
  reads.filter((read) => STAGING_NAMES.some((name) => read === name || read.startsWith(`${name}.`)));

/** A handle that records each call and never reaches a database: a part's builder must make no call. */
function recordingDb(): { db: StagingDb; calls: string[] } {
  const calls: string[] = [];
  const refuse = (side: string, call: string): Promise<never> => {
    calls.push(`${side}:${call}`);
    return Promise.reject(new Error("a stub made a database call"));
  };
  return {
    db: {
      runtime: (call) => refuse("runtime", call),
      toolApi: (call) => refuse("toolApi", call),
      counts: () => ({
        opened: 0,
        ended: 0,
        connectionsOpen: 0,
        connectionsPeak: 0,
        quietReads: 0,
        quietWrites: 0,
      }),
    },
    calls,
  };
}

/** How a call ended: what it answered, or the name and message of what it threw. */
async function outcomeOf(call: () => unknown): Promise<string> {
  try {
    return `answered ${JSON.stringify(await call())}`;
  } catch (error) {
    return error instanceof Error ? `threw ${error.name}: ${error.message}` : "threw a non-error";
  }
}

const CHAT_OPEN = {
  eventId: "evt-t1257-1",
  handleId: "handle-t1257",
  service: "imessage",
  receivedAt: "2026-11-14T12:00:00Z",
  traceId: TRACE,
};

/** Every database, model and line call the staging inputs feed, as each port takes it (none reaches anything here). */
const PORT_CALLS: readonly (readonly [string, (root: Root) => unknown])[] = [
  ["the seal (handleKey)", (root) => root.gateway.keys.getOrCreateKey({ kind: "phone", address: NUMBER })],
  ["the chat open (chatOpenCall)", (root) => root.ports.chatOpen.openChatOnText(CHAT_OPEN)],
  ["the gateway's bundle id (bundleReads)", (root) => root.gateway.bundleId()],
  ["the pin's active bundle (bundleReads, bundleSafety)", (root) => root.pin.registry.readActiveBundle({})],
  ["a bundle value (bundleReads)", (root) => root.ports.bundles.registry.readBundleValue({ key: "t1257" })],
  ["the outage probe (bundleReads)", (root) => root.outage.probe()],
  [
    "the guard's targets (handleTargets)",
    (root) => root.ports.targets.handleTargets({ handleId: "handle-t1257" }),
  ],
  ["a commit (turnRows)", (root) => root.ports.turnRow.commitTurn({} as never)],
  ["a park (turnRows)", (root) => root.ports.turnRow.parkTurn({} as never)],
  ["a fixed line (bundleSafety)", (root) => root.ports.stateReads.safety.bundle.fixedLine("safetyEmergency")],
  [
    "an outcome's line (bundleSafety)",
    (root) => root.ports.stateReads.safety.bundle.outcomeLine("danger" as never),
  ],
  ["the danger words (bundleSafety)", (root) => root.ports.stateReads.safety.bundle.dangerWords()],
  [
    "the handle's ids (handleDirectory)",
    (root) => root.ports.stateReads.safety.directory.idsOf(`phone:${NUMBER}`),
  ],
  ["the stopped flag (stoppedFlags)", (root) => root.ports.stateReads.safety.isStopped(`phone:${NUMBER}`)],
  ["the party (turnDirectory)", (root) => root.turn.directory.partyOf({} as never)],
  ["the turn's unplanned rows (planCalls)", (root) => root.turn.rows.unplannedRows({} as never)],
  ["a row's plan (planCalls)", (root) => root.turn.rows.writePlan({} as never)],
  ["a safety read (safetyReaders)", (root) => root.ports.safetyRead.read({} as never)],
  [
    "a claim (outboxCalls)",
    (root) =>
      root.ports.outbox.claimOutbox({ claimer: "dispatcher-1", now: "2026-11-14T12:00:00Z", limit: 10 }),
  ],
  [
    "a send state (sendStateCall)",
    (root) => root.ports.sendState.sendState.sendStateFor({ outboxRowId: "outbox-t1257-1" } as never),
  ],
  ["a send (linqSendCall)", (root) => root.ports.linqSend.parts.sendPart({} as never)],
  ["an arming (armingCalls)", (root) => root.ports.arming.data.armClock({} as never)],
  ["a question's facts (armingCalls)", (root) => root.ports.arming.facts.questionFacts("oq-t1257-1")],
  ["an actor's name (armingCalls)", (root) => root.ports.arming.directory.actorNameOf("handle-t1257")],
];

/** Each port call's outcome on a root, in PORT_CALLS' order. */
async function outcomesOf(root: Root): Promise<string[]> {
  const outcomes: string[] = [];
  for (const [, call] of PORT_CALLS) outcomes.push(await outcomeOf(() => call(root)));
  return outcomes;
}

/** A Linq webhook's POST on staging's route, as the Worker hands it to the root. */
const linqPost = (): Request =>
  new Request("https://rosie.test/test/webhooks/linq", { method: "POST", body: "{}" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stagingOptions in production's environment (critic_collisions N1)", () => {
  it("reads ENVIRONMENT and nothing else, builds no part and gives every input null, whatever the env binds", () => {
    const fetchDouble = vi.fn<FetchLike>();
    for (const environment of ["production", "", "Staging", "preview"]) {
      const { env, reads } = countingEnv(environment);
      const built: string[] = [];
      const recorder = (name: string) => () => {
        built.push(name);
        return null;
      };

      const inputs = stagingOptions(env, {
        fetch: fetchDouble,
        builders: { flags: recorder("flags"), gate: recorder("gate"), testPhone: recorder("testPhone") },
      });

      expect(inputs, environment).toBe(NO_STAGING_INPUTS);
      expect(
        Object.values(inputs).every((input) => input === null),
        environment,
      ).toBe(true);
      expect(reads, environment).toEqual(["ENVIRONMENT"]);
      expect(built, environment).toEqual([]);
    }
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it("the Worker's production root reads none of staging's bindings or secrets: each port stays closed and the Linq route answers 404", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env, reads } = countingEnv("production");

    const root = workerRoot(env);

    expect(root.environment).toBe("production");
    expect(root.copies).toBeNull();
    expect(await outcomeOf(() => root.gateway.keys.getOrCreateKey({ kind: "phone", address: NUMBER }))).toBe(
      `threw NotJoinedError: ${new NotJoinedError("sealing").message}`,
    );
    expect(await outcomeOf(() => root.ports.chatOpen.openChatOnText(CHAT_OPEN))).toBe(
      `threw NotJoinedError: ${new NotJoinedError("chatOpen").message}`,
    );
    expect((await root.linqWebhook(linqPost())).status).toBe(404);
    expect(stagingReads(reads)).toEqual([]);
  });
});

describe("stagingOptions on staging, before any part binds its input", () => {
  it("reads ENVIRONMENT alone with every binding and secret present, and gives every input null: each stub's nothing-bound input", () => {
    const { env, reads } = countingEnv("staging");

    const inputs = stagingOptions(env);

    expect(inputs).toEqual(NO_STAGING_INPUTS);
    expect(Object.keys(inputs).sort()).toEqual(Object.keys(NO_STAGING_INPUTS).sort());
    expect(reads).toEqual(["ENVIRONMENT"]);
  });

  it("each part's stub, built alone over every binding present, gives its port's nothing-bound input, reads no binding and makes no database call", () => {
    const { env, reads } = countingEnv("staging");
    const { db, calls } = recordingDb();
    const part: StagingPart = { env, db };
    const keys = sealingWrapKeys(env);
    const kv = () => null;
    const fetchDouble = vi.fn<FetchLike>();

    expect(stagingFlags(part)).toBeNull();
    expect(stagingReceiptCalls({ ...part, keys })).toEqual(NO_RECEIPT_INPUTS);
    expect(stagingTurnCalls(part)).toEqual(NO_TURN_CALL_INPUTS);
    expect(stagingModels({ ...part, bundleReads: null, kv, fetch: fetchDouble })).toEqual(
      NO_MODEL_READER_INPUTS,
    );
    expect(stagingBundleSafety({ ...part, kv, bundleReads: null })).toBeNull();
    expect(stagingGateReads({ ...part, keys, bundleSafety: null })).toBeNull();
    expect(stagingRowCalls(part)).toEqual(NO_ROW_INPUTS);
    expect(stagingDirectories(part)).toEqual(NO_DIRECTORY_INPUTS);
    expect(stagingSendCalls(part)).toEqual(NO_SEND_INPUTS);
    expect(stagingTestPhone(part)).toBeNull();
    expect(stagingCopies(part)).toBeNull();

    expect(reads).toEqual([]);
    expect(calls).toEqual([]);
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it("through the Worker's root, every port it feeds fails exactly as with nothing bound, the Linq route answers 404, the page calls stay unconfigured, and no binding or secret is read", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env, reads } = countingEnv("staging");
    const vars = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };
    // Nothing bound: the root with no input at all, as every staging port was before T-1257.
    const nothingBound = composeRoot({
      environment: "staging",
      actors: null,
      vars,
      linq: { webhookSecret: () => undefined },
    });

    const root = workerRoot(env);
    const outcomes = await outcomesOf(root);

    expect(root.bindings).toEqual(nothingBound.bindings);
    expect(outcomes).toEqual(await outcomesOf(nothingBound));
    // Among them, the named refusals of the ports with nothing bound (./real.ts), never a call that went anywhere.
    expect(outcomes).toEqual(
      expect.arrayContaining([
        `threw NoDatabaseError: ${new NoDatabaseError("handleSealingKey").message}`,
        `threw NoDatabaseError: ${new NoDatabaseError("openChatOnText").message}`,
        `threw NoDatabaseError: ${new NoDatabaseError("readActiveBundle").message}`,
        `threw NoDatabaseError: ${new NoDatabaseError("commitTurn").message}`,
        `threw NoDatabaseError: ${new NoDatabaseError("unplannedRows").message}`,
        `threw NoSafetyReaderError: ${new NoSafetyReaderError().message}`,
        `threw NoLinqLineError: ${new NoLinqLineError().message}`,
      ]),
    );
    expect(outcomes.filter((outcome) => !outcome.startsWith("threw "))).toEqual([]);
    expect((await root.linqWebhook(linqPost())).status).toBe(404);
    expect(root.gateway.pages).toBeUndefined();
    expect(root.copies).toBeNull();
    expect(stagingReads(reads)).toEqual([]);
  });
});

describe("the later parts' seams (DL-757; critic_collisions B6; critic_size B9)", () => {
  it("hands models.ts P2b's bundle reads, the actor's BUNDLES KV read at each call and the fetch seam; hands tool-api-gate.ts the one BundleSafety adapter RootOptions.bundleSafety holds; and every part the one handle and env", async () => {
    const { kv: bundlesKv, gets } = kvDouble();
    const { env, reads } = countingEnv("staging", bundlesKv);
    const { db } = recordingDb();
    const fetchDouble = vi.fn<FetchLike>();
    const bundleReads: BundleReadCalls = {
      readActiveBundle: () => Promise.reject(new Error("not read here")),
      readBundleValue: () => Promise.reject(new Error("not read here")),
    };
    const adapter = { checkPin: () => Promise.resolve() } as unknown as BundleSafetyLines;
    const copies: CopyDeps = { timers: { liveTimers: () => Promise.resolve({ error: "transient" }) } };
    const parts: Record<string, Partial<StagingPart> & Record<string, unknown>> = {};
    const keep =
      <T>(name: string, answer: T) =>
      (part: StagingPart): T => {
        parts[name] = part as unknown as StagingPart & Record<string, unknown>;
        return answer;
      };
    const builders: Partial<StagingBuilders> = {
      receipt: keep("receipt", NO_RECEIPT_INPUTS),
      turn: keep("turn", { ...NO_TURN_CALL_INPUTS, bundleReads }),
      models: keep("models", NO_MODEL_READER_INPUTS),
      bundleSafety: keep("bundleSafety", adapter),
      gate: keep("gate", null),
      rows: keep("rows", NO_ROW_INPUTS),
      directories: keep("directories", NO_DIRECTORY_INPUTS),
      send: keep("send", NO_SEND_INPUTS),
      flags: keep("flags", null),
      testPhone: keep("testPhone", null),
      copies: keep("copies", copies),
    };

    const inputs: StagingInputs = stagingOptions(env, { fetch: fetchDouble, db, builders });

    // What RootOptions gets is what each part gave.
    expect(inputs.bundleReads).toBe(bundleReads);
    expect(inputs.bundleSafety).toBe(adapter);
    expect(inputs.copies).toBe(copies);
    // Every part: the one env and the one handle.
    expect(Object.keys(parts).sort()).toEqual(Object.keys(builders).sort());
    for (const [name, part] of Object.entries(parts)) {
      expect(part.env, name).toBe(env);
      expect(part.db, name).toBe(db);
    }
    // models.ts (DL-757): P2b's bundle reads, never read another way; BUNDLES; the fetch seam.
    expect(parts.models?.bundleReads).toBe(bundleReads);
    expect(parts.models?.fetch).toBe(fetchDouble);
    // bundle-safety.ts: the same reads and BUNDLES; tool-api-gate.ts: the one adapter, for SafetyDeps.words.
    expect(parts.bundleSafety?.bundleReads).toBe(bundleReads);
    expect(parts.bundleSafety?.kv).toBe(parts.models?.kv);
    expect(parts.gate?.bundleSafety).toBe(adapter);
    // The resolver: one, to the key call and the gate's sealer, SEALING_WRAP_KEY alone.
    expect(parts.gate?.keys).toBe(parts.receipt?.keys);
    expect((parts.gate?.keys as { name?: unknown } | undefined)?.name).toBe("SEALING_WRAP_KEY");
    // Nothing was read to build them but ENVIRONMENT: BUNDLES is read at each call of the KV getter, never before.
    expect(reads).toEqual(["ENVIRONMENT"]);
    const kv = (
      parts.models?.kv as (() => { get(key: string): Promise<string | null> } | null) | undefined
    )?.();
    expect(reads).toEqual(["ENVIRONMENT", "BUNDLES"]);
    expect(await kv?.get("bundles/t1257/manifest.json")).toBeNull();
    expect(gets).toEqual([["bundles/t1257/manifest.json", "text"]]);
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it("the fetch seam left out is the global fetch, read at each call, never when the root is built", async () => {
    const { env } = countingEnv("staging");
    const handed: { fetch?: FetchLike } = {};
    stagingOptions(env, {
      builders: {
        models: (part) => {
          handed.fetch = part.fetch;
          return NO_MODEL_READER_INPUTS;
        },
      },
    });
    // The global fetch is stood in only now, after the inputs were made: the seam reads it at the call.
    const globalFetch = vi.fn<FetchLike>(() => Promise.resolve(new Response("t1257")));
    vi.stubGlobal("fetch", globalFetch);

    const answer = await handed.fetch?.("https://t1257.invalid/v1/messages", { method: "POST" });

    expect(await answer?.text()).toBe("t1257");
    expect(globalFetch).toHaveBeenCalledWith("https://t1257.invalid/v1/messages", { method: "POST" });
  });

  it("install() sets the actor copies' sources where the root holds them and puts the earlier ones back; a root with none sets none", async () => {
    const namespace = poolEnv.HANDLE_ACTOR;
    if (namespace === undefined) throw new Error("env.staging binds no HANDLE_ACTOR");
    const stub = namespace.get(namespace.idFromName("t1257-copies-seam"));
    const reread = () =>
      runInDurableObject(stub, (_actor, state) =>
        new ActorCopies({ storage: state.storage, now: () => Date.now() }).rereadStopped("handle-t1257"),
      );
    const stoppedFlag = vi.fn<StoppedFlagSource["stoppedFlag"]>(() =>
      Promise.resolve({ result: "phone", stopped: false, phoneVersion: 1 }),
    );
    const copies: CopyDeps = {
      timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
      phones: { stoppedFlag },
    };
    const vars = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };
    const fake = { fake: skeletonFakes().ports };
    const held = composeRoot({ environment: "test", sets: fake, actors: null, vars, copies });
    const none = composeRoot({ environment: "test", sets: fake, actors: null, vars });

    expect(held.copies).toBe(copies);
    expect(none.copies).toBeNull();
    expect(await reread()).toBe("unwired");
    const restore = held.install();
    try {
      expect(await reread()).toBe("copied");
      expect(stoppedFlag).toHaveBeenCalledWith({ handleId: "handle-t1257" });
    } finally {
      restore();
    }
    expect(await reread()).toBe("unwired");
    const restoreNone = none.install();
    try {
      expect(await reread()).toBe("unwired");
    } finally {
      restoreNone();
    }
    expect(stoppedFlag).toHaveBeenCalledTimes(1);
  });
});

describe("the SEALING_WRAP_KEY-only resolver (critic_collisions N4)", () => {
  it("refuses every name but SEALING_WRAP_KEY before anything is read, naming only the one it takes", () => {
    const { env, reads } = countingEnv("staging");
    const keys = sealingWrapKeys(env);
    const refused = [
      "",
      "sealing_wrap_key",
      "Sealing_Wrap_Key",
      " SEALING_WRAP_KEY",
      "SEALING_WRAP_KEY ",
      "SEALING_WRAP_KEY_OLD",
      "SEALING_WRAP",
      "OTHER_WRAP_KEY",
      "LINQ_WEBHOOK_SECRET",
      "ANTHROPIC_API_KEY",
      "HYPERDRIVE_JOB",
      "constructor",
      "__proto__",
    ];

    for (const name of refused) {
      let thrown: unknown;
      try {
        void keys.resolve(name);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(WrappingKeyNameError);
      expect((thrown as Error).message, name).toBe("the wrapping key resolver reads SEALING_WRAP_KEY only");
    }
    expect(reads).toEqual([]);
    expect(keys.name).toBe("SEALING_WRAP_KEY");
    expect(reads).toEqual([]);
  });

  it("reads SEALING_WRAP_KEY from the env at each call, never when it is made, and gives undefined where it is not set", () => {
    let value: string | undefined = MADE_UP_WRAP_KEY;
    let read = 0;
    const env = {
      get SEALING_WRAP_KEY() {
        read += 1;
        return value;
      },
    };

    const keys = sealingWrapKeys(env);
    expect(read).toBe(0);
    expect(keys.resolve("SEALING_WRAP_KEY")).toBe(MADE_UP_WRAP_KEY);
    value = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(keys.resolve("SEALING_WRAP_KEY")).toBe(value);
    value = undefined;
    expect(keys.resolve("SEALING_WRAP_KEY")).toBeUndefined();
    expect(read).toBe(3);
  });
});

/** The connect's and the guard's times a handle double hands `timing`, as T-1254's handle times them. */
const CONNECT = { at: "2026-11-14T12:00:00.000Z", ms: 63 };
const GUARD = { at: "2026-11-14T12:00:00.063Z", ms: 18 };
const SQL = {} as unknown as Sql;

/** The env a handle double is made over: staging's vars. */
const STAGING_VARS: StagingEnv = {
  ENVIRONMENT: "staging",
  BASE_PATH: "/test",
  DB_SCHEMA: "",
  GIT_SHA: "test-sha",
};

/**
 * A stand-in for T-1254's handle, kept to its contract (./db.ts, the end of `call`): it waits for each call's connect and
 * guard (`gate`), then, once the guard has passed, hands `timing` the call's times and runs the call's code at once. A
 * refusal (`refuse`) throws before any timing and runs nothing.
 */
function handleDouble(
  options: { login?: string; refuse?: boolean; gate?: (call: string) => Promise<void> } = {},
): { open: (env: StagingEnv, handleOptions: DbHandleOptions) => DbHandle; opened: DbHandleOptions[] } {
  const opened: DbHandleOptions[] = [];
  const open = (_env: StagingEnv, handleOptions: DbHandleOptions): DbHandle => {
    opened.push(handleOptions);
    const run = async <T>(side: DbSide, call: string, fn: (sql: Sql) => Promise<T>): Promise<T> => {
      await (options.gate?.(call) ?? Promise.resolve());
      if (options.refuse === true) throw new DbGuardRefusal(side, ["session_user"]);
      const timing: DbCallTiming = {
        call,
        side,
        binding: DB_SIDES[side].binding,
        login: options.login ?? DB_SIDES[side].login,
        connect: CONNECT,
        guard: GUARD,
      };
      handleOptions.timing?.(timing);
      return fn(SQL);
    };
    return {
      runtime: (call, fn) => run("runtime", call, fn),
      toolApi: (call, fn) => run("toolApi", call, fn),
      counts: () => ({
        opened: 1,
        ended: 1,
        connectionsOpen: 0,
        connectionsPeak: 1,
        quietReads: 0,
        quietWrites: 0,
      }),
    };
  };
  return { open, opened };
}

const linesOf = (written: readonly string[]): unknown[] => written.map((line) => JSON.parse(line) as unknown);

describe("each database call's timing on its trace (DL-760)", () => {
  it("writes one dbCall line per call on the trace it names, before the call's own code runs: call, side, binding, login, connect and guard, labels and numbers only", async () => {
    const written: string[] = [];
    const order: string[] = [];
    const now = (): number => 0;
    const double = handleDouble();
    const db = stagingDb(STAGING_VARS, {
      now,
      write: (line) => {
        order.push("line");
        written.push(line);
      },
      open: double.open,
    });

    const job = await db.runtime(
      "handleSealingKey",
      () => {
        order.push("code");
        return Promise.resolve("job");
      },
      TRACE.toUpperCase(),
    );
    // The first call's line is written before its own code runs.
    expect(order).toEqual(["line", "code"]);
    const app = await db.toolApi("gateAndCommit", () => Promise.resolve("app"), OTHER_TRACE);

    expect([job, app]).toEqual(["job", "app"]);
    expect(double.opened).toHaveLength(1);
    expect(double.opened[0]?.now).toBe(now);
    expect(linesOf(written)).toEqual([
      {
        level: "info",
        msg: "dbCall",
        trace_id: TRACE,
        call: "handleSealingKey",
        side: "runtime",
        binding: "HYPERDRIVE_JOB",
        login: "rosie_worker_job",
        connect: CONNECT,
        guard: GUARD,
        environment: "staging",
        version: "test-sha",
      },
      {
        level: "info",
        msg: "dbCall",
        trace_id: OTHER_TRACE,
        call: "gateAndCommit",
        side: "toolApi",
        binding: "HYPERDRIVE_APP",
        login: "rosie_worker_app",
        connect: CONNECT,
        guard: GUARD,
        environment: "staging",
        version: "test-sha",
      },
    ]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1 });
  });

  it("a call that names no trace, or a value that is no trace id, is written on no trace, and that value is never written", async () => {
    const written: string[] = [];
    const db = stagingDb(STAGING_VARS, { write: (line) => written.push(line), open: handleDouble().open });

    for (const traceId of [undefined, null, "", NUMBER, "not-a-trace-id", `${TRACE}0`, `${TRACE} `]) {
      await db.runtime("readFlag", () => Promise.resolve(null), traceId);
    }

    expect(linesOf(written).map((line) => (line as { trace_id: unknown }).trace_id)).toEqual(
      Array.from({ length: 7 }, () => null),
    );
    expect(written.join("\n")).not.toContain(NUMBER);
    expect(written.join("\n")).not.toContain("not-a-trace-id");
  });

  it("two calls at once each write their own line on their own trace", async () => {
    const written: string[] = [];
    const waits = new Map<string, () => void>();
    const gate = (call: string): Promise<void> =>
      new Promise((resolve) => {
        waits.set(call, resolve);
      });
    const db = stagingDb(STAGING_VARS, {
      write: (line) => written.push(line),
      open: handleDouble({ gate }).open,
    });

    const first = db.runtime("first", () => Promise.resolve(1), TRACE);
    const second = db.toolApi("second", () => Promise.resolve(2), OTHER_TRACE);
    await vi.waitFor(() => {
      expect(waits.size).toBe(2);
    });
    // The second call's guard passes first.
    waits.get("second")?.();
    await vi.waitFor(() => {
      expect(written).toHaveLength(1);
    });
    waits.get("first")?.();

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(
      linesOf(written).map((line) => {
        const { call, side, trace_id: traceId } = line as { call: string; side: string; trace_id: string };
        return { call, side, traceId };
      }),
    ).toEqual([
      { call: "second", side: "toolApi", traceId: OTHER_TRACE },
      { call: "first", side: "runtime", traceId: TRACE },
    ]);
  });

  it("a call name or a login that is no label is written as null; a refused call writes no line and runs nothing", async () => {
    const written: string[] = [];
    const code = vi.fn(() => Promise.resolve(null));
    const odd = stagingDb(STAGING_VARS, {
      write: (line) => written.push(line),
      open: handleDouble({ login: NUMBER }).open,
    });
    const refused = stagingDb(STAGING_VARS, {
      write: (line) => written.push(line),
      open: handleDouble({ refuse: true }).open,
    });

    await odd.runtime("read the flag", () => Promise.resolve(null), TRACE);
    await expect(refused.runtime("readFlag", code, TRACE)).rejects.toThrow(DbGuardRefusal);

    expect(code).not.toHaveBeenCalled();
    expect(linesOf(written)).toEqual([
      expect.objectContaining({ trace_id: TRACE, call: null, login: null, side: "runtime" }),
    ]);
    expect(written.join("\n")).not.toContain(NUMBER);
  });

  it("a handle that cannot be made fails the call and is tried again at the next call; the default line goes to console.log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const double = handleDouble();
    let tries = 0;
    const db = stagingDb(STAGING_VARS, {
      open: (env, options) => {
        tries += 1;
        if (tries === 1) throw new Error("t1257: the handle could not be made");
        return double.open(env, options);
      },
    });

    await expect(db.runtime("readFlag", () => Promise.resolve(null), TRACE)).rejects.toThrow(
      "t1257: the handle could not be made",
    );
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
    await db.runtime("readFlag", () => Promise.resolve(null), TRACE);

    expect(tries).toBe(2);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toEqual([
      expect.objectContaining({ msg: "dbCall", trace_id: TRACE, call: "readFlag" }),
    ]);
  });

  it("left to its default, the handle is T-1254's, loaded at the first call: production and an env with no binding fail closed with nothing read or written, and the pool's own HYPERDRIVE_JOB fails at its connect with no line", async () => {
    const written: string[] = [];
    const code = vi.fn(() => Promise.resolve(null));
    const production = countingEnv("production");
    const noBinding: StagingEnv = { ...STAGING_VARS };

    const inProduction = stagingDb(production.env, { write: (line) => written.push(line) });
    const unbound = stagingDb(noBinding, { write: (line) => written.push(line) });
    const pool = stagingDb(
      { ...STAGING_VARS, HYPERDRIVE_JOB: (poolEnv as unknown as { HYPERDRIVE_JOB: unknown }).HYPERDRIVE_JOB },
      { write: (line) => written.push(line) },
    );

    await expect(inProduction.runtime("readFlag", code, TRACE)).rejects.toThrow(
      new DbClosedError("readFlag", "runtime", "notStaging"),
    );
    await expect(unbound.toolApi("gateAndCommit", code, TRACE)).rejects.toThrow(
      new DbClosedError("gateAndCommit", "toolApi", "noBinding"),
    );
    await expect(pool.runtime("readFlag", code, TRACE)).rejects.toMatchObject({
      name: "DataAccessDatabaseError",
      call: "readFlag",
    });

    expect(code).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(stagingReads(production.reads)).toEqual([]);
    expect(inProduction.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(pool.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  });
});
