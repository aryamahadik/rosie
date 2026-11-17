// T-417: run.mjs, the Linq live check (run live only in T-1031, NQ-R2), against a stubbed environment: never Linq, never
// Cloudflare, never a real key. The HTTP call is a stub that records each request and answers with a recorded Linq
// answer: T-1121's live 201 of Nov 17 (adapters/spikes/linq-live/samples/) or K-11's vendor sample of a send into a chat
// (contracts/port-linq/vendor-samples/). Staging's logs are a stand-in for the tail's process that prints, after the send,
// the events wrangler tail would print, in its json form, holding the spans K-08's skeleton trace records
// (contracts/event-trace/fixtures/trace-skeleton.json) as the runtime's log sink writes them. The key and the webhook
// secret are made up here (rule 7), every number is a whole fiction-range literal (555-01xx), and every line run.mjs
// prints is scanned for any key shape and any whole number. The script itself is also run as `node run.mjs` from an empty
// folder with no key, where it refuses before anything reaches the network.
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findPrivateValue } from "../../shared/redact";
import { loadRecordedSample } from "../../shared/samples";
import { REASONS, ROSIE_NUMBER, STAGING_LINQ_ALLOWLIST } from "../roster";
import { LINQ_API_BASE, LINQ_API_TOKEN, USER_AGENT, sendPartProblems } from "../send";
import {
  TAIL_ARGS,
  TailJsonStream,
  openStagingTail,
  recordsOfTailEvent,
  tailEnv,
  type SpawnProcess,
  type TailChild,
  type TailSpawnOptions,
} from "./logs.mjs";
import { phoneNumbersIn } from "./output-scan.mjs";
import {
  LINQ_WEBHOOK_PATH,
  NAMES,
  ROOT,
  VARS_FILE,
  WORDS,
  checkValues,
  offRosterNumber,
  runLiveCheck,
  wordsRequest,
  type LiveCheckIo,
} from "./run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const SCRIPT = path.join(HERE, "run.mjs");
const LIVE = path.join(REPO, "adapters", "spikes", "linq-live", "samples");
const VENDOR = path.join(REPO, "contracts", "port-linq", "vendor-samples");
const K08_SKELETON = path.join(REPO, "contracts", "event-trace", "fixtures", "trace-skeleton.json");
const SLOW = { timeout: 60_000 };

// Made up here, not a key of any service (rule 7): letters alone, so no shared/redact.ts pattern and no number reading
// can catch them, and only the script's own masking keeps them out of what it prints.
const FAKE_KEY = "fakeLinqKeyForTheLiveCheckOnlyQzXw";
const OTHER_KEY = "otherFakeLinqKeyForTheLiveCheckVbNm";
// Made up here: "whsec_" and base64, as Linq's secrets are written (T-413's tests make theirs the same way).
const FAKE_SECRET = `whsec_${btoa("rosie-live-check-test-signing-bytes-01")}`;

// Fiction numbers alone (+1, area code 555, then 555-0100 to 555-0199).
const LINE = "+15555550199";
const PHONE = "+15555550101";
const OTHER_PHONE = "+15555550102";
const STRAY_PHONE = "+15555550142";
/** Step 3's number for a roster of PHONE alone: the first fiction number on neither the roster nor the line. */
const OFF_ROSTER = "+15555550100";
/** The sample cast's chat (K-11's vendor samples), standing in for the roster phone's chat with Rosie's line. */
const CHAT = "linq-chat-demo-alex";
/** The test's clock: every span below is logged after it. */
const NOW = Date.parse("2026-11-17T20:00:00Z");
/** The reply's trace id, in the form the runtime gives every trace: a UUID (runtime/src/trace/context.ts). */
const REPLY_TRACE = "5f0c6a52-6b1e-4f0e-9a51-3c1d2e4f5a6b";
const OTHER_TRACE = "9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e";
const REPLY_EVENT = "evt-alex-0002";
const WEBHOOK_URL = `https://staging.example.com/test${LINQ_WEBHOOK_PATH}`;
const PAGE_URL = "https://staging.example.com/test/page-api/testPhoneSend";
/** Short waits, so a run that waits for nothing ends quickly. */
const WAITS = { settleMs: 0, replyMs: 1_500, traceMs: 800 };

const BASE_ENV: Readonly<Record<string, string>> = {
  [NAMES.key]: FAKE_KEY,
  [NAMES.secret]: FAKE_SECRET,
  [NAMES.line]: LINE,
  [NAMES.roster]: PHONE,
  [NAMES.chat]: CHAT,
};

/** One file of a T-1121 live run (adapters/spikes/linq-live/FINDINGS.md 'The samples'). */
interface LiveSample {
  response: { status: number; body: unknown };
}

const live = (name: string): LiveSample => loadRecordedSample(LIVE, name) as LiveSample;
const LIVE_SEND = live("live-2026-11-17T00-27-34Z-03-send-send.json");
const LIVE_STOPPED = live("live-2026-11-17T00-37-18Z-01-stopped-send.json");
const VENDOR_SEND = loadRecordedSample(VENDOR, "send-message-response.json");
const LIVE_MESSAGE_ID = (LIVE_SEND.response.body as { chat: { message: { id: string } } }).chat.message.id;
const VENDOR_MESSAGE_ID = (VENDOR_SEND as { message: { id: string } }).message.id;

/** K-08's skeleton trace: its receive span (seq 1) and its scrub span (seq 2), the two a webhook's request logs. */
const SKELETON = JSON.parse(readFileSync(K08_SKELETON, "utf8")) as { spans: Record<string, unknown>[] };
const [RECEIVE, SCRUB] = SKELETON.spans;

/** A span's log line as the runtime's sink writes it (runtime/src/trace/context.ts logSink), with fields changed. */
function spanLine(span: Record<string, unknown> | undefined, changes: Record<string, unknown>): string {
  return JSON.stringify({
    level: "info",
    msg: "span",
    ...span,
    ...changes,
    environment: "staging",
    version: "test-sha",
  });
}

/** The reply's receive span: K-08's, under the reply's trace and event, as the gateway logs it (answered 200). */
function receiveLine(changes: Record<string, unknown> = {}): string {
  return spanLine(RECEIVE, {
    trace_id: REPLY_TRACE,
    span_id: `${REPLY_TRACE}:01`,
    event_id: REPLY_EVENT,
    at: new Date(NOW + 30_000).toISOString(),
    decided: { signatureValid: true, knownEventId: false, sealedToActor: true, answered: 200 },
    ...changes,
  });
}

/** The reply's scrub span: K-08's, under the reply's trace and event. */
function scrubLine(changes: Record<string, unknown> = {}): string {
  return spanLine(SCRUB, {
    trace_id: REPLY_TRACE,
    span_id: `${REPLY_TRACE}:02`,
    event_id: REPLY_EVENT,
    at: new Date(NOW + 30_010).toISOString(),
    ...changes,
  });
}

/**
 * One event as wrangler tail prints it in its json form (each event over several lines): the request it served and its
 * log lines. Every event also holds a log line and a header that must never be printed: the made-up key and a number.
 */
function tailEvent(url: string | null, lines: readonly string[]): string {
  const event = {
    outcome: "ok",
    scriptName: "rosie-staging",
    diagnosticsChannelEvents: [],
    exceptions: [],
    logs: [
      {
        message: [`not a span: Bearer ${FAKE_KEY} for ${STRAY_PHONE} {"msg":"span"`],
        level: "log",
        timestamp: NOW,
      },
      ...lines.map((line) => ({ message: [line], level: "log", timestamp: NOW + 30_000 })),
    ],
    eventTimestamp: NOW + 30_000,
    event:
      url === null
        ? null
        : {
            request: {
              url,
              method: "POST",
              headers: { authorization: `Bearer ${OTHER_KEY}`, "webhook-id": REPLY_EVENT },
              cf: {},
            },
            response: { status: 200 },
          },
  };
  return `${JSON.stringify(event, null, 2)}\n`;
}

/** The reply as staging logs it: the webhook's event with its receive and scrub spans. */
const REPLY = tailEvent(WEBHOOK_URL, [receiveLine(), scrubLine()]);

/** A stand-in for the tail's process: what the test writes is its standard output; kill() ends it. */
class FakeTail implements TailChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  readonly #events = new EventEmitter();
  #ended = false;

  on(event: string, listener: ((code: number | null) => void) | ((error: Error) => void)): this {
    this.#events.on(event, listener);
    return this;
  }

  print(text: string): void {
    this.stdout.write(text);
  }

  end(code: number | null): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#events.emit("close", code);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    setImmediate(() => {
      this.end(null);
    });
    return true;
  }
}

/** One start of the tail's process, as the check asked for it. */
interface Spawned {
  command: string;
  args: readonly string[];
  options: TailSpawnOptions;
}

/** A spawn that records each start and hands back `tail`. */
function fakeSpawn(tail: FakeTail): { spawnProcess: SpawnProcess; calls: Spawned[] } {
  const calls: Spawned[] = [];
  return {
    calls,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return tail;
    },
  };
}

/** One request as the stub of the HTTP call saw it. */
interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  userAgent: string | null;
  body: string;
}

/** A stub of the HTTP call: it records each request, runs `onRequest`, and answers with `answer`. */
function stubFetch(
  answer: () => Response,
  onRequest: () => void = () => undefined,
): { fetch: (request: Request) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (request) => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        userAgent: request.headers.get("user-agent"),
        body: await request.text(),
      });
      onRequest();
      return answer();
    },
  };
}

const answerWith =
  (status: number, body: unknown): (() => Response) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const liveAccepted = answerWith(LIVE_SEND.response.status, LIVE_SEND.response.body);
const vendorAccepted = answerWith(200, VENDOR_SEND);

interface Run {
  code: number;
  out: string[];
  err: string[];
  seen: Seen[];
  spawned: Spawned[];
  tail: FakeTail;
}

/**
 * One run of the check against the stubs: the tail's stand-in prints `before` as soon as it starts and `after` once the
 * send reaches the HTTP call (the reply comes after the text); `answer` is Linq's answer to the send.
 */
async function run(
  io: Partial<LiveCheckIo> = {},
  options: { answer?: () => Response; before?: string; after?: string; endTail?: number } = {},
): Promise<Run> {
  const tail = new FakeTail();
  const spawn = fakeSpawn(tail);
  const stub = stubFetch(options.answer ?? liveAccepted, () => {
    if (options.after !== undefined) tail.print(options.after);
  });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runLiveCheck({
    env: BASE_ENV,
    cwd: empty,
    fetch: stub.fetch,
    spawnProcess: (command, args, spawnOptions) => {
      const child = spawn.spawnProcess(command, args, spawnOptions);
      if (options.before !== undefined) tail.print(options.before);
      const exit = options.endTail;
      if (exit !== undefined)
        setImmediate(() => {
          tail.end(exit);
        });
      return child;
    },
    now: () => NOW,
    // The settle wait is short and real, so a tail that ends at once has ended by the time the check looks.
    sleep: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      }),
    waits: WAITS,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...io,
  });
  return { code, out, err, seen: stub.seen, spawned: spawn.calls, tail };
}

/**
 * The output scan: no line holds a key or the webhook secret (whole, or the secret's base64), a bearer header, a key's
 * shape (shared/redact.ts), an email or an E.164 number, and the repository's phone scan finds no number at all in it,
 * fiction or not: each number shows as its last 2 digits alone.
 */
function expectClean(lines: readonly string[]): void {
  const text = lines.join("\n");
  for (const secret of [FAKE_KEY, OTHER_KEY, FAKE_SECRET, FAKE_SECRET.slice("whsec_".length)])
    expect(text).not.toContain(secret);
  // A bearer token, or a webhook secret's value (the form's name alone, "whsec_,", may be named in a refusal).
  expect(text).not.toMatch(/\bbearer\s+\S|whsec_[A-Za-z0-9+/=]/i);
  for (const line of lines) expect(findPrivateValue(line, { looseNumbers: false })).toBeUndefined();
  expect(phoneNumbersIn(text)).toEqual([]);
  for (const number of [LINE, PHONE, OTHER_PHONE, STRAY_PHONE, OFF_ROSTER])
    expect(text).not.toContain(number.slice(2));
}

let empty: string;
let withVars: string;

beforeAll(() => {
  empty = mkdtempSync(path.join(tmpdir(), "t417-live-check-empty-"));
  withVars = mkdtempSync(path.join(tmpdir(), "t417-live-check-vars-"));
  // A stub variables file holding made-up values alone: other names around each line, `export` and quotes as lib.sh
  // reads them, and a second line for the key that is never read (the first line wins).
  writeFileSync(
    path.join(withVars, VARS_FILE),
    [
      "OTHER_NAME=not-this",
      `  export ${NAMES.key} = "${FAKE_KEY}"`,
      `${NAMES.key}=${OTHER_KEY}`,
      `${NAMES.secret}='${FAKE_SECRET}'`,
      `${NAMES.line}=${LINE}`,
      `${NAMES.roster}=${PHONE}`,
      `${NAMES.chat}=${CHAT}`,
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  for (const folder of [empty, withVars]) rmSync(folder, { recursive: true, force: true });
});

describe("run.mjs: what it reads and sends", () => {
  it("reads the adapters' own names, and K-11's webhook secret", () => {
    expect([NAMES.key, NAMES.roster, NAMES.line]).toEqual([
      LINQ_API_TOKEN,
      STAGING_LINQ_ALLOWLIST,
      ROSIE_NUMBER,
    ]);
    expect(NAMES.secret).toBe("LINQ_WEBHOOK_SECRET");
    expect(NAMES.chat).toBe("LINQ_LIVE_CHAT_ID");
  });

  it("sends one K-11 v1 words part with no link and no override, plainly a Rosie staging test, under a K-07 key", () => {
    const request = wordsRequest(PHONE, CHAT, "live-check-t1031-20261117T200000Z-a1b2c3d4/1/1");
    expect(sendPartProblems(request)).toEqual([]);
    expect(request).toMatchObject({
      to: PHONE,
      chatId: CHAT,
      kind: "words",
      link: null,
      overrideOptout: false,
    });
    expect(WORDS).toMatch(/^Rosie staging live check \(T-1031\): /);
    expect(WORDS).not.toMatch(/https?:|\b(?:STOP|CANCEL|END|QUIT|UNSUBSCRIBE|OPTOUT)\b/i);
  });

  it("tries step 3's send on the first fiction number that is neither on the roster nor Rosie's line", () => {
    expect(offRosterNumber([PHONE], LINE)).toBe(OFF_ROSTER);
    expect(offRosterNumber([OFF_ROSTER, PHONE], LINE)).toBe(OTHER_PHONE);
    const block = OFF_ROSTER.slice(0, -2);
    const everyFiction = Array.from({ length: 100 }, (_, n) => `${block}${String(n).padStart(2, "0")}`);
    expect(offRosterNumber(everyFiction, LINE)).toBeNull();
  });

  it("names Linq's webhook path as the gateway does (runtime/src/gateway/index.ts)", () => {
    const gateway = readFileSync(path.join(REPO, "runtime", "src", "gateway", "index.ts"), "utf8");
    expect(gateway).toContain(`export const LINQ_WEBHOOK_PATH = "${LINQ_WEBHOOK_PATH}";`);
  });
});

describe("run.mjs: with a value missing or wrong it refuses to start, names the value, and sends and reads nothing", () => {
  const without = (name: string): Record<string, string> =>
    Object.fromEntries(Object.entries(BASE_ENV).filter(([key]) => key !== name));
  const cases: [string, Record<string, string>, string][] = [
    [
      "no key",
      without(NAMES.key),
      "LINQ_API_TOKEN is not set, in the environment or in .dev.vars in the folder this runs from: Linq's key, read by name, is needed for the send",
    ],
    ["a blank key", { ...BASE_ENV, [NAMES.key]: "   " }, "LINQ_API_TOKEN is not set"],
    [
      "a key with a space in it",
      { ...BASE_ENV, [NAMES.key]: `${FAKE_KEY} x` },
      "LINQ_API_TOKEN is not a usable key",
    ],
    ["no webhook secret", without(NAMES.secret), "LINQ_WEBHOOK_SECRET is not set"],
    [
      "a webhook secret that is not whsec_ and base64",
      { ...BASE_ENV, [NAMES.secret]: OTHER_KEY },
      "LINQ_WEBHOOK_SECRET is not in the form Linq's webhook secrets take",
    ],
    ["no line", without(NAMES.line), "ROSIE_NUMBER is not set, or is not an E.164 number"],
    ["no roster", without(NAMES.roster), "STAGING_LINQ_ALLOWLIST is not set, or is empty"],
    [
      "a roster entry that is not E.164 (a space after the comma)",
      { ...BASE_ENV, [NAMES.roster]: `${PHONE}, ${OTHER_PHONE}` },
      "STAGING_LINQ_ALLOWLIST: entry 2 of 2 is not an E.164 number",
    ],
    [
      "two roster phones and none named",
      { ...BASE_ENV, [NAMES.roster]: `${PHONE},${OTHER_PHONE}` },
      "STAGING_LINQ_ALLOWLIST holds 2 numbers and LINQ_PROBE_TO names none",
    ],
    [
      "a destination off the roster",
      { ...BASE_ENV, [NAMES.to]: OTHER_PHONE },
      "LINQ_PROBE_TO (***02) is not on STAGING_LINQ_ALLOWLIST: the check sends to no number off that list",
    ],
    [
      "Rosie's own line as the destination",
      { ...BASE_ENV, [NAMES.roster]: LINE },
      "the destination is Rosie's own line (ROSIE_NUMBER): the check never texts the line itself",
    ],
    ["no chat", without(NAMES.chat), "LINQ_LIVE_CHAT_ID is not set"],
    ["a chat id of ..", { ...BASE_ENV, [NAMES.chat]: ".." }, "LINQ_LIVE_CHAT_ID is not a Linq id"],
  ];

  it.each(cases)("%s", async (_label, env, says) => {
    const result = await run({ env });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toHaveLength(2);
    expect(result.err[0]?.startsWith(`linq-live-check: refused: ${says}`), result.err[0]).toBe(true);
    expect(result.err[1]).toBe("linq-live-check: nothing was sent");
    expect(result.seen).toEqual([]);
    expect(result.spawned).toEqual([]);
    expectClean(result.err);
  });

  it("names every problem at once, each by its variable alone", () => {
    const { problems, values } = checkValues({ key: "", secret: "", line: "", roster: "", to: "", chat: "" });
    expect(values).toBeNull();
    expect(problems.map((problem) => problem.split(" ")[0])).toEqual([
      "LINQ_API_TOKEN",
      "LINQ_WEBHOOK_SECRET",
      "ROSIE_NUMBER",
      "STAGING_LINQ_ALLOWLIST",
      "LINQ_LIVE_CHAT_ID",
    ]);
  });

  it("refuses in CI, and refuses any argument without echoing it, before reading a value", async () => {
    const ci = await run({ env: { ...BASE_ENV, CI: "true" } });
    expect(ci.code).toBe(1);
    expect(ci.err).toEqual([
      "linq-live-check: refused: CI is set, and the live check runs only in an interactive session with the user present (NQ-R2); nothing was sent",
    ]);
    const argued = await run({ argv: ["--to", OTHER_PHONE] });
    expect(argued.code).toBe(2);
    expect(argued.err).toEqual([
      "linq-live-check: refused: it takes no argument (arguments are never echoed); nothing was sent",
    ]);
    for (const result of [ci, argued]) {
      expect(result.seen).toEqual([]);
      expect(result.spawned).toEqual([]);
      expectClean([...result.out, ...result.err]);
    }
  });

  it("reads no name but its own (and CI)", async () => {
    const read = new Set<string>();
    const env = new Proxy(
      { ...BASE_ENV },
      {
        get(target, name) {
          if (typeof name === "string") read.add(name);
          return Reflect.get(target, name) as unknown;
        },
      },
    );
    const result = await run({ env }, { after: REPLY });
    expect(result.code).toBe(0);
    expect([...read].filter((name) => name !== "CI" && !Object.values<string>(NAMES).includes(name))).toEqual(
      [],
    );
  });
});

describe("run.mjs: against recorded Linq samples it prints the K-06 signature check and the message id as PASS lines, and never a key or a whole number", () => {
  const samples: [string, () => Response, string][] = [
    ["T-1121's live 201 of Nov 17 (the message inside chat)", liveAccepted, LIVE_MESSAGE_ID],
    ["K-11's vendor sample of a send into a chat (a top-level message)", vendorAccepted, VENDOR_MESSAGE_ID],
  ];

  it.each(samples)("%s", async (_label, answer, messageId) => {
    const result = await run({}, { answer, after: REPLY });
    expect(result.err).toEqual([]);
    expect(result.out).toEqual([
      "linq-live-check: PASS: the K-06 signature check: T-413's verifier, under LINQ_WEBHOOK_SECRET, turned Linq's recorded message.received, signed under it, into a K-06 text event, and refused it with one byte changed (badSignature)",
      "linq-live-check: PASS: the roster guard refused a send to ***00, a number off STAGING_LINQ_ALLOWLIST, before any call to Linq",
      "linq-live-check: reading staging's logs through npm run cf -- tail --env staging --format json (wrangler tail on rosie-staging, the pinned Rosfield account), from before the send",
      `linq-live-check: PASS: Linq accepted the text to ***01: message id ${messageId}`,
      "linq-live-check: waiting up to 2 s for the reply in staging's logs: reply OK to the text on the phone ***01",
      `linq-live-check: PASS: the reply arrived in staging's logs as a signed K-06 text event, written to its actor, with one trace id: ${REPLY_TRACE} (receive and scrub; npm run staging:trace -- ${REPLY_TRACE} reads what it wrote)`,
    ]);
    expect(result.code).toBe(0);
    expectClean(result.out);

    // One request reached the HTTP call: the text, through T-414's sender (its User-Agent), into the roster phone's chat,
    // with the key in its Authorization header alone. Step 3's send to the number off the roster made none.
    expect(result.seen).toHaveLength(1);
    const [sent] = result.seen;
    expect(sent).toMatchObject({
      method: "POST",
      url: `${LINQ_API_BASE}/chats/${CHAT}/messages`,
      authorization: `Bearer ${FAKE_KEY}`,
      userAgent: USER_AGENT,
    });
    const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      message: {
        parts: [{ type: "text", value: WORDS }],
        idempotency_key: expect.stringMatching(
          /^live-check-t1031-20261117T200000Z-[0-9a-f]{8}\/1\/1$/,
        ) as unknown,
      },
    });
    expect(`${sent?.url ?? ""}${sent?.body ?? ""}`).not.toContain(FAKE_KEY);

    // Staging's logs: cf.sh's tail on staging, started in the checkout with an environment that holds none of the
    // names the check reads, and stopped (Ctrl-C's signal) when the check ends.
    expect(result.spawned).toHaveLength(1);
    const [spawned] = result.spawned;
    expect(spawned?.command).toBe("bash");
    expect(spawned?.args).toEqual([path.join(REPO, "infra", "scripts", "cf.sh"), ...TAIL_ARGS]);
    expect(TAIL_ARGS).toEqual(["tail", "--env", "staging", "--format", "json"]);
    expect(path.resolve(spawned?.options.cwd ?? "")).toBe(REPO);
    expect(spawned?.options.env).toEqual({});
    expect(result.tail.signals).toEqual(["SIGINT"]);
  });

  it("refuses the send to a number off the roster before the HTTP call, and says so before the real text goes", async () => {
    const result = await run(
      { env: { ...BASE_ENV, [NAMES.roster]: `${OFF_ROSTER},${PHONE}`, [NAMES.to]: PHONE } },
      {
        after: REPLY,
      },
    );
    expect(result.code).toBe(0);
    // 555-0100 is on this roster, so step 3 tries the next fiction number off it, 555-0102.
    expect(result.out[1]).toBe(
      "linq-live-check: PASS: the roster guard refused a send to ***02, a number off STAGING_LINQ_ALLOWLIST, before any call to Linq",
    );
    expect(result.out.findIndex((line) => line.includes("Linq accepted the text"))).toBe(3);
    expect(result.seen.map((seen) => seen.url)).toEqual([`${LINQ_API_BASE}/chats/${CHAT}/messages`]);
    expect(REASONS.offRoster).toContain("nothing was sent to Linq");
    expectClean(result.out);
  });

  it("reads the values by name from .dev.vars in the folder it runs from, the environment's first", async () => {
    const fromFile = await run({ env: {}, cwd: withVars }, { after: REPLY });
    expect(fromFile.code).toBe(0);
    expect(fromFile.seen.map((seen) => seen.authorization)).toEqual([`Bearer ${FAKE_KEY}`]);
    const fromEnv = await run({ env: { [NAMES.key]: OTHER_KEY }, cwd: withVars }, { after: REPLY });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.seen.map((seen) => seen.authorization)).toEqual([`Bearer ${OTHER_KEY}`]);
    for (const result of [fromFile, fromEnv]) expectClean([...result.out, ...result.err]);
  });

  it("hands the tail's process the caller's environment without any name it reads", async () => {
    const result = await run(
      { env: { ...BASE_ENV, HOME: "/home/test", LINQ_FROM: LINE, OTHER: "kept" } },
      {
        after: REPLY,
      },
    );
    expect(result.code).toBe(0);
    expect(result.spawned[0]?.options.env).toEqual({ HOME: "/home/test", OTHER: "kept" });
  });
});

describe("run.mjs: what fails the check", () => {
  it("Linq's refusal of the send (T-1121's recorded 403, code 2024): FAIL with Linq's answer, and the logs closed", async () => {
    const result = await run(
      {},
      { answer: answerWith(LIVE_STOPPED.response.status, LIVE_STOPPED.response.body), after: REPLY },
    );
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "linq-live-check: FAIL: Linq answered optedOut (HTTP 403, 2024) to the text to ***01: Recipient asked you to stop messaging them",
    ]);
    expect(result.tail.signals).toEqual(["SIGINT"]);
    expectClean([...result.out, ...result.err]);
  });

  it("no reply within the wait: FAIL, naming that no Linq webhook came", async () => {
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "linq-live-check: FAIL: no signed reply in staging's logs within 2 s of the send: no Linq webhook reached staging",
    ]);
    expect(result.seen).toHaveLength(1);
    expectClean([...result.out, ...result.err]);
  });

  it("a reply whose signature did not hold on staging: FAIL at once, naming the webhook secret", async () => {
    const refused = tailEvent(WEBHOOK_URL, [
      receiveLine({
        outcome: "refused",
        decided: { signatureValid: false, answered: 401 },
        got: {},
        error_code: "badSignature",
      }),
    ]);
    const result = await run({}, { after: refused });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `linq-live-check: FAIL: a Linq webhook reached staging after the send, but its signature did not hold (badSignature): staging's LINQ_WEBHOOK_SECRET is not the secret Linq signs with (trace id ${REPLY_TRACE})`,
    ]);
    expectClean([...result.out, ...result.err]);
  });

  it("a reply staging could not write (503): FAIL once the wait ends, naming its outcome", async () => {
    const failed = tailEvent(WEBHOOK_URL, [
      receiveLine({
        outcome: "failed",
        decided: { signatureValid: true, answered: 503 },
        error_code: "sealFailed",
      }),
    ]);
    const result = await run({}, { after: failed });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `linq-live-check: FAIL: no signed reply in staging's logs within 2 s of the send: a Linq webhook reached staging but was not written as a K-06 text (outcome failed, sealFailed, trace id ${REPLY_TRACE})`,
    ]);
  });

  it("the reply's event under two trace ids: FAIL", async () => {
    const split = tailEvent(WEBHOOK_URL, [receiveLine(), scrubLine({ trace_id: OTHER_TRACE })]);
    const result = await run({}, { after: split });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `linq-live-check: FAIL: the reply's spans in staging's logs carry 2 trace ids, not one (receive under ${REPLY_TRACE})`,
    ]);
  });

  it("a receive span with no scrub span after it: FAIL, its trace not shown whole", async () => {
    const result = await run({}, { after: tailEvent(WEBHOOK_URL, [receiveLine()]) });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `linq-live-check: FAIL: the reply's receive span came (trace id ${REPLY_TRACE}), but no scrub span of its event within 1 s, so its trace is not shown whole`,
    ]);
  });

  it("is not fooled by the test-phone page's text, a text from before the send, or another span", async () => {
    const before = tailEvent(WEBHOOK_URL, [receiveLine(), scrubLine()]);
    const after = [
      tailEvent(PAGE_URL, [receiveLine(), scrubLine()]),
      tailEvent(WEBHOOK_URL, [receiveLine({ at: new Date(NOW - 60_000).toISOString() }), scrubLine()]),
      tailEvent(null, [scrubLine({ hop: "safetyRead" })]),
    ].join("");
    const result = await run({}, { before, after });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "linq-live-check: FAIL: no signed reply in staging's logs within 2 s of the send: no Linq webhook reached staging",
    ]);
    expectClean([...result.out, ...result.err]);
  });

  it("staging's logs that end before the send: FAIL, and nothing is sent", async () => {
    const result = await run({}, { endTail: 1 });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "linq-live-check: FAIL: staging's logs could not be read: the tail ended (exit 1) before the send; run npm run cf -- tail --env staging by hand to see why; nothing was sent",
    ]);
    expect(result.seen).toEqual([]);
  });

  it("an error is printed by its name and message, every value masked", async () => {
    const result = await run({
      fetch: () => Promise.reject(new Error("unused")),
      now: () => {
        throw new Error(`a clock that names ${FAKE_KEY} and ${PHONE}`);
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["linq-live-check: failed: Error: a clock that names [key] and ***01"]);
    expect(result.seen).toEqual([]);
  });
});

describe("logs.mjs: staging's logs as wrangler tail prints them", () => {
  it("splits the events however the text is cut, and keeps each one's spans with its request's path", () => {
    // Words before the first event, and a value that does not parse between the two, are skipped.
    const text = `Connected, waiting for logs...\n${REPLY}{"broken": nope}\n${tailEvent(null, [scrubLine()])}`;
    for (const size of [1, 7, 64, text.length]) {
      const stream = new TailJsonStream();
      const events: Record<string, unknown>[] = [];
      for (let i = 0; i < text.length; i += size) events.push(...stream.push(text.slice(i, i + size)));
      expect(events).toHaveLength(2);
      const records = events.flatMap((event) => recordsOfTailEvent(event));
      expect(records.map((record) => [record.span.hop, record.span.trace_id, record.path])).toEqual([
        ["receive", REPLY_TRACE, `/test${LINQ_WEBHOOK_PATH}`],
        ["scrub", REPLY_TRACE, `/test${LINQ_WEBHOOK_PATH}`],
        ["scrub", REPLY_TRACE, null],
      ]);
    }
  });

  it("keeps spans alone: a log line that is no span, words with braces and quotes, a span given as an object", () => {
    const tricky = JSON.stringify({ level: "info", msg: "not a span", note: 'a "quoted" {brace} \\ and ]' });
    const event = {
      logs: [
        { message: [tricky, 42, null, "{not json", { msg: "span", hop: "receive" }], level: "log" },
        { message: [spanLine(SCRUB, { trace_id: REPLY_TRACE })], level: "log" },
        "not a log",
      ],
      event: { request: { url: "not a url" } },
    };
    const stream = new TailJsonStream();
    const [parsed] = stream.push(JSON.stringify(event, null, 2));
    expect(recordsOfTailEvent(parsed).map((record) => [record.span.hop, record.path])).toEqual([
      ["receive", null],
      ["scrub", null],
    ]);
    expect(recordsOfTailEvent(null)).toEqual([]);
  });

  it("gives the tail's process no name the check reads", () => {
    expect(
      tailEnv({ HOME: "/home/test", [NAMES.key]: FAKE_KEY, PATH: "/bin", EMPTY: undefined }, [NAMES.key]),
    ).toEqual({ HOME: "/home/test", PATH: "/bin" });
  });

  it("reads spans as they come, says when nothing came in time, and when the tail ended", async () => {
    const tail = new FakeTail();
    const { spawnProcess, calls } = fakeSpawn(tail);
    const logs = openStagingTail({ root: REPO, env: { HOME: "/home/test" }, spawnProcess });
    expect(calls.map((call) => [call.command, call.args, call.options.stdio])).toEqual([
      ["bash", [path.join(REPO, "infra", "scripts", "cf.sh"), ...TAIL_ARGS], ["ignore", "pipe", "pipe"]],
    ]);
    expect(await logs.read(10)).toEqual({ kind: "timeout" });
    tail.print(REPLY);
    const first = await logs.read(1_000);
    expect(first.kind === "record" ? first.record.span.hop : first.kind).toBe("receive");
    const second = await logs.read(1_000);
    expect(second.kind === "record" ? second.record.span.hop : second.kind).toBe("scrub");
    tail.end(3);
    expect(await logs.read(1_000)).toEqual({ kind: "ended", code: 3 });
    await logs.close();
    expect(tail.signals).toEqual([]);
  });
});

describe("run.mjs run as a script", () => {
  /** Runs `node run.mjs` in `cwd` with only PATH and `extra` in its environment. */
  function script(
    cwd: string,
    extra: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [SCRIPT],
        { cwd, env: { PATH: process.env.PATH ?? "", ...extra }, timeout: 50_000 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  it(
    "with no key: loads the adapters under Node, refuses, names the missing key and exits 1, with nothing sent",
    SLOW,
    async () => {
      const result = await script(empty, {});
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "linq-live-check: refused: LINQ_API_TOKEN is not set, in the environment or in .dev.vars in the folder this runs from",
      );
      expect(result.stderr).toContain("linq-live-check: nothing was sent");
      expect(result.stderr).not.toContain("failed:");
    },
  );

  it("with every value but the key: names the key alone, and never prints a value", SLOW, async () => {
    const values = Object.fromEntries(Object.entries(BASE_ENV).filter(([name]) => name !== NAMES.key));
    const result = await script(empty, values);
    expect(result.code).toBe(1);
    const refusals = result.stderr.split("\n").filter((line) => line.startsWith("linq-live-check: refused:"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("LINQ_API_TOKEN is not set");
    expectClean([result.stdout, result.stderr]);
  });

  it("the checkout it reads cf.sh and the samples from is this one", () => {
    expect(path.resolve(ROOT)).toBe(REPO);
  });
});
