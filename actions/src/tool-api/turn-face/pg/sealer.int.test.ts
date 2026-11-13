// T-1351 (T-1334's security review, new task b; DL-672): every error that leaves the safety record's read-only sealer
// (pg/sealer.ts pgReadOnlySealer) is scrubbed. Before it, the sealer let what its transaction threw leave as postgres.js
// raised it, and the Tool API base rethrows it (tool-api.ts): a lost connection at its sealing_keys read
// (db/repo/sealing.ts getSealingKeyInfo) left with the statement and the person id as its parameter, and a connect that
// failed with the host and the port. `npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/turn-face/pg/sealer`.
//
// Each failure is raised by postgres.js as installed (3.4.9) on a client made as the runtime client is made (rosie_job,
// one connection), at the sealer's seal of made-up words for a fiction person whose key exists:
//   - its socket cut at the sealing_keys read, which is never written: the socket is destroyed with an error built in the
//     shape postgres.js or Node gives it (the made-up host and port, or the made-up connection string, in it), or with
//     none, so postgres.js rejects the read with its own CONNECTION_CLOSED, naming the server's host and port. postgres.js
//     puts the read's statement and its parameter, the person id, on the error (connection.js queryError);
//   - PostgreSQL's own refusal of the read (22P02): the read's Parse goes out with its parameter cast to uuid, so
//     PostgreSQL refuses the person id at the read's Bind, naming it in its message, and postgres.js puts the read's
//     statement and the person id on the error. The connection stays open, and the transaction is rolled back on it;
//   - a connect that never opens, on a made-up user, password and database: a port nothing listens on (Node's
//     ECONNREFUSED, for real); a socket that fails before it opens with an error built in the shape postgres.js or Node
//     gives it, on a made-up host and port (postgres.js's own `socket` option); a local server that refuses the session
//     with PostgreSQL's own ErrorResponse (28P01), naming the user.
// For each, the raw error (what the sealer's transaction, inRuntimeTransaction, throws on the same failure, as the
// sealer let it leave before T-1351) holds what it names, so the check means something. The error that leaves the sealer
// holds none of the person id, the read's statement, the words, the host, the address, the port, the user, the password
// or the database in its message, stack or any other own property, by a deep walk: it carries the call's name (seal)
// and the code alone, PostgreSQL's as DataAccessDatabaseError.
//
// Rule 9: the people's ids, the words, the user, the password, the database, the host (.invalid, RFC 6761) and the
// address (RFC 5737's TEST-NET-3) are made up here. A check names what leaked, never its value.

import { once } from "node:events";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePrimaryUrl } from "../../../../../db/repo/client";
import { DataAccessDatabaseError } from "../../../../../db/repo/clocks";
import type { Sql } from "../../../../../db/repo/scope";
import { getSealingKeyInfo, seal, unsealText, type WrappingKeys } from "../../../../../db/repo/sealing";
import { inRuntimeTransaction } from "../../../../../db/repo/targets";
import { openCommitDatabase, RUNTIME_ROLE, type CommitDatabase } from "../../../commit/pg/test-support";
import { TurnFaceRefusedError } from "../errors";
import { pgReadOnlySealer } from "./sealer";

/** The sealer's call: the name every scrubbed error of it carries. */
const CALL = "seal";
/** A fiction person whose key exists, and the words sealed for them (made up here: no one's data). */
const PERSON = "person-t1351-fiction-wren";
const WORDS = "t1351 made-up words for the seal";
/** A fiction person with no key, whom the sealer refuses. */
const NO_KEY = "person-t1351-fiction-no-key";
const PROBE_USER = "t1351_probe_user";
const PROBE_PASSWORD = "t1351-probe-password";
const PROBE_DATABASE = "t1351_probe_db";
// The shapes' made-up connection: a host under .invalid (RFC 6761), RFC 5737's TEST-NET-3 address and a port.
const HOST = "db-t1351.example.invalid";
const ADDRESS = "203.0.113.51";
const PORT = 65151;

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test key). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

/** The sealing_keys read (db/repo/sealing.ts getSealingKeyInfo) as postgres.js builds its statement. */
const KEY_READ = /null::bytea as wrapped_key[\s\S]*from sealing_keys where person_id = \$1/;

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

/** What the seal names: the person id, the words, and the sealing_keys read's statement. */
const SEAL_SECRETS: Secrets = {
  ...secretsOf({ "person id": PERSON, words: WORDS }),
  statement: /from sealing_keys where person_id/,
};

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

// ---- the outcomes ---------------------------------------------------------------------------------------------------------

/** How a call ended: what it answered, or what it threw. */
type Settled = { answer: unknown } | { thrown: unknown };

const settle = (promise: Promise<unknown>): Promise<Settled> =>
  promise.then(
    (answer) => ({ answer }),
    (thrown: unknown) => ({ thrown }),
  );

/** What a call threw (it must have thrown). */
function thrownOf(settled: Settled): unknown {
  expect("thrown" in settled).toBe(true);
  return (settled as { thrown: unknown }).thrown;
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

/** The sealer's seal of the words for `personId` on `sql`. */
const sealOn = (sql: Sql, personId = PERSON): Promise<Settled> =>
  settle(pgReadOnlySealer(sql, KEYS).seal(WORDS, personId));

/**
 * What the sealer's transaction throws on `sql`, as the sealer let it leave before T-1351: inRuntimeTransaction, read
 * only, with the sealing_keys read for the person in it, as the sealer runs it.
 */
const rawOn = (sql: Sql): Promise<unknown> =>
  rejectionOf(inRuntimeTransaction(sql, { readOnly: true }, (tx) => getSealingKeyInfo(tx, PERSON)));

/** What leaves the sealer: a client's error as its code (null: no code), PostgreSQL's as its SQLSTATE. */
type Expected = { client: string | null } | { database: string };

/** The thrown error is scrubbed: the sealer's call's name and the code alone (db/repo/clocks.ts scrubbed). */
function expectScrubbed(thrown: unknown, expected: Expected): void {
  if ("database" in expected) {
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
    expect(thrown).toMatchObject({
      call: CALL,
      code: expected.database,
      table: null,
      constraint: null,
      message: `${CALL}: the database refused the call (SQLSTATE ${expected.database})`,
    });
    return;
  }
  // clocks.ts's scrubbed client error: a new Error, no message, stack, statement, cause or other property of the original's.
  const code = expected.client;
  expect(Object.getPrototypeOf(thrown)).toBe(Error.prototype);
  expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
  expect(thrown).toMatchObject({
    call: CALL,
    code,
    message: `${CALL}: the database call failed (${code === null ? "no code" : `code ${code}`})`,
  });
}

// ---- the errors in the shapes postgres.js and Node give them ----------------------------------------------------------

function probeUrl(host: string, port: number): string {
  return `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;
}

/** postgres.js's own connection error (errors.js connection, on its socket): "write <code> <host>:<port>". */
function connectionError(code: string): Error {
  const error = new Error(`write ${code} ${HOST}:${String(PORT)}`);
  return Object.assign(error, { code, errno: code, address: HOST, port: PORT });
}

/** Node's error for a connection the other end reset under a read: syscall read, and no address on it. */
function resetError(): Error {
  return Object.assign(new Error("read ECONNRESET"), { errno: -54, code: "ECONNRESET", syscall: "read" });
}

/** Node's error for a name its lookup could not resolve: syscall getaddrinfo and the host name. */
function lookupError(): Error {
  const error = new Error(`getaddrinfo ENOTFOUND ${HOST}`);
  return Object.assign(error, { errno: -3008, code: "ENOTFOUND", syscall: "getaddrinfo", hostname: HOST });
}

/**
 * A socket error with no code, as postgres.js's Workers build passes its socket's failure up (cf/polyfills.js), its
 * message naming the made-up connection string: the host, the port, the user, the password and the database.
 */
function codelessSocketError(): Error {
  return new Error(`the socket closed: ${probeUrl(HOST, PORT)}`);
}

// ---- the sealing_keys read on local PostgreSQL ------------------------------------------------------------------------

/** The local server (DATABASE_URL, else the local default): its connection string, host and port, never printed. */
function server(): { url: string; host: string; port: number } {
  const url = resolvePrimaryUrl();
  const { hostname, port } = new URL(url);
  return { url, host: hostname, port: port === "" ? 5432 : Number(port) };
}

/**
 * The server's host and port, which postgres.js's own CONNECTION_CLOSED names ("write CONNECTION_CLOSED <host>:<port>",
 * both on it). The local login, password and database are `rosie`, this repository's own folder, which every stack's
 * file paths name, so they are not listed: postgres.js's connection errors never carry them.
 */
function serverSecrets(): Secrets {
  const { host, port } = server();
  return secretsOf({ "server host": host, "server port": port });
}

/**
 * What happens at the sealing_keys read: its socket is cut before the read goes, destroyed with `cut` (Node hands it to
 * postgres.js as the socket's error, which rejects the read with it) or with none (postgres.js rejects the read with its
 * own CONNECTION_CLOSED); or the read goes with its parameter cast to uuid, which PostgreSQL refuses (castToUuid).
 */
type AtRead = { cut: Error | null } | "castToUuid";

interface ReadClient {
  readonly sql: Sql;
  /** Each statement's text as postgres.js built it, in order (its `debug` hook): never a value. */
  readonly sent: string[];
}

/**
 * The read's first message, its Parse ('P', its length, the statement's name and text each ending in a zero, then its
 * parameters' types), with its parameter cast to uuid and back: PostgreSQL then takes the person id as a uuid at the
 * read's Bind and refuses it (22P02), as it would refuse it for a uuid column. The messages after it go as they are.
 */
function castToUuid(chunk: string | Uint8Array): Uint8Array {
  if (typeof chunk === "string") throw new Error("the read's messages are not bytes");
  if (chunk[0] !== "P".charCodeAt(0)) throw new Error("the read's first message is not its Parse");
  const end = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(1) + 1;
  const nameEnd = chunk.indexOf(0, 5);
  const textEnd = chunk.indexOf(0, nameEnd + 1);
  const text = new TextDecoder().decode(chunk.subarray(nameEnd + 1, textEnd));
  const cast = text.replace("person_id = $1", "person_id = $1::uuid::text");
  if (cast === text) throw new Error("the read's statement names no person_id = $1");
  const castText = new TextEncoder().encode(`${cast}\u0000`);
  const name = chunk.subarray(5, nameEnd + 1);
  const types = chunk.subarray(textEnd + 1, end);
  const rest = chunk.subarray(end);
  const length = 4 + name.length + castText.length + types.length;
  const message = new Uint8Array(1 + length + rest.length);
  const view = new DataView(message.buffer);
  view.setUint8(0, "P".charCodeAt(0));
  view.setUint32(1, length);
  message.set(name, 5);
  message.set(castText, 5 + name.length);
  message.set(types, 5 + name.length + castText.length);
  message.set(rest, 1 + length);
  return message;
}

/**
 * A client on this file's schema as its runtime client is made (commit/pg/test-support.ts: rosie_job, the schema first),
 * one connection, through a socket to the same server (postgres.js's own `socket` option), at whose sealing_keys read
 * `atRead` happens; with none, every statement goes as it is.
 */
function readClient(schema: string, atRead: AtRead | null): ReadClient {
  const { url, host, port } = server();
  const sent: string[] = [];
  let atNext = false;
  const options = {
    max: 1,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1351-sealer",
      search_path: `${schema}, public`,
      role: RUNTIME_ROLE,
    },
    debug: (_connection: number, text: string) => {
      sent.push(text);
      if (atRead !== null && KEY_READ.test(text)) atNext = true;
    },
    socket: () => {
      const socket = createConnection(port, host);
      const write = socket.write.bind(socket);
      socket.write = ((...args: Parameters<typeof write>) => {
        if (!atNext || atRead === null) return write(...args);
        atNext = false;
        if (atRead === "castToUuid") {
          args[0] = castToUuid(args[0]);
          return write(...args);
        }
        socket.destroy(atRead.cut ?? undefined);
        return true;
      }) as typeof socket.write;
      return socket;
    },
  };
  return { sql: postgres(url, options), sent };
}

/** The ways the socket is cut at the read: each one's error (null: the socket just closes), its code, what it holds. */
const CUTS: {
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
  { name: "Node's ECONNRESET under the read", raw: resetError, code: "ECONNRESET", holds: [] },
  {
    name: "a socket error with no code (Workers), the made-up connection string in it",
    raw: codelessSocketError,
    code: null,
    holds: ["host", "port", "user", "password", "database"],
  },
];

describe("the read-only sealer at its sealing_keys read (T-1351; local PostgreSQL)", () => {
  let cdb: CommitDatabase;

  beforeAll(async () => {
    cdb = await openCommitDatabase("sealer_scrub", 1);
    await cdb.db.sql`insert into persons (id, name) values (${PERSON}, null), (${NO_KEY}, null)`;
    // The person's key, made by a first seal (T-182), so the read-only sealer finds one.
    await seal(cdb.runtime, KEYS, PERSON, "the key's first seal");
  }, 120_000);

  afterAll(async () => {
    await cdb.close();
  });

  /** The sealer's seal of the words for `personId` on a client at whose read `atRead` happens. */
  async function sealerRun(
    atRead: AtRead | null,
    personId = PERSON,
  ): Promise<{ settled: Settled; sent: string[] }> {
    const client = readClient(cdb.db.schema, atRead);
    try {
      return { settled: await sealOn(client.sql, personId), sent: client.sent };
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  }

  /** The raw error the same failure makes, unscrubbed, with the statements its client built. */
  async function rawRun(atRead: AtRead): Promise<{ raw: unknown; sent: string[] }> {
    const client = readClient(cdb.db.schema, atRead);
    try {
      return { raw: await rawOn(client.sql), sent: client.sent };
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  }

  it("with nothing failing, it seals the words under the person's key, and refuses a person with no key as it is", async () => {
    const sealed = await sealerRun(null);
    expect("answer" in sealed.settled).toBe(true);
    const bytes = (sealed.settled as { answer: Uint8Array }).answer;
    expect(await unsealText(cdb.runtime, KEYS, PERSON, bytes)).toBe(WORDS);
    // The read every failure below is placed at, then the seal's own read and the commit.
    expect(sealed.sent.filter((text) => KEY_READ.test(text))).toHaveLength(1);
    expect(sealed.sent.at(-1)).toBe("commit");

    // Its own refusal leaves as it is: a fixed message and its fault, nothing scrubbed away.
    const refused = await sealerRun(null, NO_KEY);
    const thrown = thrownOf(refused.settled);
    expect(thrown).toBeInstanceOf(TurnFaceRefusedError);
    expect(thrown).toMatchObject({ fault: "noSealingKey", message: "the turn face refuses: noSealingKey" });
    expect(refused.sent.at(-1)).toBe("rollback");
  });

  it.each(CUTS)(
    "its socket is cut at the read ($name): thrown with the call's name and the code alone, nothing sent after the read",
    async ({ raw, code, holds }) => {
      const secrets = { ...SEAL_SECRETS, ...SHAPE_SECRETS, ...serverSecrets() };
      // The raw error: postgres.js rejected the read with it, the read's statement and the person id put on it.
      const before = await rawRun({ cut: raw() });
      expect(KEY_READ.test(before.sent.at(-1) ?? "")).toBe(true);
      expect(Object.hasOwn(before.raw as object, "parameters")).toBe(true);
      expect(leaksOf(before.raw, secrets)).toEqual(
        expect.arrayContaining(["person id", "statement", ...holds]),
      );

      const run = await sealerRun({ cut: raw() });
      // A lost connection: no rollback and no commit are written to it.
      expect(KEY_READ.test(run.sent.at(-1) ?? "")).toBe(true);
      expect(leaksOf(run.settled, secrets)).toEqual([]);
      expectScrubbed(thrownOf(run.settled), { client: code });
    },
  );

  it("PostgreSQL refuses the read (22P02, the person id in its message): thrown as its SQLSTATE alone, the transaction rolled back", async () => {
    const secrets = { ...SEAL_SECRETS, ...serverSecrets() };
    // The raw error: PostgreSQL's own, the person id in its message; postgres.js put the read's statement and the
    // person id on it.
    const before = await rawRun("castToUuid");
    expect(before.raw).toMatchObject({ name: "PostgresError", code: "22P02" });
    expect(leaksOf((before.raw as Error).message, secrets)).toEqual(["person id"]);
    expect(leaksOf(before.raw, secrets)).toEqual(expect.arrayContaining(["person id", "statement"]));
    expect(before.sent.at(-1)).toBe("rollback");

    const run = await sealerRun("castToUuid");
    // The connection is open: the transaction is rolled back on it, right after the read.
    expect(run.sent.at(-1)).toBe("rollback");
    expect(KEY_READ.test(run.sent.at(-2) ?? "")).toBe(true);
    expect(leaksOf(run.settled, secrets)).toEqual([]);
    expectScrubbed(thrownOf(run.settled), { database: "22P02" });
  });
});

// ---- a connect that never opens ---------------------------------------------------------------------------------------

/** A client on `url` as the runtime client is made (rosie_job, one connection), its socket `socket` when given. */
function probeClient(url: string, socket?: () => Promise<Socket>): Sql {
  const options = {
    max: 1,
    onnotice: () => undefined,
    connection: { application_name: "rosie-t1351-sealer-probe", role: RUNTIME_ROLE },
    ...(socket === undefined ? {} : { socket }),
  };
  return postgres(url, options);
}

/** A client on the made-up connection whose socket fails with `raw` before it opens, as Node's socket would fail it. */
const failingClient = (raw: Error): Sql => probeClient(probeUrl(HOST, PORT), () => Promise.reject(raw));

/** A local port nothing listens on: one the system just handed out and took back. */
async function closedPort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;
  listener.close();
  await once(listener, "close");
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
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.end(errorResponse({ S: "FATAL", V: "FATAL", C: code, M: message }));
    });
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      listener.close();
      await once(listener, "close");
    },
  };
}

/** The seal on a client from `make` and the raw error on another, each ended after. */
async function connectRuns(make: () => Sql): Promise<{ raw: unknown; settled: Settled }> {
  const probe = make();
  let raw: unknown;
  try {
    raw = await rawOn(probe);
  } finally {
    await probe.end({ timeout: 0 });
  }
  const client = make();
  try {
    return { raw, settled: await sealOn(client) };
  } finally {
    await client.end({ timeout: 0 });
  }
}

describe("the read-only sealer on a connect that never opens (T-1351)", () => {
  it("a closed port: Node's ECONNREFUSED, the address and port on it, is thrown with its code alone", async () => {
    const port = await closedPort();
    const secrets = { ...SEAL_SECRETS, ...probeSecrets("127.0.0.1", port) };
    const { raw, settled } = await connectRuns(() => probeClient(probeUrl("127.0.0.1", port)));
    expect(raw).toMatchObject({ code: "ECONNREFUSED", syscall: "connect" });
    expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["host", "port"]));

    expect(leaksOf(settled, secrets)).toEqual([]);
    expectScrubbed(thrownOf(settled), { client: "ECONNREFUSED" });
  });

  const shapes: { name: string; make: () => Error; code: string; holds: readonly string[] }[] = [
    {
      name: "postgres.js's CONNECT_TIMEOUT, the made-up host and port on it",
      make: () => connectionError("CONNECT_TIMEOUT"),
      code: "CONNECT_TIMEOUT",
      holds: ["host", "port"],
    },
    {
      name: "Node's ENOTFOUND, the made-up host on it",
      make: lookupError,
      code: "ENOTFOUND",
      holds: ["host"],
    },
  ];

  it.each(shapes)("$name, is thrown with its code alone", async ({ make, code, holds }) => {
    const secrets = { ...SEAL_SECRETS, ...SHAPE_SECRETS };
    const { raw, settled } = await connectRuns(() => failingClient(make()));
    // postgres.js rejected the transaction's first statement with the socket's own error, the statement put on it.
    expect(raw).toMatchObject({ code });
    expect(Object.hasOwn(raw as object, "query")).toBe(true);
    expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining([...holds]));

    expect(leaksOf(settled, secrets)).toEqual([]);
    expectScrubbed(thrownOf(settled), { client: code });
  });

  it("a socket error with no code (Workers), the made-up host, port, user, password and database in it, is thrown with no code", async () => {
    const secrets = { ...SEAL_SECRETS, ...SHAPE_SECRETS };
    const { raw, settled } = await connectRuns(() => failingClient(codelessSocketError()));
    expect(Object.hasOwn(raw as object, "query")).toBe(true);
    expect(leaksOf(raw, secrets)).toEqual(
      expect.arrayContaining(["host", "port", "user", "password", "database"]),
    );

    expect(leaksOf(settled, secrets)).toEqual([]);
    expectScrubbed(thrownOf(settled), { client: null });
  });

  it("a session PostgreSQL refuses at its start (28P01, naming the user) is thrown as its SQLSTATE alone", async () => {
    const refusal = await refusingServer("28P01", `password authentication failed for user "${PROBE_USER}"`);
    try {
      const secrets = { ...SEAL_SECRETS, ...probeSecrets("127.0.0.1", refusal.port) };
      const { raw, settled } = await connectRuns(() => probeClient(probeUrl("127.0.0.1", refusal.port)));
      expect(raw).toMatchObject({ name: "PostgresError", code: "28P01" });
      expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["user"]));

      expect(leaksOf(settled, secrets)).toEqual([]);
      expectScrubbed(thrownOf(settled), { database: "28P01" });
    } finally {
      await refusal.close();
    }
  });
});
