// T-1268: db/repo's error helpers (targets.ts transientOrThrow; clocks.ts scrubbed and transientOrScrubbed) on a
// connection that never opened, connect-time failures included (T-1258's and T-1301's security reviews; ADR-014 section
// 2: never a connection string, a host, a user or a password). Two tests use local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/connect-failures`).
//
// Each failure that can be made locally is raised for real by postgres.js as installed (3.4.9): a port nothing listens
// on (ECONNREFUSED); a host under .invalid, which never resolves (RFC 6761: ENOTFOUND); RFC 5737's documentation
// address, which no network routes, with a 1 s connect timeout (CONNECT_TIMEOUT, or the network's own EHOSTUNREACH or
// ENETUNREACH); a local server that takes the connection and never answers its startup (postgres.js's own
// CONNECT_TIMEOUT, every time); a login the local database refuses (class 28, whose message names the user); and a
// connection lost under a statement with a parameter. The rest are built in the shapes postgres.js and Node give them
// (node_modules/postgres/src/errors.js; connection.js queryError, which puts the statement it rejects and its parameters
// on the error; Node's socket, name lookup and TLS errors). Each raw error is checked to hold what it names (a host, a
// port, the user, a parameter), so the check means something, and each outcome to hold none of it: neither the
// transient answer, nor the thrown error's message, stack or other own properties. Then K-05 calls of both helpers'
// kinds run on a client that never connects, each with its own fixture's request.
//
// Rule 9: the probe's user, password, database and hosts are made up here (.invalid names and documentation
// addresses), and its one number is a 555-01xx number. A check names what leaked, never its value, so a failing run
// prints no secret.
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { readHandle, readQuestionFacts } from "./arming-reads";
import { openChatOnText } from "./chat-open";
import { createClient, resolvePrimaryUrl } from "./client";
import {
  armClock,
  cancelClock,
  DataAccessDatabaseError,
  dueClocks,
  fireClock,
  scrubbed,
  transientOrScrubbed,
} from "./clocks";
import { handleSealingKey } from "./handle-keys";
import { parkTurn } from "./park";
import { BusinessScopeError, type Sql } from "./scope";
import { SealingError } from "./sealing";
import { sendState } from "./send-state";
import { handleTargets, type TransientError, transientOrThrow } from "./targets";
import { readPhoneState, readRosterPhone, readTesterStanding } from "./test-phone-reads";
import { BrokenRecordError } from "./turn-face-reads";
import { readTurnParty } from "./turn-party";
import { readTurnState } from "./turn-state";

const CALL = "probeCall";
const PROBE_USER = "t1268_probe_user";
const PROBE_PASSWORD = "t1268-probe-password";
const PROBE_DATABASE = "t1268_probe_db";
/** RFC 6761: no name under .invalid ever resolves. */
const UNRESOLVABLE_HOST = "rosie-t1268.invalid";
/** RFC 5737's TEST-NET-1: no network routes it, so a connect to it is dropped or refused as unreachable. */
const UNROUTED_HOST = "192.0.2.1";
const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };
const LOST: TransientError = { error: "transient", sqlstate: "08006" };
const FIXTURES = new URL("../../contracts/data-access/fixtures/", import.meta.url);

/** postgres.js's own PostgresError, which its type file gives no constructor of fields. */
interface WithPostgresError {
  PostgresError: new (fields: Record<string, unknown>) => Error;
}
const { PostgresError } = postgres as unknown as WithPostgresError;

// The shapes' made-up connection: a host, a documentation address (RFC 5737's TEST-NET-3), a port, and a statement
// with its one parameter.
const HOST = "db-t1268.example.invalid";
const ADDRESS = "203.0.113.7";
const PORT = 65123;
const NUMBER = "+15555550123";
const STATEMENT = "select kind, address from t1268_probe_handles where id = $1";
const BAD_PASSWORD = `password authentication failed for user "${PROBE_USER}"`;
const NO_HBA_ENTRY = `no pg_hba.conf entry for host "${ADDRESS}", user "${PROBE_USER}"`;
const SASL_MISMATCH = "The server did not return the correct signature";

// ---- what an outcome must never hold --------------------------------------------------------------------------------

type Secrets = Readonly<Record<string, RegExp>>;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeNumber = (value: number): RegExp => new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`);

/** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
  const secrets: Record<string, RegExp> = {};
  for (const [name, value] of Object.entries(values)) {
    secrets[name] = typeof value === "number" ? wholeNumber(value) : new RegExp(escaped(value));
  }
  return secrets;
}

/** The probe's own on a host and a port: the host, the port, the user, the password, the database and its value. */
function probeSecrets(host: string, port: number): Secrets {
  const connection = { host, port, user: PROBE_USER, password: PROBE_PASSWORD, database: PROBE_DATABASE };
  return secretsOf({ ...connection, number: NUMBER });
}

const SHAPE_SECRETS = secretsOf({
  host: HOST,
  address: ADDRESS,
  port: PORT,
  user: PROBE_USER,
  password: PROBE_PASSWORD,
  number: NUMBER,
  statement: "t1268_probe_handles",
});

/** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
function textsOf(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return [String(value)];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return [];
  }
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
  const leaks: string[] = [];
  for (const [name, secret] of Object.entries(secrets)) {
    if (texts.some((text) => secret.test(text))) {
      leaks.push(name);
    }
  }
  return leaks;
}

/** An own property's value, enumerable or not (postgres.js puts the statement on an error unenumerable). */
const ownValue = (value: unknown, key: string): unknown =>
  (Object.getOwnPropertyDescriptor(value, key) as { value?: unknown } | undefined)?.value;

// ---- raising and catching ---------------------------------------------------------------------------------------------

function probeUrl(host: string, port: number): string {
  return `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;
}

/** The error postgres.js rejects a client's first statement (one value) with, on a connection that never opens. */
async function failureOf(url: string, connectTimeoutSeconds = 2): Promise<unknown> {
  const sql = postgres(url, { max: 1, connect_timeout: connectTimeoutSeconds, onnotice: () => undefined });
  try {
    await sql`select ${NUMBER}::text as probe`;
  } catch (error) {
    return error;
  } finally {
    await sql.end({ timeout: 0 });
  }
  throw new Error("the probe's first statement was answered");
}

/** What `run` throws (it must throw). */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
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

/** A local server that takes each connection and never answers it, as a host gone silent would. */
async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, "close");
    },
  };
}

/** Waits, about 5 s at most, until the backend `pid` runs a statement. */
async function waitUntilActive(admin: Sql, pid: number): Promise<void> {
  for (let tries = 0; tries < 100; tries += 1) {
    const rows = await admin`select 1 from pg_stat_activity where pid = ${pid} and state = 'active'`;
    if (rows.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("the statement never started");
}

/** Both helpers answer 08001 for `raw`, which holds `holds`; the answer holds none of the secrets. */
function expectNeverOpened(raw: unknown, secrets: Secrets, holds: readonly string[]): void {
  expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining([...holds]));
  expect(transientOrThrow(raw)).toEqual(NEVER_OPENED);
  const answer = transientOrScrubbed(CALL, raw);
  expect(answer).toEqual(NEVER_OPENED);
  expect(leaksOf(answer, secrets)).toEqual([]);
}

/**
 * postgres.js put the statement it rejected on `raw` though the connection never opened: no text, since it never built
 * it, but its values as given (args), the probe's number among them.
 */
function expectUnbuiltStatementOn(raw: unknown): void {
  expect(Object.hasOwn(raw as object, "query")).toBe(true);
  expect(ownValue(raw, "query")).toBeUndefined();
  expect(ownValue(raw, "args")).toEqual([NUMBER]);
}

// ---- the errors in postgres.js's and Node's shapes ----------------------------------------------------------------

/** As postgres.js's queryError puts the statement it rejects on its error: unenumerable, unless its debug is on. */
function rejecting<T extends Error>(error: T, debug = false): T {
  return Object.defineProperties(error, {
    stack: { value: `${String(error.stack)}\n    at probe (${STATEMENT})`, enumerable: debug },
    query: { value: STATEMENT, enumerable: debug },
    parameters: { value: [NUMBER], enumerable: debug },
    args: { value: [NUMBER], enumerable: debug },
    types: { value: [25], enumerable: debug },
  });
}

/** PostgreSQL's error as postgres.js raises it (a PostgresError of its fields), on the statement it rejects. */
function refusal(fields: Record<string, unknown>): Error {
  return rejecting(new PostgresError({ severity: "FATAL", ...fields }));
}

/** postgres.js's own connection error (errors.js connection, on its socket): "write <code> <host>:<port>". */
function clientError(code: string): Error {
  const error = new Error(`write ${code} ${HOST}:${String(PORT)}`);
  return Object.assign(error, { code, errno: code, address: HOST, port: PORT });
}

/** The same from its pool, with no socket: the host and port as its options' lists hold them. */
function poolError(code: string): Error {
  const error = new Error(`write ${code} ${HOST}:${String(PORT)}`);
  return Object.assign(error, { code, errno: code, address: [HOST], port: [PORT] });
}

/** Node's error for a connect its socket could not make: syscall connect, the address and the port. */
function connectError(code: string, errno: number): Error {
  const error = new Error(`connect ${code} ${ADDRESS}:${String(PORT)}`);
  return Object.assign(error, { errno, code, syscall: "connect", address: ADDRESS, port: PORT });
}

/** Node's error for a name its lookup could not resolve: syscall getaddrinfo and the hostname. */
function lookupError(code: string, errno: number): Error {
  const error = new Error(`getaddrinfo ${code} ${HOST}`);
  return Object.assign(error, { errno, code, syscall: "getaddrinfo", hostname: HOST });
}

/** Node's error on a socket that was open (read or write). */
function socketError(code: string, syscall: string, errno: number): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { errno, code, syscall });
}

/** postgres.js's generic error (errors.js generic): "<code>: <text>". */
function genericError(code: string, text: string): Error {
  return Object.assign(new Error(`${code}: ${text}`), { code });
}

/** A socket's error whose code is a number, not a name (as a DOMException's is). */
function numberCodedError(): Error {
  return Object.assign(new Error(`connect to ${ADDRESS} failed`), { name: "NetworkError", code: 19 });
}

/** Node's error when every address of a name refused: one error for each address, the first one's code. */
function everyAddressRefused(): Error {
  const errors = [connectError("ECONNREFUSED", -61), connectError("ECONNREFUSED", -61)];
  return Object.assign(new AggregateError(errors, ""), { code: "ECONNREFUSED" });
}

/** Node's TLS name check: the host and the certificate on the error. */
function tlsNameError(): Error {
  const reason = `Host: ${HOST}. is not in the cert's altnames: DNS:other.example.invalid`;
  const error = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`);
  const cert = { subject: { CN: "other.example.invalid" }, subjectaltname: "DNS:other.example.invalid" };
  return Object.assign(error, { code: "ERR_TLS_CERT_ALTNAME_INVALID", reason, host: HOST, cert });
}

type Expected =
  | { answer: TransientError }
  | { thrown: "client"; code: string | null }
  | { thrown: "database"; code: string }
  | { thrown: "own" };

interface Shape {
  name: string;
  make: () => Error;
  /** The secrets the error itself holds, so the check means something. */
  holds: readonly string[];
  expected: Expected;
}

const SHAPES: Shape[] = [
  // A connection that never opened: 08001 (T-1268).
  {
    name: "postgres.js's CONNECT_TIMEOUT answers transient 08001",
    make: () => rejecting(clientError("CONNECT_TIMEOUT")),
    holds: ["host", "port", "number", "statement"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's ECONNREFUSED answers transient 08001",
    make: () => rejecting(connectError("ECONNREFUSED", -61)),
    holds: ["address", "port", "number", "statement"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's EHOSTUNREACH answers transient 08001",
    make: () => rejecting(connectError("EHOSTUNREACH", -65)),
    holds: ["address", "port"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's ENETUNREACH answers transient 08001",
    make: () => rejecting(connectError("ENETUNREACH", -51)),
    holds: ["address", "port"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's EHOSTDOWN answers transient 08001",
    make: () => rejecting(connectError("EHOSTDOWN", -64)),
    holds: ["address", "port"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's ENETDOWN answers transient 08001",
    make: () => rejecting(connectError("ENETDOWN", -50)),
    holds: ["address", "port"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's EADDRNOTAVAIL answers transient 08001",
    make: () => rejecting(connectError("EADDRNOTAVAIL", -49)),
    holds: ["address", "port"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's ENOTFOUND answers transient 08001",
    make: () => rejecting(lookupError("ENOTFOUND", -3008)),
    holds: ["host", "number", "statement"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's EAI_AGAIN answers transient 08001",
    make: () => rejecting(lookupError("EAI_AGAIN", -3001)),
    holds: ["host"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's EAI_FAIL answers transient 08001",
    make: () => rejecting(lookupError("EAI_FAIL", -3004)),
    holds: ["host"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "Node's AggregateError when every address of a name refused answers transient 08001",
    make: () => rejecting(everyAddressRefused()),
    holds: ["address", "port"],
    expected: { answer: NEVER_OPENED },
  },
  {
    name: "ECONNREFUSED on no statement (a reserve() that never connected) answers transient 08001",
    make: () => connectError("ECONNREFUSED", -61),
    holds: ["address", "port"],
    expected: { answer: NEVER_OPENED },
  },
  // A lost connection: 08006, as listed before T-1268.
  {
    name: "postgres.js's CONNECTION_CLOSED answers transient 08006",
    make: () => rejecting(clientError("CONNECTION_CLOSED")),
    holds: ["host", "port", "number", "statement"],
    expected: { answer: LOST },
  },
  {
    name: "postgres.js's CONNECTION_DESTROYED from its pool answers transient 08006",
    make: () => poolError("CONNECTION_DESTROYED"),
    holds: ["host", "port"],
    expected: { answer: LOST },
  },
  {
    name: "postgres.js's CONNECTION_ENDED from its pool answers transient 08006",
    make: () => poolError("CONNECTION_ENDED"),
    holds: ["host", "port"],
    expected: { answer: LOST },
  },
  {
    name: "Node's ECONNRESET answers transient 08006",
    make: () => rejecting(socketError("ECONNRESET", "read", -54)),
    holds: ["number", "statement"],
    expected: { answer: LOST },
  },
  {
    name: "Node's EPIPE answers transient 08006",
    make: () => rejecting(socketError("EPIPE", "write", -32)),
    holds: ["number", "statement"],
    expected: { answer: LOST },
  },
  {
    name: "Node's ETIMEDOUT answers transient 08006",
    make: () => rejecting(socketError("ETIMEDOUT", "read", -60)),
    holds: ["number", "statement"],
    expected: { answer: LOST },
  },
  {
    name: "a socket error with no code (postgres.js's Workers build) answers transient 08006",
    make: () => rejecting(new Error(`Network connection lost to ${HOST}:${String(PORT)}`)),
    holds: ["host", "port", "number", "statement"],
    expected: { answer: LOST },
  },
  {
    name: "a socket error with no code under postgres.js's debug (its statement enumerable) answers 08006",
    make: () => rejecting(new Error(`Network connection lost to ${HOST}:${String(PORT)}`), true),
    holds: ["host", "port", "number", "statement"],
    expected: { answer: LOST },
  },
  {
    name: "a socket error whose code is a number, not a name, answers transient 08006",
    make: () => rejecting(numberCodedError()),
    holds: ["address", "number", "statement"],
    expected: { answer: LOST },
  },
  {
    name: "PostgreSQL's 57P01 (its backend terminated) answers transient 57P01",
    make: () => refusal({ code: "57P01", message: "terminating connection due to administrator command" }),
    holds: ["number", "statement"],
    expected: { answer: { error: "transient", sqlstate: "57P01" } },
  },
  // Thrown: transientOrThrow throws the error itself; transientOrScrubbed a new Error with the call and the code alone.
  {
    name: "Node's TLS name check (its host and certificate on it) is thrown scrubbed",
    make: () => rejecting(tlsNameError()),
    holds: ["host", "number", "statement"],
    expected: { thrown: "client", code: "ERR_TLS_CERT_ALTNAME_INVALID" },
  },
  {
    name: "Node's TLS name check on no statement is thrown scrubbed",
    make: () => tlsNameError(),
    holds: ["host"],
    expected: { thrown: "client", code: "ERR_TLS_CERT_ALTNAME_INVALID" },
  },
  {
    name: "Node's EACCES (a connect the system did not permit) on no statement is thrown scrubbed",
    make: () => connectError("EACCES", -13),
    holds: ["address", "port"],
    expected: { thrown: "client", code: "EACCES" },
  },
  {
    name: "postgres.js's UNDEFINED_VALUE, its parameters on it, is thrown scrubbed",
    make: () => rejecting(genericError("UNDEFINED_VALUE", "Undefined values are not allowed")),
    holds: ["number", "statement"],
    expected: { thrown: "client", code: "UNDEFINED_VALUE" },
  },
  {
    name: "postgres.js's SASL_SIGNATURE_MISMATCH is thrown scrubbed",
    make: () => rejecting(genericError("SASL_SIGNATURE_MISMATCH", SASL_MISMATCH)),
    holds: ["number", "statement"],
    expected: { thrown: "client", code: "SASL_SIGNATURE_MISMATCH" },
  },
  {
    name: "a TypeError postgres.js rejects a statement with (a value it cannot send) is thrown scrubbed",
    make: () => rejecting(new TypeError("Do not know how to serialize a BigInt")),
    holds: ["number", "statement"],
    expected: { thrown: "client", code: null },
  },
  {
    name: "the same under postgres.js's debug is thrown scrubbed",
    make: () => rejecting(new TypeError("Do not know how to serialize a BigInt"), true),
    holds: ["number", "statement"],
    expected: { thrown: "client", code: null },
  },
  {
    name: "a PostgresError with no SQLSTATE, naming the user, is thrown scrubbed",
    make: () => refusal({ message: BAD_PASSWORD }),
    holds: ["user", "number", "statement"],
    expected: { thrown: "client", code: null },
  },
  // Thrown as DataAccessDatabaseError: PostgreSQL's refusal, its SQLSTATE alone.
  {
    name: "PostgreSQL's 28P01, naming the user, is thrown as DataAccessDatabaseError",
    make: () => refusal({ code: "28P01", message: BAD_PASSWORD }),
    holds: ["user", "number", "statement"],
    expected: { thrown: "database", code: "28P01" },
  },
  {
    name: "PostgreSQL's 28000, naming the address and the user, is thrown as DataAccessDatabaseError",
    make: () => refusal({ code: "28000", message: NO_HBA_ENTRY }),
    holds: ["address", "user"],
    expected: { thrown: "database", code: "28000" },
  },
  // db/repo's own errors: thrown as they are, by both helpers.
  {
    name: "db/repo's TypeError for a request it cannot carry out is thrown as it is",
    make: () => new TypeError("armClock: deliveredAt is not an instant in UTC ending in Z"),
    holds: [],
    expected: { thrown: "own" },
  },
  {
    name: "db/repo's Error for a row that moved is thrown as it is",
    make: () => new Error("fireClock: the clock row moved while it was locked"),
    holds: [],
    expected: { thrown: "own" },
  },
  {
    name: "SealingError, whose code is db/repo's own, is thrown as it is",
    make: () => new SealingError("wrapping_key_missing"),
    holds: [],
    expected: { thrown: "own" },
  },
  {
    name: "DataAccessDatabaseError, already scrubbed, is thrown as it is",
    make: () => new DataAccessDatabaseError("armClock", "23505", "clock_rows", "clock_rows_pkey"),
    holds: [],
    expected: { thrown: "own" },
  },
  {
    name: "BusinessScopeError is thrown as it is",
    make: () => new BusinessScopeError("a Tool API call needs a business scope"),
    holds: [],
    expected: { thrown: "own" },
  },
  {
    name: "BrokenRecordError is thrown as it is",
    make: () => new BrokenRecordError("readPhoneState: a stopped phone row holds no STOP time"),
    holds: [],
    expected: { thrown: "own" },
  },
];

// ---- K-05 calls of both helpers' kinds --------------------------------------------------------------------------------

type Run = (sql: Sql) => Promise<unknown>;

const requestOf = (file: string): unknown =>
  (JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as { request: unknown }).request;

/** A K-05 call with its own fixture's request (the fixture is the call's contract, so the request is its type). */
function fixtureCall(call: (sql: Sql, request: never) => Promise<unknown>, file: string): Run {
  return (sql) => call(sql, requestOf(file) as never);
}

/** handleSealingKey's resolver, never reached: the call fails at its transaction's first statement. */
const NO_KEYS = { resolve: (): undefined => undefined };
const sealingKeyCall: Run = (sql) =>
  handleSealingKey(sql, NO_KEYS, requestOf("handle-key-existing.json") as never);

const CALLS: [string, Run, unknown][] = [
  // transientOrThrow's own callers.
  ["handleTargets", fixtureCall(handleTargets, "targets-alex.json"), NEVER_OPENED],
  ["sendState", fixtureCall(sendState, "send-state-no-chat.json"), NEVER_OPENED],
  ["handleSealingKey", sealingKeyCall, { outcome: NEVER_OPENED, dataKey: null }],
  ["readTurnState", fixtureCall(readTurnState, "read-turn-state-alex.json"), NEVER_OPENED],
  ["openChatOnText", fixtureCall(openChatOnText, "open-chat-first-text-sam.json"), NEVER_OPENED],
  // transientOrScrubbed's.
  ["armClock", fixtureCall(armClock, "arm-clock.json"), NEVER_OPENED],
  ["cancelClock", fixtureCall(cancelClock, "cancel-clock.json"), NEVER_OPENED],
  ["dueClocks for a handle", fixtureCall(dueClocks, "due-for-handle.json"), NEVER_OPENED],
  ["dueClocks for the sweep", fixtureCall(dueClocks, "due-for-sweep.json"), NEVER_OPENED],
  ["fireClock", fixtureCall(fireClock, "fire-once.json"), NEVER_OPENED],
  ["parkTurn", fixtureCall(parkTurn, "park-turn.json"), NEVER_OPENED],
  ["readQuestionFacts", fixtureCall(readQuestionFacts, "read-question-facts-s1-02.json"), NEVER_OPENED],
  ["readHandle", fixtureCall(readHandle, "read-handle-sam.json"), NEVER_OPENED],
  [
    "readTesterStanding",
    fixtureCall(readTesterStanding, "read-tester-standing-check-tester.json"),
    NEVER_OPENED,
  ],
  ["readRosterPhone", fixtureCall(readRosterPhone, "read-roster-phone-tp-01.json"), NEVER_OPENED],
  ["readPhoneState", fixtureCall(readPhoneState, "read-phone-state-chat-open.json"), NEVER_OPENED],
  ["readTurnParty", fixtureCall(readTurnParty, "read-turn-party-unknown.json"), NEVER_OPENED],
];

// ---- the tests ----------------------------------------------------------------------------------------------------------

describe("a connection that never opens, as postgres.js raises it (T-1268)", () => {
  it("a closed port: ECONNREFUSED answers transient 08001, holding none of the connection", async () => {
    const port = await closedPort();
    const raw = await failureOf(probeUrl("127.0.0.1", port));
    expect(raw).toMatchObject({ code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port });
    expectUnbuiltStatementOn(raw);
    expectNeverOpened(raw, probeSecrets("127.0.0.1", port), ["host", "port", "number"]);
  });

  it("an unresolvable .invalid host: ENOTFOUND answers transient 08001, holding none of it", async () => {
    const raw = await failureOf(probeUrl(UNRESOLVABLE_HOST, PORT));
    expect(raw).toMatchObject({ syscall: "getaddrinfo", hostname: UNRESOLVABLE_HOST });
    // A resolver that cannot be asked at all answers EAI_AGAIN for the same name: the same answer.
    expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(ownValue(raw, "code"));
    expectUnbuiltStatementOn(raw);
    expectNeverOpened(raw, probeSecrets(UNRESOLVABLE_HOST, PORT), ["host", "number"]);
  });

  it("a non-routable address with a 1 s timeout: CONNECT_TIMEOUT answers transient 08001", async () => {
    const raw = await failureOf(probeUrl(UNROUTED_HOST, PORT), 1);
    // A network with no route at all refuses at once (EHOSTUNREACH or ENETUNREACH): the same answer.
    expect(["CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"]).toContain(ownValue(raw, "code"));
    expect(raw).toMatchObject({ address: UNROUTED_HOST, port: PORT });
    expectUnbuiltStatementOn(raw);
    expectNeverOpened(raw, probeSecrets(UNROUTED_HOST, PORT), ["host", "port", "number"]);
  });

  it("a silent server: postgres.js's own CONNECT_TIMEOUT answers transient 08001", async () => {
    const server = await silentServer();
    try {
      const raw = await failureOf(probeUrl("127.0.0.1", server.port), 1);
      expect(raw).toMatchObject({ code: "CONNECT_TIMEOUT", errno: "CONNECT_TIMEOUT", address: "127.0.0.1" });
      expect((raw as Error).message).toBe(`write CONNECT_TIMEOUT 127.0.0.1:${String(server.port)}`);
      expectUnbuiltStatementOn(raw);
      expectNeverOpened(raw, probeSecrets("127.0.0.1", server.port), ["host", "port", "number"]);
    } finally {
      await server.close();
    }
  });

  it("a refused login: class 28 names the user, and is thrown scrubbed to its SQLSTATE", async () => {
    const url = new URL(resolvePrimaryUrl());
    url.username = PROBE_USER;
    url.password = PROBE_PASSWORD;
    const port = url.port === "" ? 5432 : Number(url.port);
    const secrets = secretsOf({
      host: url.hostname,
      port,
      user: PROBE_USER,
      password: PROBE_PASSWORD,
      number: NUMBER,
    });
    const raw = await failureOf(url.toString());
    expect(raw).toMatchObject({ name: "PostgresError" });
    const code = ownValue(raw, "code");
    expect(["28P01", "28000"]).toContain(code);
    expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["user", "number"]));
    // Not transient: a retry cannot mend a refused login. transientOrThrow throws it as it is (its callers' rule).
    expect(thrownBy(() => transientOrThrow(raw))).toBe(raw);
    const thrown = thrownBy(() => transientOrScrubbed(CALL, raw));
    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: CALL, code, table: null, constraint: null });
    expect(leaksOf(thrown, secrets)).toEqual([]);

    // The same through a K-05 read: readHandle throws it scrubbed, under its own name.
    const client = createClient({ primaryUrl: url.toString(), max: 1, env: {} });
    try {
      const rejected = await rejectionOf(fixtureCall(readHandle, "read-handle-sam.json")(client.primary));
      expect(rejected).toBeInstanceOf(DataAccessDatabaseError);
      expect(rejected).toMatchObject({ call: "readHandle", code });
      expect(leaksOf(rejected, secrets)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("a lost connection: the error holds the statement's parameter, the transient answer none", async () => {
    const url = resolvePrimaryUrl();
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    const admin = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (backend === undefined) {
        throw new Error("pg_backend_pid() returned no row");
      }
      const statement = rejectionOf(sql`select pg_sleep(30), ${NUMBER}::text as number`);
      await waitUntilActive(admin, backend.pid);
      await admin`select pg_terminate_backend(${backend.pid})`;
      const raw = await statement;
      expect(["CONNECTION_CLOSED", "57P01"]).toContain(ownValue(raw, "code"));
      expect(ownValue(raw, "parameters")).toEqual([NUMBER]);
      const secrets = secretsOf({ number: NUMBER, statement: "pg_sleep" });
      expect(leaksOf(raw, secrets)).toEqual(["number", "statement"]);
      const answer = transientOrScrubbed(CALL, raw);
      expect(answer.error).toBe("transient");
      expect(leaksOf(answer, secrets)).toEqual([]);
    } finally {
      await sql.end({ timeout: 0 });
      await admin.end({ timeout: 5 });
    }
  });
});

describe("errors in the shapes postgres.js and Node give them (T-1268)", () => {
  it.each(SHAPES)("$name", ({ make, holds, expected }) => {
    const raw = make();
    expect(leaksOf(raw, SHAPE_SECRETS)).toEqual(expect.arrayContaining([...holds]));
    if ("answer" in expected) {
      expect(transientOrThrow(raw)).toEqual(expected.answer);
      const answer = transientOrScrubbed(CALL, raw);
      expect(answer).toEqual(expected.answer);
      expect(leaksOf(answer, SHAPE_SECRETS)).toEqual([]);
      return;
    }
    expect(thrownBy(() => transientOrThrow(raw))).toBe(raw);
    const thrown = thrownBy(() => transientOrScrubbed(CALL, raw));
    if (expected.thrown === "own") {
      expect(thrown).toBe(raw);
      expect(scrubbed(CALL, raw)).toBe(raw);
      return;
    }
    expect(thrown).not.toBe(raw);
    expect(leaksOf(thrown, SHAPE_SECRETS)).toEqual([]);
    if (expected.thrown === "database") {
      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(thrown).toMatchObject({ call: CALL, code: expected.code, table: null, constraint: null });
      return;
    }
    // The call's name and the code alone: no message, stack, statement, cause or other property of the original's.
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
    const shown = expected.code === null ? "no code" : `code ${expected.code}`;
    expect(thrown).toMatchObject({ call: CALL, code: expected.code });
    expect((thrown as Error).message).toBe(`${CALL}: the database call failed (${shown})`);
    expect(scrubbed(CALL, raw)).toMatchObject({ call: CALL, code: expected.code });
  });
});

describe("K-05 calls of both helpers' kinds on a client that never connects (T-1268)", () => {
  it.each(CALLS)("%s answers 08001 on a closed port, holding none of it", async (_name, run, expected) => {
    const port = await closedPort();
    const client = createClient({ primaryUrl: probeUrl("127.0.0.1", port), max: 1, env: {} });
    try {
      const outcome = await run(client.primary);
      expect(outcome).toEqual(expected);
      expect(leaksOf(outcome, probeSecrets("127.0.0.1", port))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("for an unresolvable host and a silent server, two calls answer transient 08001", async () => {
    const server = await silentServer();
    try {
      const failures: [string, Secrets][] = [
        [probeUrl(UNRESOLVABLE_HOST, PORT), probeSecrets(UNRESOLVABLE_HOST, PORT)],
        [probeUrl("127.0.0.1", server.port), probeSecrets("127.0.0.1", server.port)],
      ];
      const runs = [
        fixtureCall(handleTargets, "targets-alex.json"),
        fixtureCall(readHandle, "read-handle-sam.json"),
      ];
      for (const [url, secrets] of failures) {
        for (const run of runs) {
          const client = createClient({ primaryUrl: url, max: 1, connectTimeoutSeconds: 1, env: {} });
          try {
            const outcome = await run(client.primary);
            expect(outcome).toEqual(NEVER_OPENED);
            expect(leaksOf(outcome, secrets)).toEqual([]);
          } finally {
            await client.close();
          }
        }
      }
    } finally {
      await server.close();
    }
  });
});
