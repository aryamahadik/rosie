// T-1179: compiler publish builds its database client inside its try, so a caller that runs publish.run directly (as
// infra/scripts/publish-bundle.sh does), not through the CLI's catch, never gets an error that holds the database URL.
// postgres.js parses each URL when the client is built (node_modules/postgres/src/index.js:50 and :545), and Node's
// ERR_INVALID_URL keeps the whole string in its `input` property, which Node prints for an error that is not caught.
// Every URL here is made up and set through the environment the client reads (DATABASE_URL, DATABASE_REPLICA_URL): its
// user, password, host and database are *_t1179 names on .invalid hosts, never a real key. A URL that does not parse
// means no client is built and no database is reached, so the one thing a publish could write is the KV bulk file.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../../../db/repo/client";
import { buildNumberedBundle } from "../../bundle-id";
import { writeBundle } from "../../emit";
import { readPublishable, type PublishableBundle } from "../../publish";
import { main, type CliIo } from "../index";
import { command as publish } from "./publish";

const USER = "publish_owner_t1179";
const PASSWORD_HEAD = "s3cret_t1179";
const PASSWORD_TAIL = "tail_t1179";
const HOST = "db-t1179.example.invalid";
const DATABASE = "t1179_publish_db";
const REPLICA_USER = "replica_reader_t1179";
const REPLICA_HOST = "replica-t1179.example.invalid";

/** The password with an unencoded `#`: `new URL` ends the address at the `#`, so the URL does not parse. */
const HASH_PASSWORD = `${PASSWORD_HEAD}#${PASSWORD_TAIL}`;

/** A URL on the made-up database whose password is `password`, as written. */
const urlWith = (password: string, user = USER, host = HOST): string =>
  `postgres://${user}:${password}@${host}:5432/${DATABASE}`;

/** Every part of the made-up URLs that the error may not hold: each whole password, its pieces, users, hosts, database. */
const URL_PARTS = [
  HASH_PASSWORD,
  PASSWORD_HEAD,
  PASSWORD_TAIL,
  USER,
  HOST,
  DATABASE,
  REPLICA_USER,
  REPLICA_HOST,
];

const REFUSAL = "refused: DATABASE_URL does not parse as a URL; nothing was read or written";

const made: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `publish-command-${label}-`));
  made.push(dir);
  return dir;
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

/** What `call` throws. The test fails when it returns instead. */
async function thrownBy(call: () => number | Promise<number>): Promise<unknown> {
  let code: number;
  try {
    code = await call();
  } catch (error) {
    return error;
  }
  throw new Error(`publish.run returned ${String(code)}: it was expected to throw`);
}

/** What the error shows: as Node prints an error not caught (util.inspect), as text, and each own property's value. */
function shown(error: Error): string[] {
  const full = (value: unknown): string =>
    typeof value === "string" ? value : inspect(value, { showHidden: true, depth: null });
  return [
    full(error),
    String(error),
    error.message,
    ...Reflect.ownKeys(error).map((key) => full(Reflect.get(error, key))),
  ];
}

/** The error holds no part of either URL, has no `input` and no cause, and is the refusal `message`. */
function expectRefusal(thrown: unknown, message: string): void {
  expect(thrown).toBeInstanceOf(Error);
  const error = thrown as Error;
  for (const text of shown(error)) for (const part of URL_PARTS) expect(text).not.toContain(part);
  expect(Object.hasOwn(error, "input")).toBe(false);
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expect(error.name).toBe("DatabaseUrlError");
  expect(error.message).toBe(message);
}

let dir: string;
let bundle: PublishableBundle;

beforeAll(async () => {
  const built = await buildNumberedBundle({ trades: ["barber"], build: 5, builtAt: "2026-11-10T00:00:00Z" });
  dir = join(tempDir("bundle"), "bundle");
  writeBundle(dir, built.files);
  bundle = readPublishable(dir);
});

afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

beforeEach(() => {
  // Only the URL each test sets is read: no replica and no schema from the shell running the tests.
  vi.stubEnv("DATABASE_REPLICA_URL", "");
  vi.stubEnv("DB_SCHEMA", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publish.run called directly, with a database URL that does not parse (T-1179)", () => {
  it.each([
    ["a password with an unencoded # (Node's ERR_INVALID_URL)", urlWith(HASH_PASSWORD)],
    ["a password with an unencoded / (Node's ERR_INVALID_URL)", urlWith(`${PASSWORD_HEAD}/${PASSWORD_TAIL}`)],
    ["a password with a bad % escape (a URIError)", urlWith(`${PASSWORD_HEAD}%zz${PASSWORD_TAIL}`)],
  ])("DATABASE_URL with %s: throws an error holding no part of the URL; writes nothing", async (_, url) => {
    vi.stubEnv("DATABASE_URL", url);
    const kv = join(tempDir("kv"), "bundle.kv.json");
    const run = capture();

    expectRefusal(await thrownBy(() => publish.run([dir, "--kv", kv], run.io)), REFUSAL);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([]);
    expect(existsSync(kv)).toBe(false);
    expect(readPublishable(dir).parts).toEqual(bundle.parts);
  });

  it("DATABASE_REPLICA_URL with a password with an unencoded #: the same, holding no part of either URL", async () => {
    vi.stubEnv("DATABASE_URL", urlWith(PASSWORD_HEAD));
    vi.stubEnv("DATABASE_REPLICA_URL", urlWith(HASH_PASSWORD, REPLICA_USER, REPLICA_HOST));
    const kv = join(tempDir("kv"), "bundle.kv.json");
    const run = capture();

    expectRefusal(
      await thrownBy(() => publish.run([dir, "--kv", kv], run.io)),
      "refused: DATABASE_URL or DATABASE_REPLICA_URL does not parse as a URL; nothing was read or written",
    );
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([]);
    expect(existsSync(kv)).toBe(false);
  });

  it("through the CLI: exit 1, and its one error line is the refusal", async () => {
    vi.stubEnv("DATABASE_URL", urlWith(HASH_PASSWORD));
    const kv = join(tempDir("kv"), "bundle.kv.json");
    const run = capture();

    expect(await main(["publish", dir, "--kv", kv], run.io)).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([REFUSAL]);
    expect(existsSync(kv)).toBe(false);
  });
});

describe("publish.run's other errors from building the client are thrown as they were", () => {
  const settings: [string, Record<string, string>][] = [
    ["CI set and DATABASE_URL not", { CI: "true", DATABASE_URL: "" }],
    [
      "a DB_SCHEMA that is not a plain SQL name",
      { DB_SCHEMA: "Not-A-Schema", DATABASE_URL: urlWith(PASSWORD_HEAD) },
    ],
  ];
  it.each(settings)("%s: the client's own error", async (_, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    let expected: unknown;
    try {
      createClient({ max: 2 });
    } catch (error) {
      expected = error;
    }
    expect(expected).toBeInstanceOf(Error);
    const kv = join(tempDir("kv"), "bundle.kv.json");

    const thrown = await thrownBy(() => publish.run([dir, "--kv", kv], capture().io));
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("Error");
    expect((thrown as Error).message).toBe((expected as Error).message);
    expect(existsSync(kv)).toBe(false);
  });
});

// T-1202: once a client is built, a publish that fails prints one line naming only its error's kind (its code, else its
// name) and a fixed text. The error's message and fields are never printed: they name the database's host and port
// (getaddrinfo ENOTFOUND <host>; connect ECONNREFUSED <address>:<port>; the hostname, address and port fields) or, in
// PostgreSQL's own refusals, its user and database name. client.redact took out only the URL, its user and its password,
// and from a URL that Node's URL parser refuses only the whole string. Every URL here is made up: *_t1202 names on a
// .invalid host, which never resolves (RFC 6761), or on this machine's 127.0.0.1, where port 1 refuses a connection at
// once and the test runs a stand-in for PostgreSQL. Nothing is reached but this machine and its name lookup.
const T1202 = {
  user: "publish_owner_t1202",
  password: "Pw7t1202Kq",
  host: "db-t1202.example.invalid",
  database: "t1202_publish_db",
};

/** The one line a publish prints when it fails after its client is built: the error's kind, then a fixed text. */
const failureLine = (kind: string): string =>
  `the publish failed (${kind}): its message is not printed, since it can name the database's host, port, user or database name`;

/** The kind the lines name, read back from the first one. */
const kindIn = (lines: readonly string[]): string =>
  /^the publish failed \(([^)]*)\): /.exec(lines[0] ?? "")?.[1] ?? "";

/** The parts `lines` hold. A part of digits alone (a port) counts only where it stands as a whole number. */
function partsHeld(lines: readonly string[], parts: readonly string[]): string[] {
  const text = lines.join("\n");
  return parts.filter((part) =>
    /^[0-9]+$/.test(part) ? new RegExp(`(?<![0-9])${part}(?![0-9])`).test(text) : text.includes(part),
  );
}

/**
 * A PostgreSQL ErrorResponse message: the byte E, its length (4 bytes, the length's own included), then each field as
 * its type byte and its text ending in a zero byte, then a zero byte.
 */
function errorResponse(fields: readonly (readonly [string, string])[]): Uint8Array {
  const body = new TextEncoder().encode(`${fields.map(([type, text]) => `${type}${text}\0`).join("")}\0`);
  const message = new Uint8Array(5 + body.length);
  const view = new DataView(message.buffer);
  view.setUint8(0, "E".charCodeAt(0));
  view.setUint32(1, 4 + body.length);
  message.set(body, 5);
  return message;
}

interface RefusingDatabase {
  port: number;
  /** The names and values of each startup message received: user, database and the rest. */
  startups: Record<string, string>[];
  close(): Promise<void>;
}

/**
 * A stand-in for PostgreSQL on 127.0.0.1, at a port the system picks. Each connection's startup message is answered as
 * PostgreSQL answers a client its pg_hba.conf has no entry for: a FATAL 28000 whose message names the client's address
 * and the user and database the client sent. Then the connection is closed.
 */
async function refusingDatabase(): Promise<RefusingDatabase> {
  const startups: Record<string, string>[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let received = new Uint8Array(0);
    let answered = false;
    socket.on("data", (chunk: Uint8Array) => {
      const joined = new Uint8Array(received.length + chunk.length);
      joined.set(received);
      joined.set(chunk, received.length);
      received = joined;
      // The startup message: its length (4 bytes, its own included), the protocol version (4 bytes), then names and
      // values, each ending in a zero byte.
      if (answered || received.length < 8) return;
      const length = new DataView(received.buffer).getUint32(0);
      if (received.length < length) return;
      answered = true;
      const words = new TextDecoder().decode(received.subarray(8, length)).split("\0");
      const startup: Record<string, string> = {};
      for (let k = 0; k + 1 < words.length; k += 2) {
        const [name, value] = [words[k], words[k + 1]];
        if (name !== undefined && name !== "" && value !== undefined) startup[name] = value;
      }
      startups.push(startup);
      const user = startup.user ?? "";
      const database = startup.database ?? "";
      socket.end(
        errorResponse([
          ["S", "FATAL"],
          ["V", "FATAL"],
          ["C", "28000"],
          [
            "M",
            `no pg_hba.conf entry for host "127.0.0.1", user "${user}", database "${database}", no encryption`,
          ],
        ]),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    startups,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("publish.run with a built client whose database cannot be reached (T-1202)", () => {
  const notFound = `postgres://${T1202.user}:${T1202.password}@${T1202.host}:6543/${T1202.database}`;
  const refused = `postgres://${T1202.user}:${T1202.password}@127.0.0.1:1/${T1202.database}`;
  const cases: [string, string, string[], RegExp][] = [
    [
      "a .invalid host, not found (ENOTFOUND, or EAI_AGAIN where no name server answers)",
      notFound,
      [notFound, T1202.user, T1202.password, T1202.host, "6543", T1202.database],
      /^(ENOTFOUND|EAI_AGAIN)$/,
    ],
    [
      "port 1 of 127.0.0.1, which refuses the connection (ECONNREFUSED)",
      refused,
      [refused, T1202.user, T1202.password, "127.0.0.1", "1", T1202.database],
      /^ECONNREFUSED$/,
    ],
  ];

  it.each(cases)(
    "%s: exit 1, and its one line names the error's kind and holds no part of the URL",
    async (_, url, parts, kind) => {
      vi.stubEnv("DATABASE_URL", url);
      const kv = join(tempDir("kv"), "bundle.kv.json");
      const run = capture();

      expect(await publish.run([dir, "--kv", kv], run.io)).toBe(1);
      expect(partsHeld(run.err, parts)).toEqual([]);
      expect(kindIn(run.err)).toMatch(kind);
      expect(run.err).toEqual([failureLine(kindIn(run.err))]);
      expect(run.out).toEqual([]);
      expect(existsSync(kv)).toBe(false);
    },
  );

  it("through the CLI: exit 1, and the same one line", async () => {
    vi.stubEnv("DATABASE_URL", notFound);
    const kv = join(tempDir("kv"), "bundle.kv.json");
    const run = capture();

    expect(await main(["publish", dir, "--kv", kv], run.io)).toBe(1);
    expect(
      partsHeld(run.err, [notFound, T1202.user, T1202.password, T1202.host, "6543", T1202.database]),
    ).toEqual([]);
    expect(kindIn(run.err)).toMatch(/^(ENOTFOUND|EAI_AGAIN)$/);
    expect(run.err).toEqual([failureLine(kindIn(run.err))]);
    expect(run.out).toEqual([]);
    expect(existsSync(kv)).toBe(false);
  });
});

describe("publish.run with a multi-host URL that Node's URL parser refuses (T-1202)", () => {
  let database: RefusingDatabase;

  beforeAll(async () => {
    database = await refusingDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  it("its database refuses the URL's user by name: the line holds no user, nor any other part of the URL", async () => {
    const port = String(database.port);
    // postgres.js reads the hosts after the @ itself and connects to the first one; Node's URL parser refuses the , in
    // the port, so client.redact could take out only the whole string.
    const url = `postgres://${T1202.user}:${T1202.password}@127.0.0.1:${port},${T1202.host}:${port}/${T1202.database}`;
    expect(URL.canParse(url)).toBe(false);
    vi.stubEnv("DATABASE_URL", url);
    const kv = join(tempDir("kv"), "bundle.kv.json");
    const run = capture();

    expect(await publish.run([dir, "--kv", kv], run.io)).toBe(1);
    // The stand-in was sent the URL's user and database, and its refusal named both.
    expect(database.startups[0]).toMatchObject({ user: T1202.user, database: T1202.database });
    expect(
      partsHeld(run.err, [url, T1202.user, T1202.password, "127.0.0.1", T1202.host, port, T1202.database]),
    ).toEqual([]);
    expect(run.err).toEqual([failureLine("28000")]);
    expect(run.out).toEqual([]);
    expect(existsSync(kv)).toBe(false);
  });
});
