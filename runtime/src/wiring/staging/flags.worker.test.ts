// T-1393: staging's release flags over T-185's readFlag (./flags.ts; the D-017 path audit's P1c; the lead's notes DL-356,
// DL-476 and DL-757), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key FLAGS) and through its
// pool bindings only (vitest.config.ts): this file's pair, HYPERDRIVE_JOB_FLAGS and HYPERDRIVE_APP_FLAGS, the two Worker
// logins on this file's own database (migrated, bundle v0 active, seeded by ./flags.seed.ts), and the pool's own
// HYPERDRIVE_JOB, which names rosie_rig_none, never made. Each test hands the Worker's root (workerRoot) or the binding
// (stagingFlags) an env of its own whose HYPERDRIVE_JOB and HYPERDRIVE_APP are pool bindings, or doubles over a pool
// binding that count the reads of its connection string. The Linq verify is the root's own, on a webhook secret made up
// for the run; every webhook here is unsigned.
//
//   - DL-356's pair through workerRoot(env).linqWebhook: the skeleton flag's global row on, as `flags.sh apply` writes it
//     from infra/flags/staging.json, an unsigned webhook answers 401; the row turned off (db/repo's updateFlag, compare
//     and set, through the test's own job-side handle), 404 with the body unread and nothing verified; on again, 401.
//     Each webhook is one readFlag on the job side, never remembered.
//   - The binding's own reads, each answer from the seeded rows: no row reads off; a phone's row decides for that phone
//     alone; each answer's one key is `enabled`; a row changed is read at the next call.
//   - The job side only: HYPERDRIVE_JOB unbound and HYPERDRIVE_APP bound, 404 and HYPERDRIVE_APP read 0 times.
//     Production's environment with both bindings and the row on: 404, no binding read.
//   - A read that fails (the pool's own HYPERDRIVE_JOB, DB_SCHEMA set, the guard's refusal, a binding with no string, a
//     database error in the read's own statement): 503, never 404 or 401; the route's log line holds its stage and the
//     error's name only; what is thrown holds no number, host, user or password.
//   - No line written while this file runs holds a 555-01xx number, a scope or a flag's setting.
// The test's own clients go through T-1254's handle (its quiet socket), so none leaves a rejection behind (T-1403).
// Test values only (rule 9): fictional 555-01xx numbers, made-up settings and a made-up webhook secret.
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import { getFlag, GLOBAL_SCOPE, listFlags, phoneScope, updateFlag } from "@rosie/db/repo/flags";
import type { Sql } from "@rosie/db/repo/scope";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { spansOfLogLines } from "../../trace/hop-check";
import { SKELETON_FLAG, workerRoot, type Root } from "../index";
import { testWebhookSecret } from "../test-support";
import { DbClosedError, dbHandle } from "./db";
import { READ_FLAG_CALL, stagingFlags } from "./flags";
import {
  FLAG_WITHOUT_ROW,
  GLOBAL_SETTING,
  PHONE_FLAG,
  PHONE_ON,
  PHONE_SETTING,
  PHONE_WITHOUT_ROW,
  STAGING_FLAGS,
} from "./flags.seed";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "FLAGS";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own job binding: its database, rosie_rig_none, is never made, so a connect through it fails. */
const POOL_JOB = "HYPERDRIVE_JOB";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- what this file's isolate wrote and rejected ---------------------------------------------------------------------

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

/** Every line written on console.log and console.error while this file's tests ran, and the running test's own. */
const everyLine: string[] = [];
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => String(arg)).join(" ");
    lines.push(line);
    everyLine.push(line);
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Line = Record<string, unknown>;

const isRecord = (value: unknown): value is Line =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A written line as the JSON it is; a line that is none fails the test. */
function parsed(line: string): Line {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("a log line is not a JSON object");
  return value;
}

// ---- envs and doubles ------------------------------------------------------------------------------------------------

interface TestEnv {
  readonly env: StagingEnv;
  /** Every key read from the env, in order. */
  readonly keys: string[];
}

/** An env of the test's own: staging's vars (unless the fields say otherwise) and the fields, each key read recorded. */
function envOf(fields: Readonly<Record<string, unknown>>): TestEnv {
  const keys: string[] = [];
  const target: Record<string, unknown> = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    ...fields,
  };
  const proxied = new Proxy(target, {
    get(object, key, receiver): unknown {
      if (typeof key === "string") keys.push(key);
      return Reflect.get(object, key, receiver);
    },
  });
  return { env: proxied as unknown as StagingEnv, keys };
}

const count = (keys: readonly string[], name: string): number => keys.filter((key) => key === name).length;

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

/** The test's own job-side handle on this file's pair (T-1254's, each client on its quiet socket). */
const own = dbHandle(
  {
    ENVIRONMENT: "staging",
    DB_SCHEMA: "",
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
  },
  { log: () => undefined },
);

/** Turns one flag row on or off through the test's own job binding: db/repo's updateFlag, compare and set. */
async function turn(name: string, scope: string, enabled: boolean): Promise<void> {
  await own.runtime("updateFlag", async (sql: Sql) => {
    const row = await getFlag(sql, name, scope);
    if (row === null) throw new Error(`the seed wrote no ${name} row at that scope`);
    if (row.enabled === enabled) return;
    const result = await updateFlag(sql, name, scope, row.version, { enabled });
    if (!result.ok) throw new Error(`${name}: its row changed under the test`);
  });
}

// ---- the route -------------------------------------------------------------------------------------------------------

interface Sent {
  readonly status: number;
  readonly body: unknown;
  /** Whether the route read the webhook's body. */
  readonly bodyUsed: boolean;
  /** The lines written while the route answered. */
  readonly lines: Line[];
}

/** One unsigned Linq webhook through the root's route. */
async function post(root: Root): Promise<Sent> {
  const before = lines.length;
  const request = new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const response = await root.linqWebhook(request);
  const body: unknown = await response.json();
  return {
    status: response.status,
    body,
    bodyUsed: request.bodyUsed,
    lines: lines.slice(before).map(parsed),
  };
}

const traceIdOf = (sent: Sent): unknown => (isRecord(sent.body) ? sent.body.trace_id : undefined);

/** The timing line the root's handle writes for one flag read: the job side, as rosie_worker_job, on no trace. */
const READ_LINE = {
  level: "info",
  msg: "dbCall",
  trace_id: null,
  call: READ_FLAG_CALL,
  side: "runtime",
  binding: "HYPERDRIVE_JOB",
  login: "rosie_worker_job",
  connect: { at: expect.any(String) as string, ms: expect.any(Number) as number },
  guard: { at: expect.any(String) as string, ms: expect.any(Number) as number },
  environment: "staging",
  version: "test-sha",
};

const flagReads = (written: readonly Line[]): Line[] =>
  written.filter((line) => line.msg === "dbCall" && line.call === READ_FLAG_CALL);

/** The route's 404 line: the Worker's own not_found, naming the flag. */
const notFoundLine = (traceId: unknown): Line => ({
  level: "info",
  msg: "not_found",
  trace_id: traceId,
  flag: SKELETON_FLAG,
  environment: "staging",
  version: "test-sha",
});

// ---- what an error gives away (as T-1254's test searches it) ---------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to fail");
}

/** The texts an error gives away: its message, its stack but for the frames, its own fields as JSON, and as a string. */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  // Every own field, the ones JSON.stringify leaves out included (message, and the stack without its frames).
  const fields = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key): [string, unknown] => [key, Reflect.get(error, key)]),
  );
  return [error.message, stack, JSON.stringify(error), JSON.stringify({ ...fields, stack }), String(error)];
}

/** Whether `text` holds `part` as a whole name (not inside a longer name). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/** Every text holds none of the binding's string, host, user, password or database. */
function expectNothingOf(binding: { readonly connectionString: string }, texts: readonly string[]): void {
  const url = new URL(binding.connectionString);
  const parts = [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of texts) {
    for (const part of parts) {
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
    }
  }
}

/** What no line and no error may hold: the test's numbers in any form, a scope, a setting, or readFlag's deciding row. */
const NEVER_WRITTEN = [
  PHONE_ON,
  PHONE_ON.slice(1),
  PHONE_WITHOUT_ROW,
  PHONE_WITHOUT_ROW.slice(1),
  "5555550",
  "555-01",
  "phone:",
  GLOBAL_SCOPE,
  GLOBAL_SETTING,
  PHONE_SETTING,
  "decidedBy",
];

function expectNothingWritten(texts: readonly string[]): void {
  for (const text of texts) {
    for (const value of NEVER_WRITTEN) expect(text, value).not.toContain(value);
  }
}

// ---- this file's database --------------------------------------------------------------------------------------------

describe("this file's database: the staging flag set's rows, as flags.sh apply writes them, and the test's own", () => {
  it("the rig made this file's database and its seed wrote the rows, readable on the job side", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_flags$/u);
    // The staging flag set turns the skeleton flag on (infra/flags/staging.json).
    expect(STAGING_FLAGS[SKELETON_FLAG]).toBe(true);
    const rows = await own.runtime("listFlags", (sql) => listFlags(sql));
    const expected = [
      ...Object.entries(STAGING_FLAGS).map(([name, enabled]) => ({ name, scope: GLOBAL_SCOPE, enabled })),
      { name: PHONE_FLAG, scope: GLOBAL_SCOPE, enabled: false },
      { name: PHONE_FLAG, scope: phoneScope(PHONE_ON), enabled: true },
    ].sort((a, b) => (a.name === b.name ? a.scope.localeCompare(b.scope) : a.name.localeCompare(b.name)));
    expect(rows.map(({ name, scope, enabled }) => ({ name, scope, enabled }))).toEqual(expected);
  });
});

// ---- DL-356's pair ---------------------------------------------------------------------------------------------------

describe("DL-356's pair through the Worker's root: the skeleton flag decides the Linq route", () => {
  it("the global row on: an unsigned webhook answers 401; turned off: 404, the body unread and nothing verified; on again: 401, each webhook one read on the job side", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const { env, keys } = envOf({
      HYPERDRIVE_JOB: job.binding,
      HYPERDRIVE_APP: app.binding,
      LINQ_WEBHOOK_SECRET: testWebhookSecret(),
    });
    await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);
    const root = workerRoot(env);
    // Building the root reads no connection string.
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);

    try {
      // On: the gateway's Linq entry takes the request, reads its body and turns the unsigned webhook away.
      const on = await post(root);
      expect(on.status).toBe(401);
      expect(on.body).toEqual({
        ok: false,
        error: "unauthorized",
        trace_id: expect.stringMatching(UUID) as string,
      });
      expect(on.bodyUsed).toBe(true);
      expect(flagReads(on.lines)).toEqual([READ_LINE]);
      expect(spansOfLogLines(on.lines)).toEqual([
        expect.objectContaining({
          trace_id: traceIdOf(on),
          hop: "receive",
          outcome: "refused",
          decided: { signatureValid: false, answered: 401 },
        }),
      ]);
      const verifiedBeforeOff = count(keys, "LINQ_WEBHOOK_SECRET");

      // Off (D-017's rollback, `flags.sh off skeleton`): the next webhook is a 404, with nothing read, verified or reached.
      await turn(SKELETON_FLAG, GLOBAL_SCOPE, false);
      const off = await post(root);
      expect(off.status).toBe(404);
      expect(off.body).toEqual({
        ok: false,
        error: "not_found",
        trace_id: expect.stringMatching(UUID) as string,
      });
      expect(off.bodyUsed).toBe(false);
      expect(count(keys, "LINQ_WEBHOOK_SECRET")).toBe(verifiedBeforeOff);
      expect(off.lines).toEqual([READ_LINE, notFoundLine(traceIdOf(off))]);

      // On again: nothing was remembered.
      await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);
      const again = await post(root);
      expect(again.status).toBe(401);
      expect(again.bodyUsed).toBe(true);
      expect(flagReads(again.lines)).toEqual([READ_LINE]);
    } finally {
      await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);
    }
    // The job side only: the Tool API's binding was never read.
    expect(job.reads.n).toBeGreaterThanOrEqual(3);
    expect(app.reads.n).toBe(0);
  });
});

// ---- the binding's own reads -----------------------------------------------------------------------------------------

/** The binding over an env of the test's own, on a handle whose timing lines are kept. */
function bindingOver(fields: Readonly<Record<string, unknown>>): {
  flags: ReturnType<typeof stagingFlags>;
  db: StagingDb;
  written: Line[];
  keys: string[];
} {
  const { env, keys } = envOf(fields);
  const written: Line[] = [];
  const db = stagingDb(env, {
    write: (line) => {
      everyLine.push(line);
      written.push(parsed(line));
    },
  });
  return { flags: stagingFlags({ env, db }), db, written, keys };
}

describe("the binding's own reads, each answer from the seeded rows", () => {
  it("a name with no row reads off; a phone's row decides for that phone alone; each answer's one key is enabled; each read is one job-side client", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const { flags, db, written, keys } = bindingOver({
      HYPERDRIVE_JOB: job.binding,
      HYPERDRIVE_APP: app.binding,
    });
    expect(flags).not.toBeNull();
    if (flags === null) return;
    // Built: the environment, then the job binding's presence, once each; no connection string, and nothing of the
    // Tool API's side.
    expect(keys).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB"]);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);

    const answers = [
      await flags.readFlag(FLAG_WITHOUT_ROW),
      await flags.readFlag(FLAG_WITHOUT_ROW, { phone: PHONE_ON }),
      // The test's own flag: off at the global scope, on for one phone.
      await flags.readFlag(PHONE_FLAG),
      await flags.readFlag(PHONE_FLAG, {}),
      await flags.readFlag(PHONE_FLAG, { phone: PHONE_ON }),
      await flags.readFlag(PHONE_FLAG, { phone: PHONE_WITHOUT_ROW }),
      // The skeleton flag: on at the global scope, so on for any phone too.
      await flags.readFlag(SKELETON_FLAG),
      await flags.readFlag(SKELETON_FLAG, { phone: PHONE_ON }),
    ];

    expect(answers).toEqual([
      { enabled: false },
      { enabled: false },
      { enabled: false },
      { enabled: false },
      { enabled: true },
      { enabled: false },
      { enabled: true },
      { enabled: true },
    ]);
    for (const answer of answers) expect(Object.keys(answer)).toEqual(["enabled"]);
    // Each call reached PostgreSQL on a client of its own, as rosie_worker_job, ended after it.
    expect(written).toEqual(answers.map(() => READ_LINE));
    expect(db.counts()).toMatchObject({ opened: answers.length, ended: answers.length, connectionsOpen: 0 });
    expect([job.reads.n, app.reads.n]).toEqual([answers.length, 0]);
    expect(keys).not.toContain("HYPERDRIVE_APP");
    expectNothingWritten(written.map((line) => JSON.stringify(line)));
  });

  it("a row changed is read at the next call: nothing is remembered", async () => {
    const { flags } = bindingOver({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    if (flags === null) throw new Error("the binding is null on this file's pair");
    const scope = phoneScope(PHONE_ON);
    await turn(PHONE_FLAG, scope, true);
    try {
      expect(await flags.readFlag(PHONE_FLAG, { phone: PHONE_ON })).toEqual({ enabled: true });
      // A phone row that is off decides for that phone, as T-185's read rules.
      await turn(PHONE_FLAG, scope, false);
      expect(await flags.readFlag(PHONE_FLAG, { phone: PHONE_ON })).toEqual({ enabled: false });
      await turn(PHONE_FLAG, scope, true);
      expect(await flags.readFlag(PHONE_FLAG, { phone: PHONE_ON })).toEqual({ enabled: true });
    } finally {
      await turn(PHONE_FLAG, scope, true);
    }
  });
});

// ---- unbound ---------------------------------------------------------------------------------------------------------

describe("unbound: the flag reads off, and the route answers 404 with nothing read or reached", () => {
  it("the job side only: HYPERDRIVE_JOB unbound and HYPERDRIVE_APP bound, with the row on: no flags, 404, HYPERDRIVE_APP read 0 times", async () => {
    await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);
    for (const unbound of [{}, { HYPERDRIVE_JOB: undefined }, { HYPERDRIVE_JOB: null }]) {
      const app = counted(poolBinding(APP));
      const fields = { ...unbound, HYPERDRIVE_APP: app.binding, LINQ_WEBHOOK_SECRET: testWebhookSecret() };
      expect(bindingOver(fields).flags).toBeNull();
      const { env, keys } = envOf(fields);

      const sent = await post(workerRoot(env));

      expect(sent.status).toBe(404);
      expect(sent.body).toEqual({
        ok: false,
        error: "not_found",
        trace_id: expect.stringMatching(UUID) as string,
      });
      expect(sent.bodyUsed).toBe(false);
      expect(sent.lines).toEqual([notFoundLine(traceIdOf(sent))]);
      expect(count(keys, "LINQ_WEBHOOK_SECRET")).toBe(0);
      expect(app.reads.n).toBe(0);
    }
  });

  it("production's environment with both bindings and the row on: no flags, 404, and no binding read", async () => {
    await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const fields = {
      ENVIRONMENT: "production",
      BASE_PATH: "",
      HYPERDRIVE_JOB: job.binding,
      HYPERDRIVE_APP: app.binding,
      LINQ_WEBHOOK_SECRET: testWebhookSecret(),
    };
    const direct = bindingOver(fields);
    expect(direct.flags).toBeNull();
    expect(direct.keys.filter((key) => key.startsWith("HYPERDRIVE"))).toEqual([]);
    const { env, keys } = envOf(fields);

    const sent = await post(workerRoot(env));

    expect(sent.status).toBe(404);
    expect(sent.bodyUsed).toBe(false);
    expect(sent.lines).toEqual([
      {
        level: "info",
        msg: "not_found",
        trace_id: traceIdOf(sent),
        flag: SKELETON_FLAG,
        environment: "production",
        version: "test-sha",
      },
    ]);
    expect(keys.filter((key) => key.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    expect(count(keys, "LINQ_WEBHOOK_SECRET")).toBe(0);
  });
});

// ---- a read that fails -----------------------------------------------------------------------------------------------

interface FailingCase {
  readonly name: string;
  /** The env's fields, made for the case. */
  readonly fields: () => Record<string, unknown>;
  /** The name of what the read throws: the one thing of it the route logs. */
  readonly error: string;
  /** The other lines written, by msg: the handle's own refusal line, where its guard refused. */
  readonly others: readonly string[];
}

const FAILING: readonly FailingCase[] = [
  {
    name: "the env's HYPERDRIVE_JOB the pool's own, on rosie_rig_none (the connect fails)",
    fields: () => ({ HYPERDRIVE_JOB: poolBinding(POOL_JOB), HYPERDRIVE_APP: poolBinding(APP) }),
    error: "DataAccessDatabaseError",
    others: [],
  },
  {
    name: "DB_SCHEMA set (no client is opened)",
    fields: () => ({
      DB_SCHEMA: "preview_t1393",
      HYPERDRIVE_JOB: poolBinding(JOB),
      HYPERDRIVE_APP: poolBinding(APP),
    }),
    error: "DbClosedError",
    others: [],
  },
  {
    name: "the handle's refusal (HYPERDRIVE_JOB stores the Tool API's login)",
    fields: () => ({ HYPERDRIVE_JOB: poolBinding(APP), HYPERDRIVE_APP: poolBinding(APP) }),
    error: "DbGuardRefusal",
    others: ["dbGuardRefused"],
  },
  {
    name: "a HYPERDRIVE_JOB binding that gives no connection string",
    fields: () => ({ HYPERDRIVE_JOB: {}, HYPERDRIVE_APP: poolBinding(APP) }),
    error: "DbClosedError",
    others: [],
  },
];

describe("a read that fails: the route answers 503, never 404 or 401, and nothing of the failure leaves but its name", () => {
  it.each(FAILING)(
    "$name: 503, the body unread, nothing verified; the log line holds stage skeletonFlag and the error's name only",
    async ({ fields, error, others }) => {
      // The row is on in this file's database: a read that failed open would answer 401, one that read off 404.
      await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);
      const { env, keys } = envOf({ ...fields(), LINQ_WEBHOOK_SECRET: testWebhookSecret() });

      const sent = await post(workerRoot(env));

      expect(sent.status).toBe(503);
      expect(sent.body).toEqual({
        ok: false,
        error: "unavailable",
        trace_id: expect.stringMatching(UUID) as string,
      });
      expect(sent.bodyUsed).toBe(false);
      expect(count(keys, "LINQ_WEBHOOK_SECRET")).toBe(0);
      const failed = sent.lines.filter((line) => line.msg === "gateway_failed");
      expect(failed).toEqual([
        { level: "error", msg: "gateway_failed", trace_id: traceIdOf(sent), stage: "skeletonFlag", error },
      ]);
      expect(Object.keys(failed[0] ?? {}).sort()).toEqual(["error", "level", "msg", "stage", "trace_id"]);
      expect(sent.lines.filter((line) => line.msg !== "gateway_failed").map((line) => line.msg)).toEqual(
        others,
      );
      expectNothingWritten(sent.lines.map((line) => JSON.stringify(line)));
    },
  );

  it("what the binding throws on the pool's own HYPERDRIVE_JOB, asked for a phone: the call's name and SQLSTATE only, no number, host, user or password", async () => {
    const { flags, db, written } = bindingOver({
      HYPERDRIVE_JOB: poolBinding(POOL_JOB),
      HYPERDRIVE_APP: poolBinding(APP),
    });
    if (flags === null) throw new Error("the binding is null with HYPERDRIVE_JOB bound");

    const thrown = await rejectionOf(flags.readFlag(SKELETON_FLAG, { phone: PHONE_ON }));

    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: READ_FLAG_CALL, code: "3D000", table: null, constraint: null });
    expect((thrown as Error).message).toBe("readFlag: the database refused the call (SQLSTATE 3D000)");
    expect(Object.keys(thrown as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
    expectNothingOf(poolBinding(POOL_JOB), textsOf(thrown));
    expectNothingWritten(textsOf(thrown));
    // The guard never passed: no timing line, and the one client it opened was ended.
    expect(written).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  });

  it("a database error in the read's own statement, whose bound values hold the phone: it leaves scrubbed, the call's name and SQLSTATE only", async () => {
    const { flags, db } = bindingOver({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    if (flags === null) throw new Error("the binding is null on this file's pair");
    // PostgreSQL refuses a text value that holds a zero byte: the statement fails with the phone among its values.
    const phone = `${PHONE_ON}\u0000`;

    const thrown = await rejectionOf(flags.readFlag(SKELETON_FLAG, { phone }));

    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: READ_FLAG_CALL, code: "22021", table: null, constraint: null });
    expect((thrown as Error).message).toBe("readFlag: the database refused the call (SQLSTATE 22021)");
    expect(Object.keys(thrown as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
    expectNothingOf(poolBinding(JOB), textsOf(thrown));
    expectNothingWritten(textsOf(thrown));
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
    // The next read answers: the failure was that call's alone.
    expect(await flags.readFlag(SKELETON_FLAG, { phone: PHONE_ON })).toEqual({ enabled: true });
  });

  it("an error the handle passes through as it came leaves scrubbed, and the handle's own refusal leaves as it is", async () => {
    // A stand-in for the handle only (the binding is the code under test): it rejects as the handle would pass on an
    // error of postgres.js, which carries the statement, its values and the address.
    const clientError = Object.assign(
      new Error(`write CONNECTION_CLOSED db.t1393.invalid:5432 for ${PHONE_ON}`),
      {
        code: "CONNECTION_CLOSED",
        errno: "CONNECTION_CLOSED",
        address: "db.t1393.invalid",
        port: 5432,
        query: "select * from release_flags where name = $1",
        parameters: [SKELETON_FLAG, PHONE_ON],
        args: [SKELETON_FLAG, PHONE_ON],
      },
    );
    const refusal = new DbClosedError(READ_FLAG_CALL, "runtime", "dbSchemaSet");
    const failures: Error[] = [clientError, refusal];
    const calls: string[] = [];
    const db: StagingDb = {
      runtime: (call) => {
        calls.push(call);
        return Promise.reject(failures.shift() ?? new Error("the stand-in has no failure left"));
      },
      toolApi: () => Promise.reject(new Error("the flags never read on the Tool API's side")),
      counts: () => ({
        opened: 0,
        ended: 0,
        connectionsOpen: 0,
        connectionsPeak: 0,
        quietReads: 0,
        quietWrites: 0,
      }),
    };
    const flags = stagingFlags({ env: envOf({ HYPERDRIVE_JOB: {} }).env, db });
    if (flags === null) throw new Error("the binding is null with HYPERDRIVE_JOB bound");

    const scrubbedError = await rejectionOf(flags.readFlag(SKELETON_FLAG, { phone: PHONE_ON }));
    const passed = await rejectionOf(flags.readFlag(SKELETON_FLAG, { phone: PHONE_ON }));

    expect(calls).toEqual([READ_FLAG_CALL, READ_FLAG_CALL]);
    expect(scrubbedError).not.toBe(clientError);
    expect(scrubbedError).toBeInstanceOf(Error);
    expect((scrubbedError as Error).message).toBe(
      "readFlag: the database call failed (code CONNECTION_CLOSED)",
    );
    expect(Object.keys(scrubbedError as Error).sort()).toEqual(["call", "code"]);
    expect(scrubbedError).toMatchObject({ call: READ_FLAG_CALL, code: "CONNECTION_CLOSED" });
    expect((scrubbedError as Error).cause).toBeUndefined();
    for (const text of textsOf(scrubbedError)) {
      expect(text).not.toContain("t1393.invalid");
      expect(text).not.toContain("release_flags");
    }
    expectNothingWritten(textsOf(scrubbedError));
    expect(passed).toBe(refusal);
  });
});

// ---- the capture -----------------------------------------------------------------------------------------------------

describe("the span and log capture", () => {
  it("no line written while this file ran holds a 555-01xx number, a scope or a flag's setting, and no rejection was left unhandled", async () => {
    // Its own round, so the capture is never empty: a webhook on the route with the flag on, one with no flags bound,
    // then reads for a phone, one of them failing, and a webhook whose read fails.
    await turn(SKELETON_FLAG, GLOBAL_SCOPE, true);
    const { env } = envOf({
      HYPERDRIVE_JOB: poolBinding(JOB),
      HYPERDRIVE_APP: poolBinding(APP),
      LINQ_WEBHOOK_SECRET: testWebhookSecret(),
    });
    expect((await post(workerRoot(env))).status).toBe(401);
    const unbound = envOf({ LINQ_WEBHOOK_SECRET: testWebhookSecret() });
    expect((await post(workerRoot(unbound.env))).status).toBe(404);
    // The root's own handle writes each call's timing on console.log.
    const flags = stagingFlags({ env, db: stagingDb(env) });
    if (flags === null) throw new Error("the binding is null on this file's pair");
    expect(await flags.readFlag(PHONE_FLAG, { phone: PHONE_ON })).toEqual({ enabled: true });
    await rejectionOf(flags.readFlag(PHONE_FLAG, { phone: `${PHONE_ON}\u0000` }));
    const failing = envOf({
      HYPERDRIVE_JOB: poolBinding(POOL_JOB),
      LINQ_WEBHOOK_SECRET: testWebhookSecret(),
    });
    expect((await post(workerRoot(failing.env))).status).toBe(503);

    const kinds = new Set(everyLine.map((line) => parsed(line).msg));
    expect([...kinds]).toEqual(expect.arrayContaining(["dbCall", "span", "not_found", "gateway_failed"]));
    expectNothingWritten(everyLine);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
