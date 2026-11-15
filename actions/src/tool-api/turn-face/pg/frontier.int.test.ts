// T-1315 (T-1268's new task e; DL-579): the frontier's transaction start fails scrubbed. pg/frontier.ts pgFrontierScope
// opens its read-only transaction on a client whose connection never opens, is lost or is refused at its start, and the
// start goes through T-1268's transientOrThrow under the frontier's K-05 call's name, readTurnState, as the frontier's
// read does: K-05's `transient` answer (nothing was written and the same request may be sent again), or a scrubbed error
// with the call's name and the code alone (ADR-014 section 2: never a connection string, a host, a user or a password).
// `npm run db:up`, then `npm run test:integration -- actions/src/tool-api/turn-face/pg/frontier`.
//
// Each failure is raised by postgres.js as installed (3.4.9) at the transaction's first statement: a port nothing
// listens on (Node's ECONNREFUSED, for real); a socket that fails before it opens with an error built in the shape
// postgres.js or Node gives it (postgres.js's own `socket` option, so postgres.js passes the error up as it does a
// socket's: node_modules/postgres/src/errors.js and connection.js); a local server that refuses each session at its start
// with PostgreSQL's own ErrorResponse (class 28, 53300). Each failure is seen through the scope (a read through its repo)
// and through the turn face's buildFrontier (pgTurnFace, the face join 6 binds, over the Tool API base): the answer is
// K-05's and K-09's transient, the span failed, or the thrown error is scrubbed. Each raw error is checked to hold what it
// names (so the check means something), and each outcome to hold none of the connection: neither the answer, the thrown
// error's message, stack or other own properties, the span nor the frontier's log. One test runs on local PostgreSQL:
// once the transaction has started, an error of `work`'s own is thrown as it is and `work` runs once.
//
// Rule 9: the probe's user, password, database and hosts are made up here (.invalid names and RFC 5737's documentation
// addresses). A check names what leaked, never its value, so a failing run prints no secret.
//
// T-1330 (T-1315's handoff a; DL-630): the transaction's end, once `work` has its repo, on local PostgreSQL in a schema of
// this file's own, migrated and seeded as the turn face's tests do (test-support.ts openTurnFaceDatabase), so the frontier
// reads Sam's real stored state and answers. Each call runs on a client as the runtime client is made (rosie_job, the
// schema first) whose socket is cut just before one statement goes: the end's scope read, the commit, the rollback after
// `work` threw, or `work`'s first read. The statement is never written; the socket is destroyed with an error built in the
// shape postgres.js or Node gives it, which postgres.js passes up as the socket's own and rejects the statement with, or
// with none, so postgres.js rejects it with its own CONNECTION_CLOSED, naming the server's host and port, as when the
// server closes the connection. Each outcome (the thrown error's message, stack and own properties, the span and the log)
// holds none of the connection, and no statement goes on a connection after it is cut.
//
// T-1368 (T-1315's security note b; T-1331's DL-694 task 1; DL-708): the start refused with the database named (3D000,
// 42501 and 55000 from a local server that refuses each session, a planted database name in each message) is thrown
// scrubbed, as class 28 and 53300 are. And a close while the transaction waits between its statements: on local
// PostgreSQL in a schema of this file's own, the call's connection closes while buildFrontier waits on a bundle read (its
// awaits: handler.ts step 1's manifest before the state's read, the flows of steps 4 and 5 after it, facts.ts's needs
// before the facts' read), with the server showing the transaction idle in it: the server ends the session
// (pg_terminate_backend from another connection: FATAL 57P01, then the close), the socket closes with no error, or it is
// reset. Nothing is built on the connection after the close (postgres.js's `debug` hook sees each statement it builds, the
// one written to no socket among them), nothing is thrown uncaught (Vitest fails the run on one, and such a statement
// never settles), and what the call leaves holds none of the connection: K-09's transient when a read follows the close,
// else the end thrown scrubbed, readTurnState's 08006 alone. Through the scope alone, the same for any await of `work`.

import { once } from "node:events";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, resolvePrimaryUrl } from "../../../../../db/repo/client";
import { DataAccessDatabaseError } from "../../../../../db/repo/clocks";
import { SCOPE_SETTING, type Sql } from "../../../../../db/repo/scope";
import type { TransientError } from "../../../../../db/repo/targets";
import type { Span } from "../../../../../runtime/src/trace";
import { RUNTIME_ROLE, type CommitDatabase } from "../../../commit/pg/test-support";
import { frameFacts } from "../../../frontier/assemble/frame";
import { frontierHandlers } from "../../../frontier/assemble/handler";
import { frontierSources } from "../../../frontier/assemble/registry";
import {
  captureLog,
  checks,
  contractFixture,
  fakeBundles,
  k05Problems,
  sampleBundle,
  standIn,
  type LogCapture,
} from "../../../frontier/assemble/test-support";
import type {
  FrontierBundles,
  FrontierRepo,
  ReadTurnStateRequest,
  SourceSlot,
} from "../../../frontier/assemble/types";
import { factHomes } from "../../../frontier/facts/homes";
import { turnStateFactsPort } from "../../../frontier/facts/read";
import { traceFor } from "../../test-support";
import { createToolApi } from "../../tool-api";
import { s101Exchange } from "../test-support";
import type { BuildFrontierCallAnswer } from "../turn-face";
import { pgFrontierRepo, pgFrontierScope, pgTurnFace } from "./frontier";
import { BARBERSHOP, openTurnFaceDatabase, SAM, SAM_HANDLE } from "./test-support";

/** The frontier's one K-05 call: the name every scrubbed error of its transaction carries. */
const CALL = "readTurnState";
const PROBE_USER = "t1315_probe_user";
const PROBE_PASSWORD = "t1315-probe-password";
const PROBE_DATABASE = "t1315_probe_db";
// The shapes' made-up connection: a host under .invalid (RFC 6761), RFC 5737's TEST-NET-3 address and a port.
const HOST = "db-t1315.example.invalid";
const ADDRESS = "203.0.113.15";
const PORT = 65115;
const SASL_MISMATCH = "The server did not return the correct signature";

const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };
const LOST: TransientError = { error: "transient", sqlstate: "08006" };

const { validator, checker } = checks();

// ---- what an outcome must never hold --------------------------------------------------------------------------------

type Secrets = Readonly<Record<string, RegExp>>;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
  const secrets: Record<string, RegExp> = {};
  for (const [name, value] of Object.entries(values)) {
    secrets[name] =
      typeof value === "number"
        ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
        : new RegExp(escaped(value));
  }
  return secrets;
}

/** The probe's connection on a host and a port: the host, the port, the user, the password and the database. */
function probeSecrets(host: string, port: number): Secrets {
  return secretsOf({ host, port, user: PROBE_USER, password: PROBE_PASSWORD, database: PROBE_DATABASE });
}

/** The made-up connection the shapes name, the address among it. */
const SHAPE_SECRETS: Secrets = { ...probeSecrets(HOST, PORT), ...secretsOf({ address: ADDRESS }) };

/** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
function textsOf(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return [String(value)];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const texts: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    texts.push(key, ...textsOf((value as Record<string, unknown>)[key], seen));
  }
  return texts;
}

/** The names of the secrets `value` holds anywhere, never their values. */
function leaksOf(value: unknown, secrets: Secrets): string[] {
  const texts = textsOf(value);
  return Object.entries(secrets)
    .filter(([, secret]) => texts.some((text) => secret.test(text)))
    .map(([name]) => name);
}

// ---- raising the failures ---------------------------------------------------------------------------------------------

function probeUrl(host: string, port: number): string {
  return `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;
}

/** What `promise` rejects with (it must reject). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the promise was fulfilled");
}

/** A local port nothing listens on: one the system just handed out and took back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

/** PostgreSQL's ErrorResponse message ('E', its length, then each field's type byte and text, then a zero). */
function errorResponse(fields: Readonly<Record<string, string>>): Uint8Array {
  const texts = Object.entries(fields).map(([type, text]) => `${type}${text}\u0000`);
  const body = new TextEncoder().encode(`${texts.join("")}\u0000`);
  const message = new Uint8Array(body.length + 5);
  const view = new DataView(message.buffer);
  view.setUint8(0, "E".charCodeAt(0));
  view.setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
}

/**
 * A local server that refuses each session at its start, as PostgreSQL does: it reads the startup message and answers
 * with a FATAL ErrorResponse of `code` and `message`, then closes.
 */
async function refusingServer(
  code: string,
  message: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.end(errorResponse({ S: "FATAL", V: "FATAL", C: code, M: message }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

/**
 * A postgres.js client on the made-up connection whose socket fails with `raw` before it opens, as Node's socket or TLS
 * would fail it: postgres.js passes `raw` up as it does a socket's error, on the statement it rejects.
 */
function failingSocketClient(raw: Error): Sql {
  const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
  return postgres(probeUrl(HOST, PORT), options);
}

// The errors in the shapes postgres.js and Node give them.

/** postgres.js's own connection error (errors.js connection, on its socket): "write <code> <host>:<port>". */
function connectionError(code: string): Error {
  const error = new Error(`write ${code} ${HOST}:${String(PORT)}`);
  return Object.assign(error, { code, errno: code, address: HOST, port: PORT });
}

/** The same from its pool, with no socket: the hosts and ports as its options' lists hold them. */
function poolError(code: string): Error {
  const error = new Error(`write ${code} ${HOST}:${String(PORT)}`);
  return Object.assign(error, { code, errno: code, address: [HOST], port: [PORT] });
}

/** Node's error for a connect its socket could not make: syscall connect, the address and the port. */
function connectError(code: string, errno: number): Error {
  const error = new Error(`connect ${code} ${ADDRESS}:${String(PORT)}`);
  return Object.assign(error, { errno, code, syscall: "connect", address: ADDRESS, port: PORT });
}

/** Node's error for a name its lookup could not resolve: syscall getaddrinfo and the host name. */
function lookupError(code: string, errno: number): Error {
  const error = new Error(`getaddrinfo ${code} ${HOST}`);
  return Object.assign(error, { errno, code, syscall: "getaddrinfo", hostname: HOST });
}

/** postgres.js's generic error (errors.js generic): "<code>: <text>". */
function genericError(code: string, text: string): Error {
  return Object.assign(new Error(`${code}: ${text}`), { code });
}

/** Node's TLS name check: the host and the certificate on the error. */
function tlsNameError(): Error {
  const reason = `Host: ${HOST}. is not in the cert's altnames: DNS:other.example.invalid`;
  const error = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`);
  const cert = { subject: { CN: "other.example.invalid" }, subjectaltname: "DNS:other.example.invalid" };
  return Object.assign(error, { code: "ERR_TLS_CERT_ALTNAME_INVALID", reason, host: HOST, cert });
}

// ---- the frontier's two ways in -----------------------------------------------------------------------------------------

/** The frontier's own readTurnState request for Sam under `businessId`: the business's name and zone, Sam's name. */
function frontierRead(businessId: string): ReadTurnStateRequest {
  return { handleId: SAM_HANDLE, businessId, bookingIds: [], facts: frameFacts(businessId, [SAM]) };
}

/** How a call ended: what it answered, or what it threw. */
type Settled = { answer: unknown } | { thrown: unknown };

const settle = (promise: Promise<unknown>): Promise<Settled> =>
  promise.then(
    (answer) => ({ answer }),
    (thrown: unknown) => ({ thrown }),
  );

/** One call through the scope: both reads of its repo, and how many times `work` ran. */
async function throughScope(runtime: Sql): Promise<{ settled: Settled; works: number }> {
  let works = 0;
  const settled = await settle(
    pgFrontierScope(runtime).withBusiness(BARBERSHOP, async (repo) => {
      works += 1;
      const turnState = await repo.readTurnState(frontierRead(BARBERSHOP));
      const visits = await repo.readVisitTimes({ bookingIds: ["booking-alex-haircut"] });
      return { turnState, visits };
    }),
  );
  return { settled, works };
}

/** Turn 1's buildFrontier through the turn face on `runtime` (pgTurnFace), bundle v0 injected. */
async function throughFace(runtime: Sql): Promise<{ settled: Settled; spans: Span[]; log: LogCapture }> {
  const log = captureLog();
  const face = pgTurnFace(runtime, {
    bundles: fakeBundles(sampleBundle("bundle-v0-skeleton.json")),
    validator,
    checker,
    log: log.sink,
  });
  const { request } = s101Exchange();
  const { trace, spans } = traceFor(request);
  const settled = await settle(face.buildFrontier(structuredClone(request), trace));
  return { settled, spans, log };
}

// ---- what each outcome must be --------------------------------------------------------------------------------------------

/** What a failure at the transaction's start must leave: K-05's transient, or a scrubbed error of `code`. */
type Expected =
  { answer: TransientError } | { thrown: "client"; code: string } | { thrown: "database"; code: string };

/** The thrown error is scrubbed: the frontier's call's name and the code alone. */
function expectScrubbed(thrown: unknown, expected: Exclude<Expected, { answer: TransientError }>): void {
  if (expected.thrown === "database") {
    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: CALL, code: expected.code, table: null, constraint: null });
    expect((thrown as Error).message).toBe(
      `${CALL}: the database refused the call (SQLSTATE ${expected.code})`,
    );
    return;
  }
  // clocks.ts's scrubbed client error: no message, stack, statement, cause or other property of the original's.
  expect(thrown).toBeInstanceOf(Error);
  expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
  expect(thrown).toMatchObject({
    call: CALL,
    code: expected.code,
    message: `${CALL}: the database call failed (code ${expected.code})`,
  });
}

/** Through the scope: each read answers the transient and `work` ran once, or the scrubbed error and `work` never ran. */
function expectScopeOutcome(
  outcome: { settled: Settled; works: number },
  expected: Expected,
  secrets: Secrets,
): void {
  expect(leaksOf(outcome.settled, secrets)).toEqual([]);
  if ("answer" in expected) {
    expect(outcome.settled).toEqual({ answer: { turnState: expected.answer, visits: expected.answer } });
    expect(k05Problems("readTurnState.errors", expected.answer)).toEqual([]);
    expect(outcome.works).toBe(1);
    return;
  }
  expect(outcome.works).toBe(0);
  expect("thrown" in outcome.settled).toBe(true);
  expectScrubbed((outcome.settled as { thrown: unknown }).thrown, expected);
}

/**
 * Through the turn face: buildFrontier's own transient (K-09's errors), or the scrubbed error thrown on; one frontier span,
 * failed, under the call's business; nothing logged. None of them holds a secret.
 */
function expectFaceOutcome(
  outcome: { settled: Settled; spans: Span[]; log: LogCapture },
  expected: Expected,
  secrets: Secrets,
): void {
  for (const seen of [outcome.settled, outcome.spans, outcome.log.lines]) {
    expect(leaksOf(seen, secrets)).toEqual([]);
  }
  expect(outcome.log.lines).toEqual([]);
  expect(outcome.spans).toHaveLength(1);
  if ("answer" in expected) {
    expect(outcome.settled).toEqual({ answer: expected.answer });
    const answer = (outcome.settled as { answer: BuildFrontierCallAnswer }).answer;
    expect(validator.check("buildFrontier", "errors", answer)).toEqual([]);
    expect(outcome.spans[0]).toMatchObject({
      hop: "frontier",
      outcome: "failed",
      error_code: "transient",
      business_id: BARBERSHOP,
    });
    return;
  }
  expect("thrown" in outcome.settled).toBe(true);
  expectScrubbed((outcome.settled as { thrown: unknown }).thrown, expected);
  expect(outcome.spans[0]).toMatchObject({
    hop: "frontier",
    outcome: "failed",
    error_code: expected.thrown === "database" ? "DataAccessDatabaseError" : "Error",
    business_id: BARBERSHOP,
  });
}

// ---- the tests ------------------------------------------------------------------------------------------------------------

describe("the frontier's transaction start on a connection that never opens (T-1315)", () => {
  it("a closed port: Node's ECONNREFUSED at the start answers transient 08001, through the scope and buildFrontier", async () => {
    const port = await closedPort();
    const secrets = probeSecrets("127.0.0.1", port);
    const client = createClient({ primaryUrl: probeUrl("127.0.0.1", port), max: 1, env: {} });
    try {
      // What postgres.js rejects the transaction's first statement with on this client: its address and port on it.
      const raw = await rejectionOf(client.primary`select 1`);
      expect(raw).toMatchObject({ code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port });
      expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["host", "port"]));

      expectScopeOutcome(await throughScope(client.primary), { answer: NEVER_OPENED }, secrets);
      expectFaceOutcome(await throughFace(client.primary), { answer: NEVER_OPENED }, secrets);
    } finally {
      await client.close();
    }
  });

  const shapes: { name: string; make: () => Error; holds: readonly string[]; expected: Expected }[] = [
    {
      name: "postgres.js's CONNECTION_CLOSED, its host and port on it, answers transient 08006",
      make: () => connectionError("CONNECTION_CLOSED"),
      holds: ["host", "port"],
      expected: { answer: LOST },
    },
    {
      name: "postgres.js's CONNECTION_DESTROYED from its pool answers transient 08006",
      make: () => poolError("CONNECTION_DESTROYED"),
      holds: ["host", "port"],
      expected: { answer: LOST },
    },
    {
      name: "postgres.js's CONNECT_TIMEOUT answers transient 08001",
      make: () => connectionError("CONNECT_TIMEOUT"),
      holds: ["host", "port"],
      expected: { answer: NEVER_OPENED },
    },
    {
      name: "Node's ENOTFOUND, the host on it, answers transient 08001",
      make: () => lookupError("ENOTFOUND", -3008),
      holds: ["host"],
      expected: { answer: NEVER_OPENED },
    },
    {
      name: "Node's ECONNREFUSED, the address and port on it, answers transient 08001",
      make: () => connectError("ECONNREFUSED", -61),
      holds: ["address", "port"],
      expected: { answer: NEVER_OPENED },
    },
    {
      name: "Node's EACCES (a connect the system did not permit) is thrown scrubbed",
      make: () => connectError("EACCES", -13),
      holds: ["address", "port"],
      expected: { thrown: "client", code: "EACCES" },
    },
    {
      name: "Node's TLS name check, its host and certificate on it, is thrown scrubbed",
      make: tlsNameError,
      holds: ["host"],
      expected: { thrown: "client", code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    },
    {
      name: "postgres.js's SASL_SIGNATURE_MISMATCH (a refused session's authentication) is thrown scrubbed",
      make: () => genericError("SASL_SIGNATURE_MISMATCH", SASL_MISMATCH),
      holds: [],
      expected: { thrown: "client", code: "SASL_SIGNATURE_MISMATCH" },
    },
  ];

  it.each(shapes)("$name, through the scope and buildFrontier", async ({ make, holds, expected }) => {
    const raw = make();
    expect(leaksOf(raw, SHAPE_SECRETS)).toEqual(expect.arrayContaining([...holds]));
    const scoped = failingSocketClient(raw);
    try {
      expectScopeOutcome(await throughScope(scoped), expected, SHAPE_SECRETS);
      // postgres.js rejected the transaction's first statement with the socket's own error, the statement put on it.
      expect(Object.hasOwn(raw, "query")).toBe(true);
    } finally {
      await scoped.end({ timeout: 0 });
    }
    const faced = failingSocketClient(make());
    try {
      expectFaceOutcome(await throughFace(faced), expected, SHAPE_SECRETS);
    } finally {
      await faced.end({ timeout: 0 });
    }
  });

  const refusals: { code: string; text: string; holds: readonly string[] }[] = [
    {
      code: "28P01",
      text: `password authentication failed for user "${PROBE_USER}"`,
      holds: ["user"],
    },
    {
      code: "28000",
      text: `no pg_hba.conf entry for host "${ADDRESS}", user "${PROBE_USER}", database "${PROBE_DATABASE}"`,
      holds: ["user", "database"],
    },
    { code: "53300", text: `too many connections for role "${PROBE_USER}"`, holds: ["user"] },
  ];

  it.each(refusals)(
    "a session PostgreSQL refuses at its start ($code, naming the user) is thrown scrubbed to its SQLSTATE",
    async ({ code, text, holds }) => {
      const server = await refusingServer(code, text);
      const secrets = probeSecrets("127.0.0.1", server.port);
      try {
        const url = probeUrl("127.0.0.1", server.port);
        const client = createClient({ primaryUrl: url, max: 1, env: {} });
        try {
          // What postgres.js rejects the transaction's first statement with: PostgreSQL's refusal, the user in it.
          const raw = await rejectionOf(client.primary`select 1`);
          expect(raw).toMatchObject({ name: "PostgresError", code });
          expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining([...holds]));

          // Not transient (a retry cannot mend a refused login; 53300 is CQ-271's, scrubbed and not transient).
          expectScopeOutcome(await throughScope(client.primary), { thrown: "database", code }, secrets);
          expectFaceOutcome(await throughFace(client.primary), { thrown: "database", code }, secrets);
        } finally {
          await client.close();
        }
      } finally {
        await server.close();
      }
    },
  );
});

describe("the frontier's read and its work around the start (T-1315)", () => {
  it("the frontier's read names its call: a session's failure is thrown scrubbed under readTurnState", async () => {
    const raw = connectError("EACCES", -13);
    expect(leaksOf(raw, SHAPE_SECRETS)).toEqual(expect.arrayContaining(["address", "port"]));
    const sql = failingSocketClient(raw);
    try {
      const thrown = await rejectionOf(pgFrontierRepo(sql).readTurnState(frontierRead(BARBERSHOP)));
      expect(Object.hasOwn(raw, "query")).toBe(true);
      expectScrubbed(thrown, { thrown: "client", code: "EACCES" });
      expect(leaksOf(thrown, SHAPE_SECRETS)).toEqual([]);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("once the transaction has started, work's own error is thrown as it is and work runs once (local PostgreSQL)", async () => {
    // The start only sets the scope on the local server (select 1, begin, set_config): no table is read or written.
    const client = createClient({ primaryUrl: resolvePrimaryUrl(), max: 1, env: {} });
    try {
      const scope = pgFrontierScope(client.primary);
      // Work's own error, with a SQLSTATE transientOrThrow answers transient (a serialization failure) and nothing of a
      // connection on it: after the start it is never taken for the start's, so work never runs a second time.
      const own = Object.assign(new Error("work's own error"), { code: "40001" });
      let works = 0;
      const thrown = await rejectionOf(
        scope.withBusiness(BARBERSHOP, () => {
          works += 1;
          return Promise.reject(own);
        }),
      );
      expect(thrown).toBe(own);
      expect(works).toBe(1);

      // The same scope still answers a work that ends under its business.
      await expect(scope.withBusiness(BARBERSHOP, () => Promise.resolve("answered"))).resolves.toBe(
        "answered",
      );
    } finally {
      await client.close();
    }
  });
});

// ---- the transaction's end (T-1330) ---------------------------------------------------------------------------------------

/** The local server (DATABASE_URL, else the local default): its connection string, host and port, never printed. */
function server(): { url: string; host: string; port: number } {
  const url = resolvePrimaryUrl();
  const { hostname, port } = new URL(url);
  return { url, host: hostname, port: port === "" ? 5432 : Number(port) };
}

/**
 * What an outcome at the end must never hold: the made-up connection the built errors carry, and the server's host and
 * port, which postgres.js's own CONNECTION_CLOSED names ("write CONNECTION_CLOSED <host>:<port>", both on it). The local
 * login, password and database are `rosie`, this repository's own folder, which every stack's file paths name, so they
 * are not listed: postgres.js's connection errors never carry them (errors.js connection: the code, the host, the port).
 */
function endSecrets(): Secrets {
  const { host, port } = server();
  return { ...SHAPE_SECRETS, ...secretsOf({ "server host": host, "server port": port }) };
}

/**
 * Where a call's connection is cut: just before the statement `at` picks from those built so far (the last one is the one
 * about to go), which is then never written. The socket is destroyed with `raw` (Node hands it to postgres.js as the
 * socket's error, which rejects the statement with it), or with none (postgres.js rejects it with its own
 * CONNECTION_CLOSED, as when the server closes the connection).
 */
interface Cut {
  at: (sent: readonly string[]) => boolean;
  raw: Error | null;
}

interface CutClient {
  readonly sql: Sql;
  /** Each statement's text as postgres.js built it, in order (its `debug` hook): never a value. */
  readonly sent: string[];
}

/**
 * A client on this file's schema as its runtime client is made (commit/pg/test-support.ts: rosie_job, the schema first),
 * one connection, through a socket to the same server, cut as `cut` says (postgres.js's own `socket` option).
 */
function cutClient(schema: string, cut: Cut | null): CutClient {
  const { url, host, port } = server();
  const sent: string[] = [];
  let cutNext = false;
  const options = {
    max: 1,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1330-frontier-end",
      search_path: `${schema}, public`,
      role: RUNTIME_ROLE,
    },
    debug: (_connection: number, text: string) => {
      sent.push(text);
      if (cut?.at(sent) === true) cutNext = true;
    },
    socket: () => {
      const socket = createConnection(port, host);
      const write = socket.write.bind(socket);
      socket.write = ((...args: Parameters<typeof write>) => {
        if (!cutNext) return write(...args);
        cutNext = false;
        socket.destroy(cut?.raw ?? undefined);
        return true;
      }) as typeof socket.write;
      return socket;
    },
  };
  return { sql: postgres(url, options), sent };
}

/** The statement the last one built is: `commit`, `rollback`. */
const lastIs =
  (text: string) =>
  (sent: readonly string[]): boolean =>
    sent.at(-1)?.trim() === text;

/** The frontier's own setting of its scope (the setting and the business), not the start's clearing of it. */
const FRONTIER_SCOPE = /^select set_config\(\$1, \$2, true\)$/;

/** `work`'s first read: the statement right after the frontier's setting of its scope. */
const firstRead = (sent: readonly string[]): boolean => FRONTIER_SCOPE.test(sent.at(-2)?.trim() ?? "");

/** Node's error for a connection the other end reset under a read: syscall read, and no address on it. */
function resetError(): Error {
  return Object.assign(new Error("read ECONNRESET"), { errno: -54, code: "ECONNRESET", syscall: "read" });
}

/**
 * A socket error with no code, as postgres.js's Workers build passes its socket's failure up (targets.ts transientOrThrow
 * reads it as a lost connection, 08006), its message naming the made-up connection string.
 */
function codelessSocketError(): Error {
  return new Error(`the socket closed: ${probeUrl(HOST, PORT)}`);
}

/** The ways a connection is cut at the end: each one's error (null: the socket just closes), its code, what it holds. */
const END_CUTS: {
  name: string;
  raw: () => Error | null;
  code: string | null;
  holds: readonly string[];
}[] = [
  {
    name: "the socket closes: postgres.js's own CONNECTION_CLOSED, the server's host and port in it",
    raw: () => null,
    code: "CONNECTION_CLOSED",
    holds: ["server host", "server port"],
  },
  {
    name: "postgres.js's CONNECTION_CLOSED, the made-up host and port on it",
    raw: () => connectionError("CONNECTION_CLOSED"),
    code: "CONNECTION_CLOSED",
    holds: ["host", "port"],
  },
  { name: "Node's ECONNRESET under a read", raw: resetError, code: "ECONNRESET", holds: [] },
  {
    name: "a socket error with no code, the made-up connection string in it",
    raw: codelessSocketError,
    code: null,
    holds: ["host", "port", "user", "password", "database"],
  },
];

/** What the frontier's end throws when `work` answered: its call's name and `code` alone (null: no code). */
function expectEndScrubbed(thrown: unknown, code: string | null): void {
  expect(thrown).toBeInstanceOf(Error);
  expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
  expect(thrown).toMatchObject({
    call: CALL,
    code,
    message: `${CALL}: the database call failed (${code === null ? "no code" : `code ${code}`})`,
  });
}

/** What a call threw (it must have thrown). */
function thrownOf(settled: Settled): unknown {
  expect("thrown" in settled).toBe(true);
  return (settled as { thrown: unknown }).thrown;
}

describe("the frontier's transaction end, once work has its repo (T-1330; local PostgreSQL)", () => {
  let cdb: CommitDatabase;

  beforeAll(async () => {
    ({ cdb } = await openTurnFaceDatabase(1, [], "frontier_end"));
  }, 120_000);

  afterAll(async () => {
    await cdb.close();
  });

  /** What postgres.js rejects a statement with when its socket is cut with `raw`: `raw` itself, or its own error. */
  async function rejectionAtCut(raw: Error | null): Promise<unknown> {
    const probe = cutClient(cdb.db.schema, { at: lastIs("select 1 as cut"), raw });
    try {
      return await rejectionOf(probe.sql`select 1 as cut`);
    } finally {
      await probe.sql.end({ timeout: 0 });
    }
  }

  /** One call through the scope on a cut client: `work` reads Sam's state, then answers, or throws `throws`. */
  async function scopeRun(
    cut: Cut | null,
    throws: Error | null = null,
  ): Promise<{ settled: Settled; works: number; sent: string[] }> {
    const client = cutClient(cdb.db.schema, cut);
    try {
      if (throws === null) return { ...(await throughScope(client.sql)), sent: client.sent };
      let works = 0;
      const settled = await settle(
        pgFrontierScope(client.sql).withBusiness(BARBERSHOP, async (repo) => {
          works += 1;
          await repo.readTurnState(frontierRead(BARBERSHOP));
          throw throws;
        }),
      );
      return { settled, works, sent: client.sent };
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  }

  /** Turn 1's buildFrontier through the turn face on a cut client: bundle v0 (it answers), or none (bundleNotFound). */
  async function faceRun(
    cut: Cut | null,
    bundled = true,
  ): Promise<{ settled: Settled; spans: Span[]; log: LogCapture; sent: string[] }> {
    const client = cutClient(cdb.db.schema, cut);
    try {
      if (bundled) return { ...(await throughFace(client.sql)), sent: client.sent };
      const log = captureLog();
      const face = pgTurnFace(client.sql, { bundles: fakeBundles(), validator, checker, log: log.sink });
      const { request } = s101Exchange();
      const { trace, spans } = traceFor(request);
      const settled = await settle(face.buildFrontier(structuredClone(request), trace));
      return { settled, spans, log, sent: client.sent };
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  }

  /** Where the end's scope read is among a call's statements, from a run with no cut: right before its commit. */
  function endScopeRead(sent: readonly string[]): number {
    const commit = sent.map((text) => text.trim()).lastIndexOf("commit");
    expect(commit).toBe(sent.length - 1);
    expect(sent[commit - 1]).toMatch(/current_setting/);
    return commit - 1;
  }

  /** The raw error the cut raises holds what it names, so the checks on the outcome mean something. */
  async function expectRawHolds(
    raw: Error | null,
    holds: readonly string[],
    secrets: Secrets,
  ): Promise<void> {
    const rejected = await rejectionAtCut(raw);
    if (raw !== null) expect(rejected).toBe(raw);
    else expect(rejected).toMatchObject({ code: "CONNECTION_CLOSED" });
    expect(leaksOf(rejected, secrets)).toEqual(expect.arrayContaining([...holds]));
    // postgres.js put the statement it rejected on the error.
    expect(Object.hasOwn(rejected as object, "query")).toBe(true);
  }

  /** Through the face: the end's scrubbed error thrown on, one frontier span failed with its name; nothing holds a secret. */
  function expectFaceEnd(
    outcome: { settled: Settled; spans: Span[]; log: LogCapture },
    code: string | null,
    secrets: Secrets,
  ): void {
    for (const seen of [outcome.settled, outcome.spans, outcome.log.lines]) {
      expect(leaksOf(seen, secrets)).toEqual([]);
    }
    expectEndScrubbed(thrownOf(outcome.settled), code);
    expect(outcome.spans).toHaveLength(1);
    expect(outcome.spans[0]).toMatchObject({
      hop: "frontier",
      outcome: "failed",
      error_code: "Error",
      business_id: BARBERSHOP,
    });
  }

  it("with no cut, the scope and the face answer and commit (the runs every cut below is placed by)", async () => {
    const scoped = await scopeRun(null);
    expect(scoped.settled).toMatchObject({ answer: { turnState: { result: "turnState" } } });
    endScopeRead(scoped.sent);
    const faced = await faceRun(null);
    expect("answer" in faced.settled).toBe(true);
    expect(faced.spans[0]).toMatchObject({ hop: "frontier", outcome: "ok", error_code: null });
    endScopeRead(faced.sent);
  });

  it.each(END_CUTS)(
    "work answered, then the scope read fails ($name): thrown scrubbed, never transient, nothing sent after it",
    async ({ raw, code, holds }) => {
      const secrets = endSecrets();
      await expectRawHolds(raw(), holds, secrets);

      const scopeAt = endScopeRead((await scopeRun(null)).sent);
      const scoped = await scopeRun({ at: (sent) => sent.length - 1 === scopeAt, raw: raw() });
      expect(scoped.sent).toHaveLength(scopeAt + 1);
      expect(scoped.works).toBe(1);
      expect(leaksOf(scoped.settled, secrets)).toEqual([]);
      expectEndScrubbed(thrownOf(scoped.settled), code);

      const faceAt = endScopeRead((await faceRun(null)).sent);
      const faced = await faceRun({ at: (sent) => sent.length - 1 === faceAt, raw: raw() });
      expect(faced.sent).toHaveLength(faceAt + 1);
      expectFaceEnd(faced, code, secrets);
    },
  );

  it.each(END_CUTS)(
    "work answered, then the commit fails ($name): thrown scrubbed, never transient",
    async ({ raw, code, holds }) => {
      const secrets = endSecrets();
      await expectRawHolds(raw(), holds, secrets);

      const scoped = await scopeRun({ at: lastIs("commit"), raw: raw() });
      expect(scoped.sent.at(-1)).toBe("commit");
      expect(scoped.works).toBe(1);
      expect(leaksOf(scoped.settled, secrets)).toEqual([]);
      expectEndScrubbed(thrownOf(scoped.settled), code);

      const faced = await faceRun({ at: lastIs("commit"), raw: raw() });
      expect(faced.sent.at(-1)).toBe("commit");
      expectFaceEnd(faced, code, secrets);
    },
  );

  it.each(END_CUTS)(
    "work threw, then the rollback fails ($name): work's own error leaves, never the rollback's",
    async ({ raw, holds }) => {
      const secrets = endSecrets();
      await expectRawHolds(raw(), holds, secrets);

      // Through the scope: work's own error, with nothing of a connection on it, leaves as it is.
      const own = new Error("work's own error");
      const scoped = await scopeRun({ at: lastIs("rollback"), raw: raw() }, own);
      expect(scoped.sent.at(-1)).toBe("rollback");
      expect(scoped.works).toBe(1);
      expect(thrownOf(scoped.settled)).toBe(own);
      expect(leaksOf(scoped.settled, secrets)).toEqual([]);

      // Through the face: with no bundle the frontier answers bundleNotFound, which the base rolls back as its error
      // answer (ErrorAnswer) and answers as it is; its span refused with that code.
      const faced = await faceRun({ at: lastIs("rollback"), raw: raw() }, false);
      expect(faced.sent.at(-1)).toBe("rollback");
      for (const seen of [faced.settled, faced.spans, faced.log.lines]) {
        expect(leaksOf(seen, secrets)).toEqual([]);
      }
      expect(faced.settled).toMatchObject({ answer: { error: "bundleNotFound" } });
      const answer = (faced.settled as { answer: BuildFrontierCallAnswer }).answer;
      expect(validator.check("buildFrontier", "errors", answer)).toEqual([]);
      expect(faced.spans).toHaveLength(1);
      expect(faced.spans[0]).toMatchObject({
        hop: "frontier",
        outcome: "refused",
        error_code: "bundleNotFound",
        business_id: BARBERSHOP,
      });
    },
  );

  it.each(END_CUTS)(
    "the connection is lost under work's read ($name): transient to the read, and no rollback, scope read or commit is sent on it",
    async ({ raw, holds }) => {
      const secrets = endSecrets();
      await expectRawHolds(raw(), holds, secrets);

      // Through the face: the read answers transient, the frontier answers it, and the base answers K-09's transient
      // (its error answer, ErrorAnswer, is what leaves the scope): the span failed. No rollback goes on the lost connection.
      const faced = await faceRun({ at: firstRead, raw: raw() });
      expect(faced.sent.at(-2)).toMatch(FRONTIER_SCOPE);
      for (const seen of [faced.settled, faced.spans, faced.log.lines]) {
        expect(leaksOf(seen, secrets)).toEqual([]);
      }
      expect(faced.settled).toEqual({ answer: LOST });
      const answer = (faced.settled as { answer: BuildFrontierCallAnswer }).answer;
      expect(validator.check("buildFrontier", "errors", answer)).toEqual([]);
      expect(faced.spans).toHaveLength(1);
      expect(faced.spans[0]).toMatchObject({
        hop: "frontier",
        outcome: "failed",
        error_code: "transient",
        business_id: BARBERSHOP,
      });

      // Through the scope: work reads the transient and answers anyway. The scope cannot be read on the lost connection, so
      // the call is thrown scrubbed to the read's SQLSTATE, and nothing more is sent on it.
      const scoped = await scopeRun({ at: firstRead, raw: raw() });
      expect(scoped.sent.at(-2)).toMatch(FRONTIER_SCOPE);
      expect(scoped.works).toBe(1);
      expect(leaksOf(scoped.settled, secrets)).toEqual([]);
      const thrown = thrownOf(scoped.settled);
      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(thrown).toMatchObject({ call: CALL, code: LOST.sqlstate, table: null, constraint: null });
      expect((thrown as Error).message).toBe(
        `${CALL}: the database refused the call (SQLSTATE ${LOST.sqlstate})`,
      );
    },
  );

  it("work's own error that carries a connection's detail is thrown scrubbed: the call's name and the code alone", async () => {
    const raw = connectError("EACCES", -13);
    expect(leaksOf(raw, SHAPE_SECRETS)).toEqual(expect.arrayContaining(["address", "port"]));
    const scoped = await scopeRun(null, raw);
    expect(scoped.works).toBe(1);
    expect(scoped.sent.at(-1)).toBe("rollback");
    expect(leaksOf(scoped.settled, endSecrets())).toEqual([]);
    expectEndScrubbed(thrownOf(scoped.settled), "EACCES");
  });
});

// ---- T-1368: the start refused with the database named --------------------------------------------------------------

/**
 * PostgreSQL's refusals of a session at its start that name the database (postinit.c InitPostgres and CheckMyDatabase),
 * each with the planted database in its message as the server words it.
 */
const DATABASE_REFUSALS: { code: string; text: string }[] = [
  { code: "3D000", text: `database "${PROBE_DATABASE}" does not exist` },
  { code: "42501", text: `permission denied for database "${PROBE_DATABASE}"` },
  { code: "55000", text: `database "${PROBE_DATABASE}" is not currently accepting connections` },
];

/** A backend message: its type byte, its length (itself and the body), then the body. */
function backendMessage(type: string, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const message = new Uint8Array(body.length + 5);
  const view = new DataView(message.buffer);
  view.setUint8(0, type.charCodeAt(0));
  view.setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
}

/** The bytes of each part, one after another. */
function joined(...parts: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

/** The bytes as a DataView, to read a frontend message's type byte and length. */
const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The zero-ended text at `start` of a frontend message's body, and where the field after it starts. */
function textAt(body: Uint8Array, start: number): { text: string; next: number } {
  const end = body.indexOf(0, start);
  return { text: new TextDecoder().decode(body.subarray(start, end)), next: end + 1 };
}

/** A statement's command tag, as PostgreSQL's CommandComplete gives it (a select here returns no row). */
function tagOf(statement: string): string {
  const word = (statement.trim().split(/\s+/)[0] ?? "").toUpperCase();
  return word === "SELECT" ? "SELECT 0" : word;
}

/**
 * A local server that accepts each session and the frontier's start up to its own setting, which it refuses with 57014
 * (a statement timeout or a cancel), as PostgreSQL would, following postgres.js 3.4.9's side as T-1331's scope test does
 * (db/repo/scope.int.test.ts; connection.js 156-244, 535-588 and 812-819): AuthenticationOk and ReadyForQuery after the
 * startup message; each extended query (Parse, Describe, Bind, Execute, Sync: the type fetch, the start's `select 1`,
 * the clearing of the scope) answered with no row; each simple query (the begin, the watch) answered by its tag. The
 * frontier's own setting (FRONTIER_SCOPE, sent with Describe and Flush, since it has values) gets the ErrorResponse at
 * its Parse; every message is then dropped until the Sync postgres.js sends on it, answered ReadyForQuery in a failed
 * transaction; the rollback is answered ROLLBACK, idle.
 */
async function settingRefusingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    const statements = new Map<string, string>();
    let pending: Uint8Array = new Uint8Array(0);
    let started = false;
    let bound = "";
    let status = "I";
    let failed = false;
    const ready = (): Uint8Array => backendMessage("Z", new TextEncoder().encode(status));
    const complete = (tag: string): Uint8Array => {
      status = tag === "BEGIN" ? "T" : tag === "COMMIT" || tag === "ROLLBACK" ? "I" : status;
      return backendMessage("C", new TextEncoder().encode(`${tag}\u0000`));
    };
    const answer = (type: string, body: Uint8Array): void => {
      if (type === "X") {
        socket.end();
      } else if (type === "S") {
        failed = false;
        socket.write(ready());
      } else if (failed) {
        // After an error PostgreSQL reads every message up to the next Sync and answers none.
      } else if (type === "Q") {
        socket.write(joined(complete(tagOf(textAt(body, 0).text)), ready()));
      } else if (type === "P") {
        const name = textAt(body, 0);
        const statement = textAt(body, name.next).text;
        if (FRONTIER_SCOPE.test(statement.trim())) {
          failed = true;
          status = status === "T" ? "E" : status;
          const timedOut = {
            S: "ERROR",
            V: "ERROR",
            C: "57014",
            M: "canceling statement due to statement timeout",
          };
          socket.write(errorResponse(timedOut));
          return;
        }
        statements.set(name.text, statement);
        socket.write(backendMessage("1"));
      } else if (type === "D") {
        socket.write(joined(backendMessage("t", new Uint8Array(2)), backendMessage("n")));
      } else if (type === "B") {
        const portal = textAt(body, 0);
        bound = statements.get(textAt(body, portal.next).text) ?? "";
        socket.write(backendMessage("2"));
      } else if (type === "E") {
        socket.write(complete(tagOf(bound)));
      }
      // A Flush (H) needs no answer: every answer is written as it is made.
    };
    socket.on("data", (chunk: Uint8Array) => {
      pending = joined(pending, chunk);
      for (;;) {
        if (!started) {
          // The startup message: its length, then the protocol and the parameters, with no type byte.
          if (pending.length < 4 || pending.length < viewOf(pending).getUint32(0)) return;
          pending = pending.subarray(viewOf(pending).getUint32(0));
          started = true;
          socket.write(joined(backendMessage("R", new Uint8Array(4)), ready()));
          continue;
        }
        if (pending.length < 5 || pending.length < viewOf(pending).getUint32(1) + 1) return;
        const end = viewOf(pending).getUint32(1) + 1;
        answer(String.fromCharCode(viewOf(pending).getUint8(0)), pending.subarray(5, end));
        pending = pending.subarray(end);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

describe("the frontier's start refused with its database named, or at its own setting (T-1368)", () => {
  it.each(DATABASE_REFUSALS)(
    "a session PostgreSQL refuses at its start with $code, the planted database in its message, is thrown scrubbed to its SQLSTATE",
    async ({ code, text }) => {
      const server = await refusingServer(code, text);
      const secrets = probeSecrets("127.0.0.1", server.port);
      try {
        const client = createClient({ primaryUrl: probeUrl("127.0.0.1", server.port), max: 1, env: {} });
        try {
          // What postgres.js rejects the transaction's first statement with: PostgreSQL's refusal, the database in it.
          const raw = await rejectionOf(client.primary`select 1`);
          expect(raw).toMatchObject({ name: "PostgresError", code });
          expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["database"]));

          // Never transient, and never as PostgreSQL words it: the call's name and the SQLSTATE alone.
          expectScopeOutcome(await throughScope(client.primary), { thrown: "database", code }, secrets);
          expectFaceOutcome(await throughFace(client.primary), { thrown: "database", code }, secrets);
        } finally {
          await client.close();
        }
      } finally {
        await server.close();
      }
    },
  );

  it("the frontier's own setting refused with 57014, the business id among its values, is thrown scrubbed to its SQLSTATE", async () => {
    const server = await settingRefusingServer();
    const secrets = { ...probeSecrets("127.0.0.1", server.port), ...secretsOf({ business: BARBERSHOP }) };
    try {
      const client = createClient({ primaryUrl: probeUrl("127.0.0.1", server.port), max: 1, env: {} });
      try {
        // What postgres.js rejects the setting with: PostgreSQL's refusal, the statement and its values put on it.
        const raw = await rejectionOf(
          client.primary.begin(async (tx) => {
            await tx`select set_config(${SCOPE_SETTING}, ${BARBERSHOP}, true)`;
          }),
        );
        expect(raw).toMatchObject({ name: "PostgresError", code: "57014" });
        expect((raw as { query?: unknown }).query).toMatch(FRONTIER_SCOPE);
        expect(leaksOf((raw as { parameters?: unknown }).parameters, secrets)).toEqual(["business"]);
        expect(leaksOf((raw as { args?: unknown }).args, secrets)).toEqual(["business"]);

        // Through the scope: thrown scrubbed, work never run. The scope's settled outcome holds no business id.
        const scoped = await throughScope(client.primary);
        expectScopeOutcome(scoped, { thrown: "database", code: "57014" }, secrets);

        // Through the face: the same thrown on; the span names the business by its label, as every frontier span does,
        // and the thrown error holds none of it.
        const faced = await throughFace(client.primary);
        const faceSecrets = probeSecrets("127.0.0.1", server.port);
        expectFaceOutcome(faced, { thrown: "database", code: "57014" }, faceSecrets);
        expect(leaksOf(thrownOf(faced.settled), secrets)).toEqual([]);
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  });
});

// ---- T-1368: a close while the transaction waits between its statements ------------------------------------------------

/** How a test closes the call's connection while its transaction waits with no statement in flight on it. */
type IdleClose = "terminate" | "end" | "reset";

const IDLE_CLOSES: { name: string; how: IdleClose }[] = [
  {
    name: "the server ends the session (pg_terminate_backend: FATAL 57P01, then the close)",
    how: "terminate",
  },
  { name: "the socket closes with no error, as a pooler or the network would close it", how: "end" },
  { name: "the socket is reset (Node's ECONNRESET)", how: "reset" },
];

/** A client on this file's schema as the runtime client is made, one connection, whose socket the test can close. */
interface ClosingClient {
  readonly sql: Sql;
  /** Each statement's text as postgres.js built it, in order (its `debug` hook): never a value. */
  readonly sent: string[];
  /** The application name its connection carries, its own (pg_stat_activity). */
  readonly application: string;
  /** Its sockets, in the order postgres.js asked for them (postgres.js's own `socket` option). */
  readonly sockets: Socket[];
}

/** Where a close came: the statements built by then, and the server's state of the call's backend just before it. */
interface Closing {
  sentAtClose: number | null;
  stateAtClose: string | null;
}

/**
 * K-02's context-two-requests.json hub choice, made a choice about turn 1's business at S1-02, whose K-01 needs bundle v0
 * lists (`thread`): a stand-in slot beside the registry's, so the facts read the step's needs through the bundles port
 * (facts.ts factsFor, step 2) and then the home's row (step 4).
 */
function hubSlot(): SourceSlot {
  const context = contractFixture("model/fixtures/context-two-requests.json") as {
    choices: Record<string, unknown>[];
  };
  const hub = context.choices.find((choice) => choice.kind === "hub");
  if (hub === undefined) throw new Error("context-two-requests.json holds no hub choice");
  const target = { businessId: BARBERSHOP, businessName: "Lee's Barbershop", bookingId: null, visitAt: null };
  return { name: "t1368Hub", source: standIn("t1368Hub", [{ ...hub, step: "S1-02", target }]) };
}

describe("a close while the frontier's transaction waits between its statements (T-1368; local PostgreSQL)", () => {
  let cdb: CommitDatabase;
  let killer: Sql | undefined;
  let clients = 0;

  beforeAll(async () => {
    ({ cdb } = await openTurnFaceDatabase(1, [], "frontier_close"));
    killer = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
  }, 120_000);

  afterAll(async () => {
    await killer?.end({ timeout: 5 });
    await cdb.close();
  });

  function closingClient(): ClosingClient {
    const { url, host, port } = server();
    clients += 1;
    const application = `rosie-t1368-frontier-close-${String(clients)}`;
    const sent: string[] = [];
    const sockets: Socket[] = [];
    const options = {
      max: 1,
      onnotice: () => undefined,
      connection: {
        application_name: application,
        search_path: `${cdb.db.schema}, public`,
        role: RUNTIME_ROLE,
      },
      debug: (_connection: number, text: string) => {
        sent.push(text);
      },
      socket: () => {
        const socket = createConnection(port, host);
        sockets.push(socket);
        return socket;
      },
    };
    return { sql: postgres(url, options), sent, application, sockets };
  }

  /**
   * Closes the client's connection as `how` says, while its transaction waits, and resolves once postgres.js has heard the
   * close (its own listener on the socket runs first). Gives the server's state of the backend just before.
   */
  async function closeWhileWaiting(client: ClosingClient, how: IdleClose): Promise<string | null> {
    const socket = client.sockets.at(-1);
    if (socket === undefined || killer === undefined) throw new Error("no socket, or no second connection");
    const [backend] = await killer<{ pid: number; state: string | null }[]>`
      select pid, state from pg_stat_activity where application_name = ${client.application}
    `;
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        resolve();
      });
    });
    if (how === "terminate") {
      await killer`select pg_terminate_backend(${backend?.pid ?? 0})`;
    } else {
      socket.destroy(how === "reset" ? resetError() : undefined);
    }
    await closed;
    return backend?.state ?? null;
  }

  /** Bundle v0 (fakeBundles), each read written down; the read at `closeAt` first closes the call's connection. */
  function closingBundles(
    closeAt: number | null,
    close: () => Promise<void>,
  ): FrontierBundles & { readonly reads: string[] } {
    const inner = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
    let next = 0;
    const before = async (): Promise<void> => {
      const at = next;
      next += 1;
      if (at === closeAt) await close();
    };
    return {
      reads: inner.reads,
      async manifest(bundleId) {
        await before();
        return inner.manifest(bundleId);
      },
      async flow(bundleId, flow) {
        await before();
        return inner.flow(bundleId, flow);
      },
    };
  }

  interface FaceRun extends Closing {
    settled: Settled;
    spans: Span[];
    log: LogCapture;
    sent: string[];
    reads: string[];
    /** How many facts' reads buildFrontier asked of its repo (the facts run only). */
    factReads: number;
  }

  /**
   * Turn 1's buildFrontier on a closing client, the connection closed `how` at bundle read `closeAt` (null: never): through
   * the turn face (pgTurnFace), or, with `facts`, through the base with the registry's sources, the hub slot and a home
   * for `thread` (businesses.name of the call's business), so the facts read S1-02's needs and then its home's row.
   */
  async function faceRun(closeAt: number | null, how: IdleClose, facts = false): Promise<FaceRun> {
    const client = closingClient();
    const closing: Closing = { sentAtClose: null, stateAtClose: null };
    const bundles = closingBundles(closeAt, async () => {
      closing.stateAtClose = await closeWhileWaiting(client, how);
      closing.sentAtClose = client.sent.length;
    });
    const log = captureLog();
    let factReads = 0;
    const { request } = s101Exchange();
    const { trace, spans } = traceFor(request);
    try {
      let answering: Promise<unknown>;
      if (!facts) {
        const face = pgTurnFace(client.sql, { bundles, validator, checker, log: log.sink });
        answering = face.buildFrontier(structuredClone(request), trace);
      } else {
        const homes = factHomes([
          { name: "thread", home: "record", table: "businesses", column: "name", row: { of: "business" } },
        ]);
        const handlers = frontierHandlers<FrontierRepo>({
          bundles,
          checker,
          log: log.sink,
          sources: [...frontierSources(bundles), hubSlot()],
          facts: {
            homes,
            port: (repo, scope) => {
              const port = turnStateFactsPort(repo, scope);
              return {
                readFacts: (refs, mode) => {
                  factReads += 1;
                  return port.readFacts(refs, mode);
                },
              };
            },
          },
        });
        const api = createToolApi({ validator, scope: pgFrontierScope(client.sql), handlers });
        answering = api.call("buildFrontier", structuredClone(request), trace);
      }
      const settled = await settle(answering);
      return { settled, spans, log, sent: client.sent, reads: bundles.reads, factReads, ...closing };
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  }

  /** The close came while the transaction waited, and nothing was built on the connection after it. */
  function expectNothingAfterClose(run: Closing & { sent: string[] }, what: string): void {
    expect(run.stateAtClose, what).toBe("idle in transaction");
    expect(run.sentAtClose, what).not.toBeNull();
    expect(run.sent, what).toHaveLength(run.sentAtClose ?? -1);
  }

  /** What the face left after the close: K-09's transient, or the end thrown scrubbed; one frontier span, failed. */
  function expectFaceAfterClose(run: FaceRun, expected: "transient" | "thrown", what: string): void {
    const secrets = endSecrets();
    for (const seen of [run.settled, run.spans, run.log.lines]) {
      expect(leaksOf(seen, secrets), what).toEqual([]);
    }
    expect(run.spans, what).toHaveLength(1);
    if (expected === "transient") {
      expect(run.settled, what).toEqual({ answer: LOST });
      const answer = (run.settled as { answer: BuildFrontierCallAnswer }).answer;
      expect(validator.check("buildFrontier", "errors", answer), what).toEqual([]);
      expect(run.spans[0], what).toMatchObject({
        hop: "frontier",
        outcome: "failed",
        error_code: "transient",
        business_id: BARBERSHOP,
      });
      return;
    }
    expectScrubbed(thrownOf(run.settled), { thrown: "database", code: LOST.sqlstate });
    expect(run.spans[0], what).toMatchObject({
      hop: "frontier",
      outcome: "failed",
      error_code: "DataAccessDatabaseError",
      business_id: BARBERSHOP,
    });
  }

  it("with no close, turn 1 reads the manifest before its state and bundle v0's flows after it, and answers", async () => {
    const run = await faceRun(null, "end");
    expect(run.sentAtClose).toBeNull();
    expect("answer" in run.settled).toBe(true);
    expect(run.spans[0]).toMatchObject({ hop: "frontier", outcome: "ok" });
    expect(run.reads[0]).toMatch(/\/manifest$/);
    expect(run.reads.slice(1).every((read) => read.endsWith("/flow/A"))).toBe(true);
    expect(run.reads.length).toBeGreaterThanOrEqual(2);
    // The watch went first in the transaction, the frontier's setting right behind it.
    const setting = run.sent.findIndex((text) => FRONTIER_SCOPE.test(text.trim()));
    expect(run.sent[setting - 1]?.trim()).toBe("select 1 as watch");
  });

  it.each(IDLE_CLOSES)(
    "$name at each of turn 1's bundle reads: nothing built after it, nothing uncaught, transient before the state's read, else the end thrown scrubbed",
    async ({ how }) => {
      const { reads } = await faceRun(null, how);
      for (let at = 0; at < reads.length; at += 1) {
        const what = `${how} at read ${String(at)} (${reads[at] ?? ""})`;
        const run = await faceRun(at, how);
        expectNothingAfterClose(run, what);
        // The manifest (handler.ts step 1) comes before the state's read, which then answers transient unsent; every
        // later read (steps 4 and 5) comes after it, and the end, neither scope read nor commit sent, is thrown scrubbed.
        expectFaceAfterClose(run, at === 0 ? "transient" : "thrown", what);
      }
    },
  );

  it.each(IDLE_CLOSES)(
    "$name at the facts' read of a step's needs (facts.ts): the facts' read answers transient unsent, and K-09's transient leaves",
    async ({ how }) => {
      const plain = await faceRun(null, how, true);
      // The facts read S1-02's needs last, and then asked their read.
      expect(plain.reads.length).toBeGreaterThanOrEqual(3);
      expect(plain.factReads).toBe(1);
      const at = plain.reads.length - 1;
      const run = await faceRun(at, how, true);
      expectNothingAfterClose(run, how);
      expect(run.factReads).toBe(1);
      expectFaceAfterClose(run, "transient", how);
    },
  );

  /** One call through the scope on a closing client: `work` gets the repo and a way to close the connection now. */
  async function scopeRun(
    how: IdleClose,
    work: (repo: FrontierRepo, close: () => Promise<void>) => Promise<unknown>,
  ): Promise<Closing & { settled: Settled; works: number; sent: string[] }> {
    const client = closingClient();
    const closing: Closing = { sentAtClose: null, stateAtClose: null };
    const close = async (): Promise<void> => {
      closing.stateAtClose = await closeWhileWaiting(client, how);
      closing.sentAtClose = client.sent.length;
    };
    let works = 0;
    try {
      const settled = await settle(
        pgFrontierScope(client.sql).withBusiness(BARBERSHOP, (repo) => {
          works += 1;
          return work(repo, close);
        }),
      );
      return { settled, works, sent: client.sent, ...closing };
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  }

  it.each(IDLE_CLOSES)(
    "$name through the scope, before work's read, after it, and before work's own error: nothing sent after it",
    async ({ how }) => {
      const secrets = endSecrets();

      // Before the read: the read answers transient and sends nothing; work answers; the end is thrown scrubbed.
      let read: unknown = null;
      const before = await scopeRun(how, async (repo, close) => {
        await close();
        read = await repo.readTurnState(frontierRead(BARBERSHOP));
        return read;
      });
      expectNothingAfterClose(before, `${how}: before the read`);
      expect(read).toEqual(LOST);
      expect(before.works).toBe(1);
      expect(leaksOf(before.settled, secrets)).toEqual([]);
      expectScrubbed(thrownOf(before.settled), { thrown: "database", code: LOST.sqlstate });

      // After the read: work answers; neither the scope read nor the commit is sent; the end is thrown scrubbed.
      let state: unknown = null;
      const after = await scopeRun(how, async (repo, close) => {
        state = await repo.readTurnState(frontierRead(BARBERSHOP));
        await close();
        return state;
      });
      expectNothingAfterClose(after, `${how}: after the read`);
      expect(state).toMatchObject({ result: "turnState", businessId: BARBERSHOP });
      expect(leaksOf(after.settled, secrets)).toEqual([]);
      expectScrubbed(thrownOf(after.settled), { thrown: "database", code: LOST.sqlstate });

      // Work's own error after the close: no rollback is sent, and work's own error leaves as it is.
      const own = new Error("work's own error");
      const thrown = await scopeRun(how, async (repo, close) => {
        await repo.readTurnState(frontierRead(BARBERSHOP));
        await close();
        throw own;
      });
      expectNothingAfterClose(thrown, `${how}: work threw`);
      expect(thrownOf(thrown.settled)).toBe(own);
    },
  );
});
