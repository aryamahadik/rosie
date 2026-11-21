// T-1415: staging's gate sends a keyword turn whose caller names no business to T-1413's keyword door (the CQ-335
// ruling's NEW-3; DL-864, DL-877, DL-883), inside the Workers runtime, through a root built as workerRoot builds the
// Worker's (composeRoot over stagingOptions) and T-1254's handle, every call through the pool's Hyperdrive bindings.
//
// The database: this file has none of its own (infra/test-rig/files.mjs names none for it), so it reads, and never
// writes, T-1398's (key TOOL_API_GATE: migrated, bundle v0 active, seeded by ./tool-api-gate.seed.ts) through that file's
// pair. Nothing here can write: every root's commitTurn is a double that keeps the K-05 request and writes nothing
// (`keptTurnRows`), the door's transaction is read only, the sealer only reads, and a business-scoped gate here fails
// before its commit. The rows read are made-up ids that hold nothing, and the gate's seed's no-wrap texter (its handle,
// person and key, of which that file writes nothing), so what that file reads and counts is never changed by this one.
//
//   - A no-business STOP (K-09 v1 stop-recorded.json's request) reaches the door on a runtime-side client: its first call
//     is gateAndCommit on HYPERDRIVE_JOB as rosie_worker_job, every call after it is on the runtime side, the Tool API's
//     binding is never read, and the door records no span (TURN_RECORDS_GATE). A writer with no key stops at the
//     read-only sealer (noSealingKey); the no-wrap texter's STOP runs its reads on the door's transaction and reaches the
//     turn-row port's commitTurn with no business anywhere in it. With a person set on its client, the door refuses before
//     any read (db/repo/targets.ts enterKeywordDoorSide on staging's client).
//   - A business-scoped call goes to the Tool API base unchanged: the same answer and the same calls as a gate with no
//     door, its flags call notBuilt (portNotWired: DL-877 C5); and through a gate with no door the STOP answers the base's
//     noBusinessScope with nothing read, as before this card.
//   - The slots: the door's calls take the gate's 3 (GATE_CLIENTS_AT_ONCE), so a fourth call waits for one, either way
//     round, and six at once stay at 6 connections or fewer, opened equal to ended.
//   - Unbound (neither binding, or either alone): the input is null, so the STOP answers noBusinessScope with nothing read;
//     production: no binding read, the gate closed.
//   - No line holds a number or a message word, and no rejection is left unhandled.
// No test here fetches: the pool's outbound tripwire (T-1411) would fail one that did, and none needs a host claimed.
// Test values only (rule 9): K-09's fixture, made-up ids, whole fiction-range 555-01xx numbers (the fixture's and the
// gate's seed's), and that seed's made-up wrapping key.
import { TurnFaceRefusedError } from "@rosie/actions/src/tool-api/turn-face/errors";
import stopRecorded from "@rosie/contracts/tool-api/fixtures/stop-recorded.json";
import { BusinessScopeError, type Sql } from "@rosie/db/repo/scope";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { turnIdOf } from "../../actor/lease";
import { openTrace, type Span, type TraceContext } from "../../trace";
import { composeRoot, NotJoinedError, workerRoot, type Root } from "../index";
import type { GateReads, TurnRowCalls } from "../real";
import { BUNDLE_V0 } from "../test-support";
import { CONNECTIONS_PER_CLIENT, DB_SIDES, dbHandle, type DbSide } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS, stagingTurnCalls } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { stagingOptions, type StagingBuilders } from "./options";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { GATE_CALLS, GATE_CLIENTS_AT_ONCE, stagingGateReads } from "./tool-api-gate";
import { BARBERSHOP, NO_WRAP_KEY, TEST_WRAP_KEY, WRAP_KEY_NAME } from "./tool-api-gate.seed";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** The database this file reads: T-1398's, by its key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "TOOL_API_GATE";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The connections a Worker may hold open at once (infra/spikes/hyperdrive-host/worker.mjs line 77). */
const WORKER_CONNECTIONS = 6;
/** A run through the Workers runtime's own steps and PostgreSQL: a resource guard above the project's default. */
const TEST_MS = 60_000;
/** How long the slots' three clients may take to open and pass their guards: a resource guard, as TEST_MS is. */
const HOLD_WAIT = { timeout: 30_000, interval: 20 } as const;
const V0 = BUNDLE_V0;

type Json = Record<string, unknown>;

const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- what this file's isolate wrote and rejected ---------------------------------------------------------------------

const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

/** Every line written on the console and by a handle while this file's tests ran, and the running test's own. */
const everyLine: string[] = [];
let lines: string[] = [];
/** Every span a test's trace wrote. */
const SPANS: Span[] = [];
/** Every handle a test made: checked after each test. */
const HANDLES: StagingDb[] = [];

beforeEach(() => {
  lines = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    lines.push(line);
    everyLine.push(line);
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(keep);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended, its sockets with it.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
});

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsed(line: string): Json {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("a log line is not a JSON object");
  return value;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** Lets every call that can go on do so: macrotasks, so a socket's reads and the handle's steps run too. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

// ---- envs, handles and roots -----------------------------------------------------------------------------------------

interface Counted {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

/** A double over a pool binding that counts the reads of its connection string (and gives the pool binding's). */
function counted(binding: Hyperdrive): Counted {
  const reads = { n: 0 };
  return {
    binding: {
      get connectionString(): string {
        reads.n += 1;
        return binding.connectionString;
      },
    },
    reads,
  };
}

interface TestEnv {
  readonly env: StagingEnv;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
  readonly job: Counted | null;
  readonly app: Counted | null;
}

/** An env of the test's own: staging's vars (or `environment`), the borrowed pair behind counting doubles, the made-up key. */
function envOf(options: { environment?: string; job?: boolean; app?: boolean } = {}): TestEnv {
  const names: string[] = [];
  const job = options.job === false ? null : counted(poolBinding(JOB));
  const app = options.app === false ? null : counted(poolBinding(APP));
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    [WRAP_KEY_NAME]: TEST_WRAP_KEY,
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    ...(app === null ? {} : { HYPERDRIVE_APP: app.binding }),
  };
  const env = new Proxy(values, {
    get(target, name, receiver): unknown {
      if (typeof name === "string") names.push(name);
      return Reflect.get(target, name, receiver);
    },
    has(target, name): boolean {
      if (typeof name === "string") names.push(name);
      return Reflect.has(target, name);
    },
  });
  return { env: env as unknown as StagingEnv, names, job, app };
}

/** The root's handle over an env, each of its timing lines kept in `written`. */
function handleOver(env: StagingEnv, written: Json[]): StagingDb {
  const db = stagingDb(env, {
    write: (line) => {
      everyLine.push(line);
      written.push(parsed(line));
    },
  });
  HANDLES.push(db);
  return db;
}

/** Thrown by `keptTurnRows` in K-05's place: what a commit reached it with is kept, and nothing is written. */
class CommitStoodIn extends Error {
  override name = "CommitStoodIn";

  constructor() {
    super("t1415: K-05's commitTurn is stood in here: nothing is written");
  }
}

/** The turn's rows as a double: each commitTurn request kept (a copy) and refused, so nothing is ever written. */
function keptTurnRows(commits: Json[]): TurnRowCalls {
  return {
    commitTurn: (request) => {
      commits.push(structuredClone(request));
      return Promise.reject(new CommitStoodIn());
    },
    parkTurn: () => Promise.reject(new CommitStoodIn()),
  };
}

/** Every part off the door's path, stood in by its nothing-bound answer (DL-776). */
const OFF_THE_DOOR_PATH: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  bundleSafety: () => null,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
  email: () => null,
  signIn: () => null,
};

/** Every part but this card's stood in, T-1395's turn calls too: what such a build reads is this part's alone. */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  ...OFF_THE_DOOR_PATH,
  turn: () => NO_TURN_CALL_INPUTS,
};

/** The gate's input as main had it before this card: its five pieces, no door. */
function withoutDoor(reads: GateReads | null): GateReads | null {
  if (reads === null) return null;
  return {
    scope: reads.scope,
    readOpenHolds: reads.readOpenHolds,
    safetyReads: reads.safetyReads,
    sealer: reads.sealer,
    ...(reads.words === undefined ? {} : { words: reads.words }),
  };
}

interface Rooted {
  readonly root: Root;
  readonly gate: GateReads;
  /** Each commitTurn request the turn-row port sent, kept and refused. */
  readonly commits: Json[];
}

/**
 * A root built as workerRoot builds the Worker's, on `db`: this card's part by its own builder (with its door, or as main
 * had it), T-1395's bundle reads by theirs (the gate's and the door's bundle port), and the turn's rows kept and refused.
 */
function rootOn(testEnv: TestEnv, db: StagingDb, options: { door?: boolean } = {}): Rooted {
  const commits: Json[] = [];
  const inputs = stagingOptions(testEnv.env, {
    db,
    builders: {
      ...OFF_THE_DOOR_PATH,
      turn: (part) => ({
        ...stagingTurnCalls(part),
        handleTargets: null,
        frontierScope: null,
        turnRows: keptTurnRows(commits),
      }),
      ...(options.door === false
        ? { gate: (part) => withoutDoor(stagingGateReads(part)) }
        : { gate: stagingGateReads }),
    },
  });
  const root = composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });
  if (inputs.gateReads === null) throw new Error("the gate is bound on the borrowed pair");
  return { root, gate: inputs.gateReads, commits };
}

/** One timing line as [call, side, binding, login]. */
type CallOn = readonly [unknown, unknown, unknown, unknown];

const onJob = (call: string): CallOn => [call, "runtime", DB_SIDES.runtime.binding, DB_SIDES.runtime.login];
const onApp = (call: string): CallOn => [call, "toolApi", DB_SIDES.toolApi.binding, DB_SIDES.toolApi.login];

/** Each call a handle timed, in order, its every line labels and numbers only. */
function callsOf(written: readonly Json[]): CallOn[] {
  for (const line of written) {
    expect(Object.keys(line).sort()).toEqual([
      "binding",
      "call",
      "connect",
      "environment",
      "guard",
      "level",
      "login",
      "msg",
      "side",
      "trace_id",
      "version",
    ]);
    expect(line).toMatchObject({ level: "info", msg: "dbCall", environment: "staging", version: "test-sha" });
  }
  return written.map((line) => [line.call, line.side, line.binding, line.login]);
}

/** The test's own handle on the borrowed pair, for its reads of what the database holds: it never writes. */
const own = dbHandle(
  {
    ENVIRONMENT: "staging",
    DB_SCHEMA: "",
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
  },
  { log: () => undefined },
);

// ---- the STOPs --------------------------------------------------------------------------------------------------------

/** K-09 v1 stop-recorded.json: Ben's bare STOP, a turn's core-only call whose caller names no business. */
const STOP = stopRecorded as unknown as { readonly request: Json };

/** stop-recorded.json's own ids, as its request names them. */
const FIXTURE = {
  turnId: "turn-ben-stop",
  traceId: "trace-ben-0007",
  eventId: "evt-ben-0007",
  handleId: "handle-ben",
  personId: "person-ben",
  number: "+15555550131",
} as const;

/** Who texts STOP: a handle, its person, its number and the text's event id. */
interface Stopper {
  readonly handleId: string;
  readonly personId: string;
  readonly number: string;
  readonly eventId: string;
}

/** A made-up writer whose ids hold nothing in this database (no handle, person or key): the fixture's own number. */
const nobody = (name: string): Stopper => ({
  handleId: `handle-t1415-${name}`,
  personId: `person-t1415-${name}`,
  number: FIXTURE.number,
  eventId: `evt-t1415-${name}`,
});

/** The gate's seed's no-wrap texter (a handle at its number, its person and that person's key), texting STOP. */
const NO_WRAP: Stopper = { ...NO_WRAP_KEY, eventId: "evt-t1415-no-wrap-stop" };

/** One gate call: its K-09 request, its turn id and the trace it runs in. */
interface GateCall {
  readonly request: Json;
  readonly turnId: string;
  readonly trace: TraceContext;
}

/** A trace of its own under bundle v0, set to the turn, its spans kept. */
function traced(turnId: string): TraceContext {
  const trace = openTrace({ openedBy: "textWebhook", bundleId: { ...V0 }, sink: (span) => SPANS.push(span) });
  trace.setTurn(turnId);
  return trace;
}

/** The spans a trace wrote. */
const spansOf = (trace: TraceContext): Span[] => SPANS.filter((span) => span.trace_id === trace.traceId);

/**
 * stop-recorded.json's request for `who`: each id of the fixture's swapped for the writer's wherever the request names it
 * as a whole string, under the turn id the lease hashes from its event ids, on a trace of its own, the turn pinned to
 * bundle v0. `businessId`: a business the caller and each core action's caller name instead of none. `stopOnly`: the STOP
 * alone, its text's record not riding.
 */
async function stopGate(
  who: Stopper,
  options: { readonly businessId?: string; readonly stopOnly?: boolean } = {},
): Promise<GateCall> {
  const turnId = await turnIdOf([who.eventId]);
  const trace = traced(turnId);
  const pairs: readonly (readonly [string, string])[] = [
    [FIXTURE.turnId, turnId],
    [FIXTURE.traceId, trace.traceId],
    [FIXTURE.eventId, who.eventId],
    [FIXTURE.handleId, who.handleId],
    [FIXTURE.personId, who.personId],
    [FIXTURE.number, who.number],
  ];
  let text = JSON.stringify(STOP.request);
  for (const [from, to] of pairs) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  const request = JSON.parse(text) as Json & {
    caller: Json;
    turn: Json;
    core: { call: string; request: { caller: Json } }[];
  };
  request.turn.bundleId = { ...V0 };
  if (options.businessId !== undefined) {
    request.caller.businessId = options.businessId;
    for (const action of request.core) action.request.caller.businessId = options.businessId;
  }
  if (options.stopOnly === true)
    request.core = request.core.filter((action) => action.call === "recordStopOrStart");
  return { request, turnId, trace };
}

/** Nothing open at commit time (the lease's CommitContext). */
const NOTHING_OPEN = { holds: [], unread: [] };

/** One gateAndCommit through the root's gate port, as the turn makes it (a throw as a rejection). */
function gateOn(root: Root, call: GateCall): Promise<unknown> {
  return root.turn.toolApi.gateAndCommit(call.request as never, NOTHING_OPEN, call.trace);
}

/** K-09's answer to a gateAndCommit whose commit is not built yet, the base's or the door's. */
const NOT_BUILT = { error: "notBuilt", call: "gateAndCommit" } as const;
const NO_BUSINESS_SCOPE = { error: "noBusinessScope", call: "gateAndCommit" } as const;

/** Every value of a field named businessId or business_id anywhere in `value`. */
function businessIdsIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(businessIdsIn);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, field]) => [
    ...(key === "businessId" || key === "business_id" ? [field] : []),
    ...businessIdsIn(field),
  ]);
}

// ---- the borrowed database ---------------------------------------------------------------------------------------------

describe("the database this file reads: T-1398's, never written here", () => {
  it("the rig made it with bundle v0 active; the made-up writers hold nothing in it, and the no-wrap texter its handle, person and key alone", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_tool_api_gate$/u);
    const held = await own.runtime("t1415Held", async (sql) => ({
      active: await sql<{ hash: string; build: number }[]>`select hash, build from bundles where active`,
      keys: await sql<{ person_id: string }[]>`
        select person_id from sealing_keys where person_id in ${sql([nobody("nobody").personId, NO_WRAP.personId])}
      `,
      handles: await sql<{ id: string; address: string }[]>`
        select id, address from handles where id in ${sql([nobody("nobody").handleId, NO_WRAP.handleId])}
      `,
      phones: await sql<
        { n: number }[]
      >`select count(*)::int as n from phones where handle_id = ${NO_WRAP.handleId}`,
    }));
    expect(held.active).toEqual([V0]);
    expect(held.keys).toEqual([{ person_id: NO_WRAP.personId }]);
    expect(held.handles).toEqual([{ id: NO_WRAP.handleId, address: NO_WRAP.number }]);
    // The no-wrap texter's first text is never committed (T-1398's seed), so its number has no phone row.
    expect(held.phones).toEqual([{ n: 0 }]);
  });
});

// ---- a no-business STOP: the door, on the runtime side ---------------------------------------------------------------

describe("a no-business STOP reaches the keyword door on a runtime-side client and never opens a Tool API client", () => {
  it(
    "stop-recorded.json from a writer with no key: the door's transaction is the first call (gateAndCommit, HYPERDRIVE_JOB, rosie_worker_job), every call is on the runtime side, the read-only sealer refuses it (noSealingKey), the Tool API's binding is never read, and the door records no span",
    { timeout: TEST_MS },
    async () => {
      const testEnv = envOf();
      const written: Json[] = [];
      const db = handleOver(testEnv.env, written);
      const { root, commits } = rootOn(testEnv, db);
      const call = await stopGate(nobody("nobody"));

      const thrown = await rejectionOf(gateOn(root, call));

      expect(thrown).toBeInstanceOf(TurnFaceRefusedError);
      expect(thrown).toMatchObject({ fault: "noSealingKey" });
      const calls = callsOf(written);
      expect(calls[0]).toEqual(onJob(GATE_CALLS.door));
      expect(calls.filter(([name]) => name === GATE_CALLS.door)).toEqual([onJob(GATE_CALLS.door)]);
      expect(calls.at(-1)).toEqual(onJob(GATE_CALLS.seal));
      expect(calls).toEqual(calls.map(([name]) => onJob(String(name))));
      expect(testEnv.app?.reads.n).toBe(0);
      expect(testEnv.job?.reads.n).toBe(calls.length);
      // The turn-row port was never reached, and the door wrote no span: the turn records the gate hop.
      expect(commits).toEqual([]);
      expect(spansOf(call.trace)).toEqual([]);
      const counts = db.counts();
      expect(counts).toMatchObject({ opened: calls.length, ended: calls.length, connectionsOpen: 0 });
      // The door's transaction held while each call after it ran on a client of its own, one at a time.
      expect(counts.connectionsPeak).toBe(2 * CONNECTIONS_PER_CLIENT);
      expect(lines).toEqual([]);
    },
  );

  it(
    "the no-wrap texter's STOP: sealed under its key, its reads run on the door's transaction, and the commit reaches the turn-row port's commitTurn, its turn the request's and no business anywhere in it; nothing written",
    { timeout: TEST_MS },
    async () => {
      const testEnv = envOf();
      const written: Json[] = [];
      const db = handleOver(testEnv.env, written);
      const { root, commits } = rootOn(testEnv, db);
      const call = await stopGate(NO_WRAP);

      const thrown = await rejectionOf(gateOn(root, call));

      expect(thrown).toBeInstanceOf(CommitStoodIn);
      expect(commits).toHaveLength(1);
      const [commit] = commits;
      expect(commit?.turn).toEqual({
        id: call.turnId,
        handleId: NO_WRAP.handleId,
        eventIds: [NO_WRAP.eventId],
        bundleId: V0,
        traceId: call.trace.traceId,
        joinedTraceIds: [],
        tries: 1,
      });
      const businesses = businessIdsIn(commit?.writes);
      expect(businesses.length).toBeGreaterThan(0);
      expect(businesses.every((businessId) => businessId === null)).toBe(true);
      const calls = callsOf(written);
      expect(calls[0]).toEqual(onJob(GATE_CALLS.door));
      expect(calls.map(([name]) => name)).toContain(GATE_CALLS.seal);
      expect(calls).toEqual(calls.map(([name]) => onJob(String(name))));
      expect(testEnv.app?.reads.n).toBe(0);
      expect(spansOf(call.trace)).toEqual([]);
      expect(db.counts().connectionsPeak).toBe(2 * CONNECTIONS_PER_CLIENT);
      expect(lines).toEqual([]);
    },
  );

  it("the door's own checks come first on staging's client: with a person set on it, the door refuses before any read (no call after its own), and nothing reaches the sealer or the commit", async () => {
    const testEnv = envOf();
    const written: Json[] = [];
    const handle = handleOver(testEnv.env, written);
    // The door's client with a person acted for, set on its session before the door gets it.
    const db: StagingDb = {
      toolApi: (call, fn, traceId) => handle.toolApi(call, fn, traceId),
      runtime: (call, fn, traceId) =>
        handle.runtime(
          call,
          async (sql) => {
            if (call === GATE_CALLS.door)
              await sql`select set_config('rosie.person_id', 'person-t1415-acted', false)`;
            return fn(sql);
          },
          traceId,
        ),
      counts: () => handle.counts(),
    };
    const { root, commits } = rootOn(testEnv, db);

    const thrown = await rejectionOf(gateOn(root, await stopGate(NO_WRAP)));

    expect(thrown).toBeInstanceOf(BusinessScopeError);
    expect((thrown as Error).message).toBe(
      "gateAndCommit on the keyword door acts for no one: rosie.person_id is never set",
    );
    expect(callsOf(written)).toEqual([onJob(GATE_CALLS.door)]);
    expect(commits).toEqual([]);
    expect(testEnv.app?.reads.n).toBe(0);
  });
});

// ---- a business-scoped call: the base, unchanged ---------------------------------------------------------------------

describe("a business-scoped call goes to the Tool API base unchanged", () => {
  it(
    "the STOP under the barbershop: the same answer and the same calls with the door bound as with none (the base's scope on the Tool API's side, notBuilt: its flags call portNotWired), and never the door's transaction; with no door, the no-business STOP answers noBusinessScope with nothing read, as before",
    { timeout: TEST_MS },
    async () => {
      const run = async (door: boolean, call: GateCall) => {
        const testEnv = envOf();
        const written: Json[] = [];
        const db = handleOver(testEnv.env, written);
        const { root, commits } = rootOn(testEnv, db, { door });
        const answer = await gateOn(root, call);
        return {
          answer,
          calls: callsOf(written),
          commits,
          reads: [testEnv.job?.reads.n, testEnv.app?.reads.n],
        };
      };

      const scoped = await stopGate(nobody("scoped"), { businessId: BARBERSHOP, stopOnly: true });
      const withDoor = await run(true, scoped);
      const withNone = await run(false, { ...scoped, request: structuredClone(scoped.request) });

      expect(withDoor.answer).toEqual(NOT_BUILT);
      expect(withNone.answer).toEqual(NOT_BUILT);
      expect(withDoor.calls).toEqual(withNone.calls);
      expect(withDoor.calls[0]).toEqual(onApp(GATE_CALLS.scope));
      expect(withDoor.calls.filter(([, side]) => side === "toolApi")).toEqual([onApp(GATE_CALLS.scope)]);
      expect(withDoor.calls.slice(1)).toEqual(withDoor.calls.slice(1).map(([name]) => onJob(String(name))));
      expect(withDoor.calls.map(([name]) => name).slice(1)).not.toContain(GATE_CALLS.door);
      expect([withDoor.commits, withNone.commits]).toEqual([[], []]);
      expect(spansOf(scoped.trace)).toEqual([]);

      // Before this card, and wherever no door is bound: the base refuses a call naming no business before anything.
      const bare = await run(false, await stopGate(nobody("bare")));
      expect(bare).toEqual({ answer: NO_BUSINESS_SCOPE, calls: [], commits: [], reads: [0, 0] });
    },
  );
});

// ---- the slots: the door's calls take the gate's ---------------------------------------------------------------------

interface SlotWatch {
  readonly db: StagingDb;
  /** Lets every call but the slots' own go on: until then each waits, so each slot's client is held while it waits. */
  release(): void;
  /** The clients a slot holds now (a gate's Tool API client or a door's transaction), past their guard. */
  inUse(): number;
  peak(): number;
  /** The side of each slot's client, in the order they were opened. */
  readonly entered: DbSide[];
}

/** A handle whose slots' clients are counted and whose every other call waits for `release`; each call the handle's own. */
function slotWatch(handle: StagingDb): SlotWatch {
  let inUse = 0;
  let peak = 0;
  const entered: DbSide[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding =
    <T>(side: DbSide, fn: (sql: Sql) => Promise<T>) =>
    async (sql: Sql): Promise<T> => {
      inUse += 1;
      peak = Math.max(peak, inUse);
      entered.push(side);
      try {
        return await fn(sql);
      } finally {
        inUse -= 1;
      }
    };
  return {
    release: () => {
      release();
    },
    inUse: () => inUse,
    peak: () => peak,
    entered,
    db: {
      toolApi: (call, fn, traceId) =>
        call === GATE_CALLS.scope
          ? handle.toolApi(call, holding("toolApi", fn), traceId)
          : handle.toolApi(call, fn, traceId),
      async runtime(call, fn, traceId) {
        if (call === GATE_CALLS.door) return handle.runtime(call, holding("runtime", fn), traceId);
        await released;
        return handle.runtime(call, fn, traceId);
      },
      counts: () => handle.counts(),
    },
  };
}

/** The STOP under the barbershop, its record not riding: through the base, it answers notBuilt and writes nothing. */
const scopedCall = (name: string): Promise<GateCall> =>
  stopGate(nobody(name), { businessId: BARBERSHOP, stopOnly: true });

/** A no-business STOP from a writer with no key: through the door, the sealer refuses it and nothing is written. */
const doorCall = (name: string): Promise<GateCall> => stopGate(nobody(name));

describe("the slots: the door's calls take the gate's three, so the gates still hold 6 connections at most", () => {
  it.each([
    {
      holding: "three business-scoped gates",
      waiting: "a no-business STOP",
      first: scopedCall,
      then: doorCall,
    },
    {
      holding: "three no-business STOPs",
      waiting: "a business-scoped gate",
      first: doorCall,
      then: scopedCall,
    },
  ])(
    "$holding hold the slots: $waiting waits for one before its client is opened, then takes the first one freed",
    { timeout: TEST_MS },
    async ({ first, then }) => {
      const testEnv = envOf();
      const written: Json[] = [];
      const watch = slotWatch(handleOver(testEnv.env, written));
      const { root, commits } = rootOn(testEnv, watch.db);
      const holders = await Promise.all(["one", "two", "three"].map((name) => first(`slot-${name}`)));
      const waiter = await then("slot-four");
      const started: Promise<unknown>[] = [];
      try {
        started.push(...holders.map((call) => gateOn(root, call)));
        await vi.waitFor(() => {
          expect(watch.inUse()).toBe(GATE_CLIENTS_AT_ONCE);
        }, HOLD_WAIT);
        started.push(gateOn(root, waiter));
        await settle();
        // The fourth has opened no client: the three slots' are the only ones, each held.
        const [side] = watch.entered;
        expect(watch.entered).toEqual([side, side, side]);
        expect(watch.db.counts()).toMatchObject({
          opened: GATE_CLIENTS_AT_ONCE,
          connectionsOpen: GATE_CLIENTS_AT_ONCE,
        });

        watch.release();
        const outcomes = await Promise.allSettled(started);

        expect(watch.entered).toHaveLength(GATE_CLIENTS_AT_ONCE + 1);
        expect(watch.entered.at(-1)).not.toBe(side);
        expect(watch.peak()).toBe(GATE_CLIENTS_AT_ONCE);
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") expect(outcome.value).toEqual(NOT_BUILT);
          else expect(outcome.reason).toMatchObject({ fault: "noSealingKey" });
        }
        const counts = watch.db.counts();
        expect(counts).toMatchObject({ opened: written.length, ended: written.length, connectionsOpen: 0 });
        expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
        expect(commits).toEqual([]);
      } finally {
        // A failed check never leaves a call held for the next test: each is let go and settled first.
        watch.release();
        await Promise.allSettled(started);
      }
    },
  );

  it(
    "six at once, three STOPs and three business-scoped gates: at most 3 hold a client, the connections at once stay at 6 or fewer, every call answers as it would alone, and opened equals ended",
    { timeout: TEST_MS },
    async () => {
      const testEnv = envOf();
      const written: Json[] = [];
      const watch = slotWatch(handleOver(testEnv.env, written));
      const { root, commits } = rootOn(testEnv, watch.db);
      const calls = await Promise.all([
        doorCall("six-1"),
        scopedCall("six-2"),
        doorCall("six-3"),
        scopedCall("six-4"),
        doorCall("six-5"),
        scopedCall("six-6"),
      ]);

      const running = calls.map((call) => gateOn(root, call));
      try {
        await vi.waitFor(() => {
          expect(watch.inUse()).toBe(GATE_CLIENTS_AT_ONCE);
        }, HOLD_WAIT);
        await settle();
        expect(watch.entered).toHaveLength(GATE_CLIENTS_AT_ONCE);
        watch.release();
        const outcomes = await Promise.allSettled(running);

        expect(outcomes.map((outcome) => outcome.status)).toEqual([
          "rejected",
          "fulfilled",
          "rejected",
          "fulfilled",
          "rejected",
          "fulfilled",
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") expect(outcome.value).toEqual(NOT_BUILT);
          else expect(outcome.reason).toMatchObject({ fault: "noSealingKey" });
        }
        expect(watch.peak()).toBe(GATE_CLIENTS_AT_ONCE);
        expect([...watch.entered].sort()).toEqual([
          "runtime",
          "runtime",
          "runtime",
          "toolApi",
          "toolApi",
          "toolApi",
        ]);
        const counts = watch.db.counts();
        expect(counts).toMatchObject({ opened: written.length, ended: written.length, connectionsOpen: 0 });
        expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
        expect(commits).toEqual([]);
      } finally {
        // A failed check never leaves a call held for the next test: each is let go and settled first.
        watch.release();
        await Promise.allSettled(running);
      }
    },
  );
});

// ---- unbound, and production ------------------------------------------------------------------------------------------

describe("unbound staging and production: no door, so the STOP fails closed as before", () => {
  it("unbound (neither binding, or either alone): the input is null and the STOP answers the base's noBusinessScope, with no binding's string read, no client opened and no line written", async () => {
    for (const bindings of [
      { job: false, app: false },
      { job: true, app: false },
      { job: false, app: true },
    ]) {
      const testEnv = envOf(bindings);
      const written: Json[] = [];
      const db = handleOver(testEnv.env, written);
      const inputs = stagingOptions(testEnv.env, {
        db,
        builders: { ...EVERY_OTHER_PART_UNBOUND, gate: stagingGateReads },
      });
      expect(inputs.gateReads, JSON.stringify(bindings)).toBeNull();
      const root = composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });

      const answer = await gateOn(root, await stopGate(nobody("unbound")));

      expect(answer, JSON.stringify(bindings)).toEqual(NO_BUSINESS_SCOPE);
      expect([testEnv.job?.reads.n ?? 0, testEnv.app?.reads.n ?? 0]).toEqual([0, 0]);
      expect(written).toEqual([]);
      expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
      expect(lines).toEqual([]);
    }
  });

  it("production: the Worker's root reads no binding and keeps the gate closed", async () => {
    const testEnv = envOf({ environment: "production" });
    const root = workerRoot(testEnv.env);
    expect(root.environment).toBe("production");

    const thrown = await rejectionOf(gateOn(root, await stopGate(nobody("production"))));

    expect(thrown).toEqual(new NotJoinedError("gate"));
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app?.reads.n]).toEqual([0, 0]);
  });
});

// ---- the capture ------------------------------------------------------------------------------------------------------

/** Whether `text` holds `part` as a whole word (not inside a longer one). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_+])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

describe("the span and log capture", () => {
  it("no line or span written while this file ran holds a number or a STOP's words, and no rejection was left unhandled", async () => {
    // The capture is not empty: every call's timing line is in it.
    expect(everyLine.some((line) => line.includes('"msg":"dbCall"'))).toBe(true);
    const numbers = [FIXTURE.number, NO_WRAP.number].flatMap((number) => [
      number,
      number.slice(1),
      number.slice(2),
    ]);
    for (const text of [...everyLine, ...SPANS.map((span) => JSON.stringify(span))]) {
      for (const number of numbers) expect(text, "a line holds a number").not.toContain(number);
      expect(holds(text, "STOP"), "a line holds the STOP's words").toBe(false);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
