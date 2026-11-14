// What each later part of T-1154 is handed to build its RootOptions inputs on staging (T-1257; the D-017 path audit's
// P1a, ops/reviews/D-017-path-audit/order_d017.txt line 29; critic_collisions B6): the Worker's env, and T-1254's database
// handle (./db.ts) with each call's timing written on the call's trace (DL-760). ./options.ts hands every part these.
//
// The env (StagingEnv): every part reads the binding or secret it needs from it at each call (critic_collisions N4); it may
// check a binding's presence as it is built (T-1401's "all or nothing"), and nothing is read for a part until it binds an
// input. The handle (StagingDb): one guarded client per call, the runtime side's from HYPERDRIVE_JOB and the Tool API's from
// HYPERDRIVE_APP, as T-1254 built it; a part never opens a client of its own.
//
// Why the handle is loaded at its first call (`import("./db")`), never by a static import: db.ts speaks to PostgreSQL over
// cloudflare:sockets, a module only the Workers runtime has, while root.ts's graph is loaded under Node too (the unit tests
// that compose the root: root.test.ts, linq.test.ts, sealing.test.ts and others). So no file a part's builder lives in, and
// no file root.ts or ../index.ts imports, may import a value of ./db.ts: types only. The Worker's bundle still holds db.ts,
// postgres.js and db/repo (wrangler's build inlines a dynamic import: critic_size N3), and the first call of each root's
// handle loads it once.
//
// Each call's timing (DL-760; T-1254's DbCallTiming): once the guard has passed, one JSON line on the Worker's log, as the
// trace writers record a step's time (K-08 v1's {at, ms}: when it started, in UTC, and its whole milliseconds), under the
// trace id the call names: `dbCall`, with the call's name, the side, the binding, the login the guard read, the connect
// and the guard, each apart, and the environment and version (ADR-009). K-08 v1 names no database hop or provider, so it is
// no span: labels and numbers only, never a value read (the login's name is the one, DL-757; a call name or a login that
// is not a label, and a trace id that is not one, are written as null). A call that names no trace is written with
// trace_id null. The guard's refusal keeps its own line (T-1254: on console.error).

import type { Sql } from "@rosie/db/repo/scope";

import { isLabel, isValidTraceId } from "../../trace";
import type { WorkerSecrets } from "../root";
import type {
  DbBindingName,
  DbCallTiming,
  DbEnv,
  DbHandle,
  DbHandleCounts,
  DbHandleOptions,
  DbSide,
  DbStepTime,
} from "./db";

/**
 * The Worker's env as staging's parts read it: wrangler.jsonc's vars and bindings (Cloudflare.Env), the secrets the root
 * reads by name (../root.ts WorkerSecrets) and the handle's two Hyperdrive bindings (./db.ts DbEnv).
 */
export type StagingEnv = Cloudflare.Env & WorkerSecrets & DbEnv;

/**
 * T-1254's handle as the parts call it (./db.ts DbHandle): one guarded client per call, ended after it. A call may name
 * the trace it serves (a K-08 trace id, as a request or a TraceContext carries it), and its timing is written on that
 * trace; a value that is not a trace id is never written.
 */
export interface StagingDb extends DbHandle {
  /** One call on the runtime side: a client from HYPERDRIVE_JOB, as rosie_worker_job, which inherits rosie_job. */
  runtime<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T>;
  /** One call of the Tool API: a client from HYPERDRIVE_APP, as rosie_worker_app, which inherits rosie_app. */
  toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T>;
}

/** What every part's builder is handed (./options.ts): nothing is read to make it. */
export interface StagingPart {
  /** The Worker's env, read by the part where its calls need a binding or a secret. */
  readonly env: StagingEnv;
  /** The root's one handle: every database call of every part runs on it. */
  readonly db: StagingDb;
}

/** One call's timing on its trace (DL-760): labels and numbers only. */
export interface DbCallLine {
  readonly level: "info";
  readonly msg: "dbCall";
  readonly trace_id: string | null;
  readonly call: string | null;
  readonly side: DbSide;
  readonly binding: DbBindingName;
  readonly login: string | null;
  readonly connect: DbStepTime;
  readonly guard: DbStepTime;
  readonly environment: string;
  readonly version: string;
}

export interface StagingDbOptions {
  /** Where each call's line goes: one JSON line on console.log (Workers Logs), as every span goes. */
  readonly write?: (line: string) => void;
  /** Epoch milliseconds, for the connect's and the guard's times. Default: Date.now. */
  readonly now?: () => number;
  /**
   * How the handle is made: T-1254's dbHandle(env, options), loaded at the first call. A test's double stands in, called
   * as T-1254's handle calls `timing`: once the guard has passed, right before the call's own code, with no wait between.
   */
  readonly open?: (env: StagingEnv, options: DbHandleOptions) => DbHandle | Promise<DbHandle>;
}

/** The counts of a handle no call has made yet. */
const NO_CALLS: DbHandleCounts = Object.freeze({
  opened: 0,
  ended: 0,
  connectionsOpen: 0,
  connectionsPeak: 0,
  quietReads: 0,
  quietWrites: 0,
});

/** A step's time as the handle gave it: when it started and its milliseconds, nothing else. */
const stepOf = (step: DbStepTime): DbStepTime => ({ at: step.at, ms: step.ms });

/** The line for one call's timing, on the trace it names (null when it names none, or names no trace id). */
export function dbCallLine(timing: DbCallTiming, traceId: string | null, env: StagingEnv): DbCallLine {
  return {
    level: "info",
    msg: "dbCall",
    trace_id: isValidTraceId(traceId) ? traceId.toLowerCase() : null,
    call: isLabel(timing.call) ? timing.call : null,
    side: timing.side,
    binding: timing.binding,
    login: isLabel(timing.login) ? timing.login : null,
    connect: stepOf(timing.connect),
    guard: stepOf(timing.guard),
    environment: env.ENVIRONMENT,
    version: env.GIT_SHA ?? "unknown",
  };
}

/**
 * The root's handle over `env` (read at each call, never here): T-1254's dbHandle, made at the first call, with each
 * call's timing written on the trace it names. One per root, so its counts are the root's.
 */
export function stagingDb(env: StagingEnv, options: StagingDbOptions = {}): StagingDb {
  const write =
    options.write ??
    ((line: string) => {
      console.log(line);
    });
  // The timing T-1254's handle gave last: it calls `timing` once the guard has passed and then the call's own code at
  // once, with nothing awaited between (./db.ts, the end of `call`), so the code that runs next is that call's, and takes
  // it before any other call can run.
  let given: DbCallTiming | null = null;
  const handleOptions: DbHandleOptions = {
    timing: (timing) => {
      given = timing;
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const open = async (): Promise<DbHandle> =>
    options.open === undefined
      ? (await import("./db")).dbHandle(env, handleOptions)
      : options.open(env, handleOptions);
  let made: DbHandle | null = null;
  let making: Promise<DbHandle> | null = null;
  const handle = (): Promise<DbHandle> => {
    if (made !== null) return Promise.resolve(made);
    if (making === null) {
      const attempt = open();
      making = attempt;
      void attempt.then(
        (opened) => {
          made = opened;
        },
        () => {
          // Not kept: the next call tries again.
          if (making === attempt) making = null;
        },
      );
    }
    return making;
  };

  const run = async <T>(
    side: DbSide,
    call: string,
    fn: (sql: Sql) => Promise<T>,
    traceId: string | null | undefined,
  ): Promise<T> => {
    const db = await handle();
    const onItsTrace = (sql: Sql): Promise<T> => {
      const timing = given;
      given = null;
      if (timing !== null) {
        // The timing is this call's (see above); one that names another call or side is written on no trace.
        const own = timing.call === call && timing.side === side;
        write(JSON.stringify(dbCallLine(timing, own ? (traceId ?? null) : null, env)));
      }
      return fn(sql);
    };
    return side === "runtime" ? db.runtime(call, onItsTrace) : db.toolApi(call, onItsTrace);
  };

  return {
    runtime: (call, fn, traceId) => run("runtime", call, fn, traceId),
    toolApi: (call, fn, traceId) => run("toolApi", call, fn, traceId),
    counts: () => made?.counts() ?? NO_CALLS,
  };
}
