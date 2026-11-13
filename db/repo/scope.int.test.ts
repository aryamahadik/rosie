// T-1331 (T-1315's handoff b; DL-630, DL-694): db/repo/scope.ts withBusiness starts its transaction through T-1268's
// transientOrThrow, under the name of the call it is opened for, so a connect failure at the start never leaves as
// postgres.js raises it; since round 3 (DL-708, DL-710) through clocks.ts's transientOrScrubbed, so no failure of the
// start leaves raw. `npm run db:up`, then `npm run test:integration -- db/repo/scope`.
//
// Each failure is raised by postgres.js as installed (3.4.9) at the transaction's first statement, sql.begin's begin: a
// port nothing listens on (Node's ECONNREFUSED, for real); a socket that fails before it opens with an error built in the
// shape postgres.js or Node gives it (postgres.js's own `socket` option, so postgres.js passes the error up as it does a
// socket's and puts the statement on it: node_modules/postgres/src/errors.js and connection.js); a local server that
// refuses each session at its start with PostgreSQL's own ErrorResponse (class 28, 53300; 3D000, 42501 and 55000, which
// name the database). One is raised at the start's second statement, the scope's set_config: a local server that
// accepts the session and its begin, then refuses set_config with 57014, the business id on its statement. Each is seen
// through withBusiness itself, for a call whose contract has K-05's transient answer and for one whose has none, and
// through the turn face's three calls after the frontier, whose business scope is pgCallScope over withBusiness
// (actions/src/tool-api/turn-face/pg/calls.ts): gateAndCommit, composeInput and finalizeMessage on the Tool API base, as
// pgTurnFace and pgTurnCalls bind them. Each raw error is checked to hold what it names (so the check means something),
// and each outcome to hold none of the connection: neither the answer nor the thrown error's message, stack or other own
// properties. On local PostgreSQL, where the start only sets the scope (no table is read or written), once fn has begun
// what it throws leaves as it is, and fn runs once.
//
// Rule 9: the probe's user, password, database and hosts are made up here (.invalid names and RFC 5737's documentation
// addresses), and the turn face's requests are K-09's own fixtures. A check names what leaked, never its value, so a
// failing run prints no secret.

import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../actions/src/domain/safety";
import {
  captureLog,
  checks,
  fakeBundles,
  sampleBundle,
} from "../../actions/src/frontier/assemble/test-support";
import { fixture, traceFor } from "../../actions/src/tool-api/test-support";
import { commitRequestAfter } from "../../actions/src/tool-api/turn-face/calls-test-support";
import { NOTHING_OPEN_AT } from "../../actions/src/tool-api/turn-face/commit";
import { pgCallScope, pgTurnCalls, pgTurnFace } from "../../actions/src/tool-api/turn-face/pg";
import type { TurnFace } from "../../actions/src/tool-api/turn-face/turn-face";
import { createClient, resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import {
  BusinessScopeError,
  readBusinessScope,
  SCOPE_SETTING,
  setBusinessScope,
  type Sql,
  withBusiness,
} from "./scope";
import type { WrappingKeys } from "./sealing";
import type { TransientError } from "./targets";

/** The call a test's transaction is opened for: the name every scrubbed error of its start carries. */
const CALL = "readT1331Probe";
/** The name a start's failure carries when the caller names no call, as pgCallScope and db/repo/client.ts name none. */
const UNNAMED = "withBusiness";
const BUSINESS = "business-t1331";
const PROBE_USER = "t1331_probe_user";
const PROBE_PASSWORD = "t1331-probe-password";
const PROBE_DATABASE = "t1331_probe_db";
// The shapes' made-up connection: a host under .invalid (RFC 6761), RFC 5737's TEST-NET-3 address and a port.
const HOST = "db-t1331.example.invalid";
const ADDRESS = "203.0.113.31";
const PORT = 65131;
const SASL_MISMATCH = "The server did not return the correct signature";

const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };
const LOST: TransientError = { error: "transient", sqlstate: "08006" };

const { validator, checker } = checks();

/** A wrapping key made for this run alone; the sealer it is given never runs, since no call gets past its start. */
const KEYS: WrappingKeys = { resolve: () => crypto.getRandomValues(new Uint8Array(32)) };

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
 * A local server that accepts each session and its begin, then refuses the scope's set_config with 57014 (a statement
 * timeout or a cancel), as PostgreSQL would, following postgres.js 3.4.9's side (connection.js 156-244, 535-588 and
 * 812-819; index.js 241-273): AuthenticationOk and ReadyForQuery after the startup message; the type fetch's extended
 * query (Parse, Describe, Bind, Execute, Sync) answered with no row; the begin, a simple query, answered BEGIN in a
 * transaction. set_config's Parse (sent with Describe and Flush, since it has values) gets the ErrorResponse; every
 * message is then dropped until the Sync postgres.js sends on it, answered ReadyForQuery in a failed transaction; the
 * rollback is answered ROLLBACK, idle.
 */
async function scopeRefusingServer(): Promise<{ port: number; close: () => Promise<void> }> {
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
        if (statement.includes("set_config")) {
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

/** A client of db/repo/client.ts's making on `url` (one connection, no environment read). */
function clientOn(url: string): Sql {
  return createClient({ primaryUrl: url, max: 1, env: {} }).primary;
}

/**
 * A postgres.js client on the made-up connection whose socket fails with `raw` before it opens, as Node's socket or TLS
 * would fail it: postgres.js passes `raw` up as it does a socket's error, on the statement it rejects.
 */
function failingSocketClient(raw: Error): Sql {
  const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
  return postgres(probeUrl(HOST, PORT), options);
}

/** Runs `use` on a fresh client from `make`, then ends the client. */
async function onFreshClient<R>(make: () => Sql, use: (sql: Sql) => Promise<R>): Promise<R> {
  const sql = make();
  try {
    return await use(sql);
  } finally {
    await sql.end({ timeout: 0 });
  }
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

/** A socket's failure as postgres.js's Workers build passes it up: no code, its text naming the host and port. */
function codelessSocketError(): Error {
  return new Error(`the socket to ${HOST}:${String(PORT)} failed`);
}

// ---- what each outcome must be ------------------------------------------------------------------------------------------

/** What a failure at the transaction's start must leave: K-05's transient, or a scrubbed error of `code`. */
type Expected =
  { transient: TransientError } | { thrown: "client"; code: string } | { thrown: "database"; code: string };

/** How a call ended: what it answered, or what it threw. */
type Settled = { answer: unknown } | { thrown: unknown };

const settle = (promise: Promise<unknown>): Promise<Settled> =>
  promise.then(
    (answer) => ({ answer }),
    (thrown: unknown) => ({ thrown }),
  );

/** The thrown error is scrubbed: the call's name and the code alone, with nothing of the original's. */
function expectScrubbed(thrown: unknown, call: string, kind: "client" | "database", code: string): void {
  if (kind === "database") {
    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual([
      "call",
      "code",
      "constraint",
      "message",
      "name",
      "stack",
      "table",
    ]);
    expect(thrown).toMatchObject({ call, code, table: null, constraint: null });
    expect((thrown as Error).message).toBe(`${call}: the database refused the call (SQLSTATE ${code})`);
    return;
  }
  // clocks.ts's scrubbed client error: no message, stack, statement, cause or other property of the original's.
  expect(thrown).toBeInstanceOf(Error);
  expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
  expect(thrown).toMatchObject({ call, code, message: `${call}: the database call failed (code ${code})` });
}

/**
 * A start's outcome under `call`: K-05's transient answer when the caller has that answer (`answers`) and the failure
 * is transient; otherwise thrown scrubbed, a transient failure as DataAccessDatabaseError with its SQLSTATE. Neither
 * holds a secret.
 */
function expectOutcome(
  settled: Settled,
  expected: Expected,
  answers: boolean,
  call: string,
  secrets: Secrets,
): void {
  expect(leaksOf(settled, secrets)).toEqual([]);
  if ("transient" in expected && answers) {
    expect(settled).toEqual({ answer: expected.transient });
    return;
  }
  expect("thrown" in settled).toBe(true);
  const { thrown } = settled as { thrown: unknown };
  if ("transient" in expected) {
    expectScrubbed(thrown, call, "database", expected.transient.sqlstate);
    return;
  }
  expectScrubbed(thrown, call, expected.thrown, expected.code);
}

// ---- the ways in --------------------------------------------------------------------------------------------------------

/**
 * One withBusiness on `sql` under CALL, for a call whose contract has K-05's transient answer (`answers`: the answer is
 * the call's own) or one whose has none, and how many times fn ran.
 */
async function throughStart(
  sql: Sql,
  answers: boolean,
  readOnly = false,
): Promise<{ settled: Settled; runs: number }> {
  let runs = 0;
  const fn = (): Promise<string> => {
    runs += 1;
    return Promise.resolve("fn answered");
  };
  const options = answers
    ? { readOnly, call: CALL, transient: (answer: TransientError): string | TransientError => answer }
    : { readOnly, call: CALL };
  const settled = await settle(withBusiness<string | TransientError>(sql, BUSINESS, fn, options));
  return { settled, runs };
}

/** The turn face whose three calls after the frontier run on `sql` (pgTurnCalls: the Tool API's scope is pgCallScope). */
function faceOn(sql: Sql): TurnFace {
  const bundles = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  return pgTurnFace(sql, {
    bundles,
    validator,
    checker,
    log: captureLog().sink,
    calls: pgTurnCalls(sql, sql, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
    }),
  });
}

/** The three calls, each with K-09's own request for it (turn 1's commit, S1-02's row), on the trace it names. */
const FACE_CALLS: Readonly<Record<string, (face: TurnFace) => Promise<unknown>>> = {
  gateAndCommit: (face) => {
    const request = commitRequestAfter(undefined);
    return face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  },
  composeInput: (face) => {
    const { request } = fixture("compose-input-s1-02.json") as { request: Record<string, unknown> };
    return face.composeInput(request, traceFor(request).trace);
  },
  finalizeMessage: (face) => {
    const { request } = fixture("finalize-pass.json") as { request: Record<string, unknown> };
    return face.finalizeMessage(request, traceFor(request).trace);
  },
};

/**
 * The failure on a fresh client from `make` each time: withBusiness under CALL, as a call with the transient answer and
 * as one without, fn never running.
 */
async function expectStart(make: () => Sql, expected: Expected, secrets: Secrets): Promise<void> {
  for (const answers of [false, true]) {
    const outcome = await onFreshClient(make, (sql) => throughStart(sql, answers));
    expectOutcome(outcome.settled, expected, answers, CALL, secrets);
    expect(outcome.runs).toBe(0);
  }
}

/**
 * The failure on a fresh client from `make` each time through pgCallScope, which names no call and has no transient
 * answer (BusinessScope's withBusiness returns the base's own answer), and so through gateAndCommit, composeInput and
 * finalizeMessage: each throws it scrubbed, and no work runs.
 */
async function expectCallScope(make: () => Sql, expected: Expected, secrets: Secrets): Promise<void> {
  let works = 0;
  const settled = await onFreshClient(make, (sql) =>
    settle(
      pgCallScope(sql).withBusiness(BUSINESS, () => {
        works += 1;
        return Promise.resolve("work answered");
      }),
    ),
  );
  expectOutcome(settled, expected, false, UNNAMED, secrets);
  expect(works).toBe(0);
  for (const [call, run] of Object.entries(FACE_CALLS)) {
    const faced = await onFreshClient(make, (sql) => settle(run(faceOn(sql))));
    expect(leaksOf(faced, secrets), call).toEqual([]);
    expect("thrown" in faced, call).toBe(true);
    expectOutcome(faced, expected, false, UNNAMED, secrets);
  }
}

// ---- the tests ------------------------------------------------------------------------------------------------------------

const shapes: { name: string; make: () => Error; holds: readonly string[]; expected: Expected }[] = [
  {
    name: "postgres.js's CONNECTION_CLOSED, its host and port on it, is a lost connection: transient 08006",
    make: () => connectionError("CONNECTION_CLOSED"),
    holds: ["host", "port"],
    expected: { transient: LOST },
  },
  {
    name: "postgres.js's CONNECTION_DESTROYED from its pool is a lost connection: transient 08006",
    make: () => poolError("CONNECTION_DESTROYED"),
    holds: ["host", "port"],
    expected: { transient: LOST },
  },
  {
    name: "a socket's failure with no code (postgres.js's Workers build), the host and port in it: transient 08006",
    make: codelessSocketError,
    holds: ["host", "port"],
    expected: { transient: LOST },
  },
  {
    name: "postgres.js's CONNECT_TIMEOUT never opened: transient 08001",
    make: () => connectionError("CONNECT_TIMEOUT"),
    holds: ["host", "port"],
    expected: { transient: NEVER_OPENED },
  },
  {
    name: "Node's ENOTFOUND, the host on it, never opened: transient 08001",
    make: () => lookupError("ENOTFOUND", -3008),
    holds: ["host"],
    expected: { transient: NEVER_OPENED },
  },
  {
    name: "Node's ECONNREFUSED, the address and port on it, never opened: transient 08001",
    make: () => connectError("ECONNREFUSED", -61),
    holds: ["address", "port"],
    expected: { transient: NEVER_OPENED },
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

/** PostgreSQL's refusals of a session at its start: `names`, what its test's title says the refusal names. */
const refusals: {
  code: string;
  names: string;
  text: string;
  holds: readonly string[];
  secrets: Secrets;
}[] = [
  {
    code: "28P01",
    names: "user",
    text: `password authentication failed for user "${PROBE_USER}"`,
    holds: ["user"],
    secrets: {},
  },
  {
    code: "28000",
    names: "user",
    text: `no pg_hba.conf entry for host "${ADDRESS}", user "${PROBE_USER}", database "${PROBE_DATABASE}"`,
    holds: ["address", "user", "database"],
    secrets: secretsOf({ address: ADDRESS }),
  },
  {
    code: "53300",
    names: "user",
    text: `too many connections for role "${PROBE_USER}"`,
    holds: ["user"],
    secrets: {},
  },
  // Round 3 (DL-708): the refusals that name the database (PostgreSQL's postinit.c, InitPostgres and CheckMyDatabase).
  {
    code: "3D000",
    names: "database",
    text: `database "${PROBE_DATABASE}" does not exist`,
    holds: ["database"],
    secrets: {},
  },
  {
    code: "42501",
    names: "database",
    text: `permission denied for database "${PROBE_DATABASE}"`,
    holds: ["database"],
    secrets: {},
  },
  {
    code: "55000",
    names: "database",
    text: `database "${PROBE_DATABASE}" is not currently accepting connections`,
    holds: ["database"],
    secrets: {},
  },
];

/** The scope's set_config refused with 57014 (a statement timeout or a cancel): no lost connection, so never transient. */
const TIMED_OUT: Expected = { thrown: "database", code: "57014" };

/**
 * A shape's raw error holds what it names, and postgres.js rejects the transaction's first statement (sql.begin's begin)
 * with it, the statement put on it: the start's failure, before fn.
 */
async function expectShapeRaised(make: () => Error, holds: readonly string[]): Promise<void> {
  const raw = make();
  expect(leaksOf(raw, SHAPE_SECRETS)).toEqual(expect.arrayContaining([...holds]));
  const outcome = await onFreshClient(
    () => failingSocketClient(raw),
    (sql) => throughStart(sql, false),
  );
  expect("thrown" in outcome.settled).toBe(true);
  expect(outcome.runs).toBe(0);
  expect(Object.hasOwn(raw, "query")).toBe(true);
}

describe("withBusiness's start on a connection that never opens, is lost or is refused (T-1331)", () => {
  it("a closed port: Node's ECONNREFUSED at the start answers transient 08001, or is thrown scrubbed as 08001; fn never runs", async () => {
    const port = await closedPort();
    const secrets = probeSecrets("127.0.0.1", port);
    const url = probeUrl("127.0.0.1", port);
    // What postgres.js rejects the transaction's first statement with on such a client: its address and port on it.
    const raw = await onFreshClient(
      () => clientOn(url),
      (sql) => rejectionOf(sql`select 1`),
    );
    expect(raw).toMatchObject({ code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port });
    expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["host", "port"]));

    await expectStart(() => clientOn(url), { transient: NEVER_OPENED }, secrets);
    // Read only (the replica's transaction), the same.
    const readOnly = await onFreshClient(
      () => clientOn(url),
      (sql) => throughStart(sql, true, true),
    );
    expectOutcome(readOnly.settled, { transient: NEVER_OPENED }, true, CALL, secrets);
    expect(readOnly.runs).toBe(0);

    // db/repo/client.ts's own scoped transaction names no call: on its replica handle (read only) the start's failure is
    // thrown scrubbed under withBusiness's own name.
    const client = createClient({ primaryUrl: url, max: 1, env: {} });
    try {
      let runs = 0;
      const settled = await settle(
        client.withBusiness(
          BUSINESS,
          () => {
            runs += 1;
            return Promise.resolve("fn answered");
          },
          { on: "replica" },
        ),
      );
      expectOutcome(settled, { transient: NEVER_OPENED }, false, UNNAMED, secrets);
      expect(runs).toBe(0);
    } finally {
      await client.close();
    }
  });

  it.each(shapes)("$name", async ({ make, holds, expected }) => {
    await expectShapeRaised(make, holds);
    await expectStart(() => failingSocketClient(make()), expected, SHAPE_SECRETS);
  });

  it.each(refusals)(
    "a session PostgreSQL refuses at its start ($code, naming the $names) is thrown scrubbed to its SQLSTATE, transient answer or none",
    async ({ code, text, holds, secrets: more }) => {
      const server = await refusingServer(code, text);
      const secrets = { ...probeSecrets("127.0.0.1", server.port), ...more };
      try {
        const url = probeUrl("127.0.0.1", server.port);
        // What postgres.js rejects the transaction's first statement with: PostgreSQL's refusal, what it names in it.
        const raw = await onFreshClient(
          () => clientOn(url),
          (sql) => rejectionOf(sql`select 1`),
        );
        expect(raw).toMatchObject({ name: "PostgresError", code });
        expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining([...holds]));

        // Not transient (a retry cannot mend a refused login; 53300 is CQ-271's, scrubbed and not transient).
        await expectStart(() => clientOn(url), { thrown: "database", code }, secrets);
      } finally {
        await server.close();
      }
    },
  );

  it("a set_config refused with 57014, the business id on its statement, is thrown scrubbed to its SQLSTATE, transient answer or none, read only too; fn never runs", async () => {
    const server = await scopeRefusingServer();
    const secrets = { ...probeSecrets("127.0.0.1", server.port), ...secretsOf({ business: BUSINESS }) };
    try {
      const url = probeUrl("127.0.0.1", server.port);
      // What postgres.js rejects the start's set_config with, after the begin: its statement on it, the business id
      // among its values.
      const raw = await onFreshClient(
        () => clientOn(url),
        (sql) => rejectionOf(sql.begin((tx) => setBusinessScope(tx, BUSINESS))),
      );
      expect(raw).toMatchObject({ name: "PostgresError", code: "57014" });
      const statement = raw as { query?: unknown; parameters?: unknown; args?: unknown };
      expect(statement.query).toMatch(/set_config/);
      expect(statement.parameters).toContain(BUSINESS);
      expect(statement.args).toContain(BUSINESS);
      expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["business"]));

      // Not transient (57014 is no lost connection): thrown scrubbed, the caller's answer or not.
      await expectStart(() => clientOn(url), TIMED_OUT, secrets);
      // Read only (the replica's transaction), the same.
      for (const answers of [false, true]) {
        const readOnly = await onFreshClient(
          () => clientOn(url),
          (sql) => throughStart(sql, answers, true),
        );
        expectOutcome(readOnly.settled, TIMED_OUT, answers, CALL, secrets);
        expect(readOnly.runs).toBe(0);
      }
    } finally {
      await server.close();
    }
  });
});

describe("the turn face's three calls over pgCallScope, at the start of the Tool API's transaction (T-1331)", () => {
  it("a closed port: gateAndCommit, composeInput and finalizeMessage each throw it scrubbed as 08001", async () => {
    const port = await closedPort();
    const url = probeUrl("127.0.0.1", port);
    await expectCallScope(() => clientOn(url), { transient: NEVER_OPENED }, probeSecrets("127.0.0.1", port));
  });

  it.each(shapes)("$name: each of the three calls throws it scrubbed", async ({ make, expected }) => {
    await expectCallScope(() => failingSocketClient(make()), expected, SHAPE_SECRETS);
  });

  it.each(refusals)(
    "a session refused at its start ($code): each of the three calls throws it scrubbed to its SQLSTATE",
    async ({ code, text, secrets: more }) => {
      const server = await refusingServer(code, text);
      try {
        const url = probeUrl("127.0.0.1", server.port);
        const secrets = { ...probeSecrets("127.0.0.1", server.port), ...more };
        await expectCallScope(() => clientOn(url), { thrown: "database", code }, secrets);
      } finally {
        await server.close();
      }
    },
  );

  it("a set_config refused with 57014: each of the three calls throws it scrubbed to its SQLSTATE, naming no business", async () => {
    const server = await scopeRefusingServer();
    try {
      const url = probeUrl("127.0.0.1", server.port);
      // The business each call's request names, which its scope's set_config is sent with, and BUSINESS, pgCallScope's.
      const businessOf = (request: unknown): string =>
        (request as { caller: { businessId: string } }).caller.businessId;
      const businesses = secretsOf({
        business: BUSINESS,
        gateAndCommitBusiness: businessOf(commitRequestAfter(undefined)),
        composeInputBusiness: businessOf(
          (fixture("compose-input-s1-02.json") as { request: unknown }).request,
        ),
        finalizeMessageBusiness: businessOf((fixture("finalize-pass.json") as { request: unknown }).request),
      });
      const secrets = { ...probeSecrets("127.0.0.1", server.port), ...businesses };
      await expectCallScope(() => clientOn(url), TIMED_OUT, secrets);
    } finally {
      await server.close();
    }
  });
});

describe("withBusiness once fn has begun, on local PostgreSQL: as before (T-1331)", () => {
  it("fn's own error leaves as it is, fn runs once, and the same client still answers under the business", async () => {
    // The start only sets the scope on the local server (begin, set_config): no table is read or written.
    await onFreshClient(
      () => clientOn(resolvePrimaryUrl()),
      async (sql) => {
        const options = {
          call: CALL,
          transient: (answer: TransientError): string | null | TransientError => answer,
        };
        // fn's own error, with a SQLSTATE transientOrThrow answers transient (a serialization failure) and nothing of a
        // connection on it: after the start it is never taken for the start's, so it is neither answered nor scrubbed.
        const own = Object.assign(new Error("fn's own error"), { code: "40001" });
        let runs = 0;
        const thrown = await rejectionOf(
          withBusiness<string | null | TransientError>(
            sql,
            BUSINESS,
            () => {
              runs += 1;
              return Promise.reject(own);
            },
            options,
          ),
        );
        expect(thrown).toBe(own);
        expect(runs).toBe(1);

        // A callback that empties its scope is refused with BusinessScopeError, as it always was.
        const emptied = await rejectionOf(
          withBusiness<string | null | TransientError>(
            sql,
            BUSINESS,
            async (tx) => {
              await tx`select set_config(${SCOPE_SETTING}, '', true)`;
              return "read";
            },
            options,
          ),
        );
        expect(emptied).toBeInstanceOf(BusinessScopeError);

        // The same client answers: fn reads the business as its scope, and its answer is returned.
        await expect(
          withBusiness<string | null | TransientError>(sql, BUSINESS, (tx) => readBusinessScope(tx), options),
        ).resolves.toBe(BUSINESS);
      },
    );
  });
});
