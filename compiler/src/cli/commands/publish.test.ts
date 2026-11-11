// T-1179: compiler publish builds its database client inside its try, so a caller that runs publish.run directly (as
// infra/scripts/publish-bundle.sh does), not through the CLI's catch, never gets an error that holds the database URL.
// postgres.js parses each URL when the client is built (node_modules/postgres/src/index.js:50 and :545), and Node's
// ERR_INVALID_URL keeps the whole string in its `input` property, which Node prints for an error that is not caught.
// Every URL here is made up and set through the environment the client reads (DATABASE_URL, DATABASE_REPLICA_URL): its
// user, password, host and database are *_t1179 names on .invalid hosts, never a real key. A URL that does not parse
// means no client is built and no database is reached, so the one thing a publish could write is the KV bulk file.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
