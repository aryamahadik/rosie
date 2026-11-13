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

import { once } from "node:events";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, resolvePrimaryUrl } from "../../../../../db/repo/client";
import { DataAccessDatabaseError } from "../../../../../db/repo/clocks";
import type { Sql } from "../../../../../db/repo/scope";
import type { TransientError } from "../../../../../db/repo/targets";
import type { Span } from "../../../../../runtime/src/trace";
import { RUNTIME_ROLE, type CommitDatabase } from "../../../commit/pg/test-support";
import { frameFacts } from "../../../frontier/assemble/frame";
import {
  captureLog,
  checks,
  fakeBundles,
  k05Problems,
  sampleBundle,
  type LogCapture,
} from "../../../frontier/assemble/test-support";
import type { ReadTurnStateRequest } from "../../../frontier/assemble/types";
import { traceFor } from "../../test-support";
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
