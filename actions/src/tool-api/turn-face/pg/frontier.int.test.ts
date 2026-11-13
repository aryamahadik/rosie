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

import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { createClient, resolvePrimaryUrl } from "../../../../../db/repo/client";
import { DataAccessDatabaseError } from "../../../../../db/repo/clocks";
import type { Sql } from "../../../../../db/repo/scope";
import type { TransientError } from "../../../../../db/repo/targets";
import type { Span } from "../../../../../runtime/src/trace";
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
import { BARBERSHOP, SAM, SAM_HANDLE } from "./test-support";

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
