// T-419: live-check.mjs, T-1032's live check, against a stubbed environment and never Resend. With no key it refuses
// before any request and names the missing key; with a key (from the environment, or by name from a stub variables file
// in a temporary folder) and Resend's recorded answer it prints the provider's message id as PASS, and never the key.
// The key is a made-up string built here (rule 7), and the HTTP call is a stub that records each request. The script
// itself is also run as `node live-check.mjs` from an empty temporary folder: with no key, and with a stub of fetch
// loaded before it that answers as Resend's recorded response does, so no run reaches the network.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RESEND_API_KEY, RESEND_EMAILS_URL, TEST_INBOXES, USER_AGENT, sendEmailProblems } from "./index";
import {
  FROM,
  KEY_NAME,
  LIST_NAME,
  TEST_INBOX,
  VARS_FILE,
  liveCheckEmail,
  readDevVar,
  runLiveCheck,
  type LiveCheckIo,
} from "./live-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "live-check.mjs");
const RESPONSE_SAMPLE = path.resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "contracts",
  "port-email",
  "vendor-samples",
  "send-email-response.json",
);
// Made up here, not a key of any service, and not in a key's shape (rule 7).
const FAKE_KEY = "fake-resend-key-t419-live-0001";
const OTHER_KEY = "fake-resend-key-t419-live-0002";
const NOW = "2026-11-12T08:00:00Z";
const SLOW = { timeout: 60_000 };

/** Resend's recorded answer to a send (contracts/port-email/vendor-samples/send-email-response.json). */
const RECORDED = readFileSync(RESPONSE_SAMPLE, "utf8");
const RECORDED_ID = (JSON.parse(RECORDED) as { id: string }).id;

interface Seen {
  url: string;
  authorization: string | null;
  userAgent: string | null;
  body: { from: string; to: string[]; subject: string; text: string; reply_to?: string; headers?: unknown };
}

interface Run {
  code: number;
  out: string[];
  err: string[];
  seen: Seen[];
}

let empty: string;
let withVars: string;
let stubs: string;

beforeAll(() => {
  empty = mkdtempSync(path.join(tmpdir(), "t419-live-check-empty-"));
  withVars = mkdtempSync(path.join(tmpdir(), "t419-live-check-vars-"));
  stubs = mkdtempSync(path.join(tmpdir(), "t419-live-check-stubs-"));
  // A stub variables file: other names around the key's own line, the key with `export` and quotes, as lib.sh reads them.
  writeFileSync(
    path.join(withVars, VARS_FILE),
    `OTHER_NAME=not-this\nRESEND_API_KEY_OLD=nor-this\n  export RESEND_API_KEY = "${FAKE_KEY}"\nRESEND_API_KEY=${OTHER_KEY}\n`,
  );
});

afterAll(() => {
  for (const folder of [empty, withVars, stubs]) rmSync(folder, { recursive: true, force: true });
});

/** A stub of the HTTP call that records each request and answers with `answer`. */
function stubFetch(answer: () => Response): { fetch: (request: Request) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (request) => {
      seen.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        userAgent: request.headers.get("user-agent"),
        body: JSON.parse(await request.text()) as Seen["body"],
      });
      return answer();
    },
  };
}

const recorded = (): Response => new Response(RECORDED, { status: 200 });

async function run(
  io: Partial<LiveCheckIo> & Pick<LiveCheckIo, "env" | "cwd">,
  answer = recorded,
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const stub = stubFetch(answer);
  const code = await runLiveCheck({
    fetch: stub.fetch,
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...io,
  });
  return { code, out, err, seen: stub.seen };
}

/** No line holds any of the keys. */
function expectNoKey(lines: readonly string[]): void {
  for (const key of [FAKE_KEY, OTHER_KEY]) expect(lines.join("\n")).not.toContain(key);
}

describe("live-check.mjs: what it sends", () => {
  it("reads the adapter's own two names", () => {
    expect([KEY_NAME, LIST_NAME]).toEqual([RESEND_API_KEY, TEST_INBOXES]);
  });

  it("sends one K-12 v1 email, about no booking, to Resend's test inbox, under a key of its own", () => {
    const email = liveCheckEmail(NOW, "a1b2c3d4");
    expect(sendEmailProblems(email)).toEqual([]);
    expect(email).toMatchObject({
      to: "delivered@resend.dev",
      from: { name: "Rosie", address: "rosie@mail.rosfield.com" },
      bookingId: null,
      replyTo: null,
      idempotencyKey: "live-check-t1032-20261112T080000Z-a1b2c3d4/1/1",
    });
    expect(TEST_INBOX).toBe("delivered@resend.dev");
    expect(FROM.address).toMatch(/@mail[.]rosfield[.]com$/);
  });
});

describe("live-check.mjs: with no key it refuses, names the missing key and sends nothing", () => {
  it.each([
    ["no key anywhere", {}],
    ["a blank key in the environment, and no variables file", { RESEND_API_KEY: "   " }],
    ["an empty key in the environment, and no variables file", { RESEND_API_KEY: "" }],
  ])("%s", async (_label, env) => {
    const result = await run({ env, cwd: empty });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toContain("live-check: refused:");
    expect(result.err[0]).toContain("RESEND_API_KEY is not set");
    expect(result.err[0]).toContain("nothing was sent");
    expect(result.seen).toEqual([]);
  });

  it("refuses in CI, and any argument, before reading a key", async () => {
    const ci = await run({ env: { CI: "true", RESEND_API_KEY: FAKE_KEY }, cwd: withVars });
    expect(ci.code).toBe(1);
    expect(ci.err.join("\n")).toContain("CI is set");
    const argued = await run({
      env: { RESEND_API_KEY: FAKE_KEY },
      cwd: empty,
      argv: ["--to", "alex@example.com"],
    });
    expect(argued.code).toBe(2);
    expect(argued.err.join("\n")).toContain("takes no argument");
    for (const result of [ci, argued]) {
      expect(result.seen).toEqual([]);
      expectNoKey([...result.out, ...result.err]);
    }
  });
});

describe("live-check.mjs: with a key and Resend's recorded answer it prints the message id as PASS, never the key", () => {
  it("takes the key from the environment", async () => {
    const result = await run({ env: { RESEND_API_KEY: FAKE_KEY }, cwd: empty });
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.out.at(-1)).toBe(
      `live-check: PASS: Resend accepted the email: provider message id ${RECORDED_ID}, accepted at ${NOW}`,
    );
    expectNoKey(result.out);
    expect(result.seen).toHaveLength(1);
    expect(result.seen[0]).toMatchObject({
      url: RESEND_EMAILS_URL,
      authorization: `Bearer ${FAKE_KEY}`,
      userAgent: USER_AGENT,
      body: { from: "Rosie <rosie@mail.rosfield.com>", to: [TEST_INBOX] },
    });
    expect(result.seen[0]?.body.reply_to).toBeUndefined();
    expect(result.seen[0]?.body.headers).toBeUndefined();
  });

  it("takes the key by name from the variables file of the folder it runs from, its first line for the name", async () => {
    const result = await run({ env: {}, cwd: withVars });
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toContain(
      `PASS: Resend accepted the email: provider message id ${RECORDED_ID}`,
    );
    expect(result.seen.map((seen) => seen.authorization)).toEqual([`Bearer ${FAKE_KEY}`]);
    expectNoKey([...result.out, ...result.err]);
  });

  it("takes the environment's key over the file's", async () => {
    const result = await run({ env: { RESEND_API_KEY: OTHER_KEY }, cwd: withVars });
    expect(result.code).toBe(0);
    expect(result.seen.map((seen) => seen.authorization)).toEqual([`Bearer ${OTHER_KEY}`]);
    expectNoKey([...result.out, ...result.err]);
  });

  it("prints FAIL with Resend's answer when Resend refuses, and never the key", async () => {
    const refused = (): Response =>
      new Response(
        JSON.stringify({ statusCode: 401, name: "restricted_api_key", message: "Made up for a test." }),
        {
          status: 401,
        },
      );
    const result = await run({ env: { RESEND_API_KEY: FAKE_KEY }, cwd: empty }, refused);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "live-check: FAIL: Resend answered refused (HTTP 401, restricted_api_key): Resend refused the email.",
    ]);
    expectNoKey([...result.out, ...result.err]);
  });

  it("prints an error with the key taken out", async () => {
    const result = await run({
      env: { RESEND_API_KEY: FAKE_KEY },
      cwd: empty,
      now: () => {
        throw new Error(`a clock that names ${FAKE_KEY}`);
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["live-check: failed: Error: a clock that names [redacted]"]);
    expect(result.seen).toEqual([]);
  });
});

describe("live-check.mjs: readDevVar reads one name", () => {
  it("reads export, spaces and one pair of quotes, and nothing for a missing file or name", () => {
    expect(readDevVar(path.join(withVars, VARS_FILE), "RESEND_API_KEY")).toBe(FAKE_KEY);
    expect(readDevVar(path.join(withVars, VARS_FILE), "OTHER_NAME")).toBe("not-this");
    expect(readDevVar(path.join(withVars, VARS_FILE), "MISSING_NAME")).toBeUndefined();
    expect(readDevVar(path.join(empty, VARS_FILE), "RESEND_API_KEY")).toBeUndefined();
  });
});

describe("live-check.mjs run as a script", () => {
  /** Runs `node live-check.mjs` in `cwd` with only PATH and `extra` in its environment. */
  function script(
    cwd: string,
    extra: Record<string, string>,
    before: string[] = [],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [...before, SCRIPT],
        { cwd, env: { PATH: process.env.PATH ?? "", ...extra }, timeout: 50_000 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  it("with no key: refuses, names the missing key and exits 1", SLOW, async () => {
    const result = await script(empty, {});
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("live-check: refused: RESEND_API_KEY is not set");
  });

  it(
    "with a key and a stub of fetch answering as Resend's recorded response: PASS with the id, exit 0, no key printed",
    SLOW,
    async () => {
      // The stub answers the recorded response only to the request the check must make, and 422 to any other.
      const stub = path.join(stubs, "stub-fetch.mjs");
      writeFileSync(
        stub,
        [
          "globalThis.fetch = async (request) => {",
          `  const right = request.url === ${JSON.stringify(RESEND_EMAILS_URL)} &&`,
          "    request.headers.get('authorization') === `Bearer ${process.env.RESEND_API_KEY}` &&",
          `    JSON.parse(await request.text()).to.join() === ${JSON.stringify(TEST_INBOX)};`,
          `  return new Response(right ? ${JSON.stringify(RECORDED)} : "{}", { status: right ? 200 : 422 });`,
          "};",
          "",
        ].join("\n"),
      );
      const result = await script(empty, { RESEND_API_KEY: FAKE_KEY }, [
        "--import",
        pathToFileURL(stub).href,
      ]);
      expect(result.stdout).toContain(
        `live-check: PASS: Resend accepted the email: provider message id ${RECORDED_ID}`,
      );
      expect(result.code).toBe(0);
      expectNoKey([result.stdout, result.stderr]);
    },
  );
});
