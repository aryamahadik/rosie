// The staging target against a stand-in staging Worker (T-465, "Proves it with": the staging target calls /health first
// and refuses to run unless environment is staging; no key is read: it sends only through K-21's test-phone-send). The
// stand-in answers /health as runtime/src/index.ts does and K-21 v1's two test-phone calls with their frozen fixtures
// (test-phone-send.json, test-phone-parts.json); nothing here reaches staging, so this runs in CI (DL-024). The page
// calls' route is T-266's and not named by K-21 v1: here a stand-in, /page/<call>. Run by `npm run test:e2e -- _driver`.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT } from "../../contract/_harness";
import {
  K21,
  StagingCallError,
  StagingRefusedError,
  asTrace,
  checkRun,
  openStagingTarget,
  schemaProblems,
  type Fetch,
  type StagingTargetOptions,
} from "./index";

const BASE = "https://rosie-staging.example.workers.dev/test";

function json(...parts: string[]): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_ROOT, ...parts), "utf8"));
}

interface Exchange {
  request: {
    page: { sessionToken: string };
    testPhoneId: string;
    words?: string;
    threadedReplyTo?: string | null;
  };
  outcome: Record<string, unknown>;
}

const sendExchange = json("page-api", "fixtures", "test-phone-send.json") as Exchange;
const partsExchange = json("page-api", "fixtures", "test-phone-parts.json") as Exchange;
const skeleton = asTrace(json("event-trace", "fixtures", "trace-skeleton.json"));
const SESSION = sendExchange.request.page.sessionToken;
const WORDS = sendExchange.request.words ?? "";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface StandIn {
  readonly fetch: Fetch;
  readonly seen: Seen[];
}

/** A staging Worker stand-in: /health as the Worker answers it, the two K-21 calls with their fixtures' outcomes. */
function standIn(
  health: { status?: number; body?: unknown } = {},
  answers: Partial<Record<"testPhoneSend" | "testPhoneParts", unknown>> = {},
): StandIn {
  const seen: Seen[] = [];
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return {
    seen,
    fetch(url, init = {}) {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      seen.push({ method: init.method ?? "GET", url, headers, body });
      if (url === `${BASE}/health`) {
        return Promise.resolve(
          reply(
            health.status ?? 200,
            health.body ?? {
              ok: true,
              service: "rosie",
              environment: "staging",
              version: "test-sha",
              trace_id: "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b",
            },
          ),
        );
      }
      if (url === `${BASE}/page/testPhoneSend`) {
        return Promise.resolve(reply(200, answers.testPhoneSend ?? sendExchange.outcome));
      }
      if (url === `${BASE}/page/testPhoneParts`) {
        return Promise.resolve(reply(200, answers.testPhoneParts ?? partsExchange.outcome));
      }
      return Promise.resolve(reply(404, { ok: false, error: "not_found" }));
    },
  };
}

function options(server: StandIn, more: Partial<StagingTargetOptions> = {}): StagingTargetOptions {
  return {
    baseUrl: `${BASE}/`,
    sessionToken: SESSION,
    pageCallPath: (call) => `/page/${call}`,
    fetch: server.fetch,
    env: {},
    ...more,
  };
}

async function refusal(promise: Promise<unknown>): Promise<StagingRefusedError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof StagingRefusedError)) throw new Error("the staging target did not refuse");
  return error;
}

describe("the staging target calls /health first", () => {
  it.each([
    ["production", { ok: true, environment: "production", version: "v", trace_id: "t" }],
    ["preview", { ok: true, environment: "preview", version: "v", trace_id: "t" }],
    ["(none)", { ok: true, version: "v", trace_id: "t" }],
  ])("and refuses to run when /health reports environment %s, sending nothing", async (environment, body) => {
    const server = standIn({ body });
    const error = await refusal(openStagingTarget(options(server)));
    expect(error.reason).toBe("notStaging");
    expect(error.environment).toBe(environment === "(none)" ? null : environment);
    expect(error.message).toContain(`environment ${environment}`);
    expect(server.seen.map((request) => [request.method, request.url])).toEqual([["GET", `${BASE}/health`]]);
  });

  it("and refuses to run when /health does not answer ok, sending nothing", async () => {
    for (const health of [
      { status: 503, body: { ok: false } },
      { status: 200, body: "not json" },
    ]) {
      const server = standIn(health);
      expect((await refusal(openStagingTarget(options(server)))).reason).toBe("health");
      expect(server.seen).toHaveLength(1);
    }
    const unreachable: Fetch = () => Promise.reject(new TypeError("fetch failed"));
    expect((await refusal(openStagingTarget({ ...options(standIn()), fetch: unreachable }))).reason).toBe(
      "health",
    );
  });

  it("and never runs in CI: refused before any request (DL-024)", async () => {
    const server = standIn();
    const error = await refusal(openStagingTarget(options(server, { env: { CI: "true" } })));
    expect(error.reason).toBe("ci");
    expect(server.seen).toEqual([]);
  });

  it("then, on staging, keeps what /health answered", async () => {
    const server = standIn();
    const target = await openStagingTarget(options(server));
    expect(target.health).toEqual({
      environment: "staging",
      version: "test-sha",
      traceId: "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b",
    });
    expect(server.seen.map((request) => [request.method, request.url])).toEqual([["GET", `${BASE}/health`]]);
  });
});

describe("no key is read by the staging target: it sends only through K-21's testPhoneSend", () => {
  it("sends a test phone's text as a K-21 v1 testPhoneSend request, after /health, and nothing else", async () => {
    const server = standIn();
    const target = await openStagingTarget(options(server));
    const sent = await target.sendText({
      testPhoneId: "tp-04",
      words: WORDS,
      threadedReplyTo: sendExchange.request.threadedReplyTo ?? null,
    });
    expect(sent).toEqual({
      target: "staging",
      eventId: "evt-double-0104-0001",
      traceId: "trace-double-0104-0001",
      gatewayStatus: 200,
    });
    expect(server.seen.map((request) => [request.method, request.url])).toEqual([
      ["GET", `${BASE}/health`],
      ["POST", `${BASE}/page/testPhoneSend`],
    ]);
    const posted = server.seen[1];
    expect(schemaProblems(K21, "testPhoneSend.request", posted?.body)).toEqual([]);
    expect(posted?.body).toMatchObject({
      testPhoneId: "tp-04",
      page: { sessionToken: SESSION, linkCode: null },
    });
    for (const request of server.seen) {
      expect(Object.keys(request.headers).filter((name) => name.startsWith("webhook-"))).toEqual([]);
      expect(request.url).not.toContain("/webhooks/");
    }
  });

  it("reads only CI from the environment", async () => {
    const reads: string[] = [];
    const env = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get(store, name, receiver): unknown {
          if (typeof name === "string") reads.push(name);
          return Reflect.get(store, name, receiver) as unknown;
        },
      },
    );
    const target = await openStagingTarget(options(standIn(), { env }));
    await target.sendText({ testPhoneId: "tp-04", words: WORDS });
    expect(reads).toEqual(["CI"]);
  });

  it("never sends a request K-21 v1 refuses", async () => {
    const server = standIn();
    const target = await openStagingTarget(options(server));
    await expect(target.sendText({ testPhoneId: "tp-04", words: "" })).rejects.toThrow(
      /testPhoneSend: the request is not K-21 v1's, so it was not sent/,
    );
    expect(server.seen).toHaveLength(1);
  });

  it("gives K-21's error answer as a StagingCallError, with neither the session token nor the words in it", async () => {
    const server = standIn({}, { testPhoneSend: { error: "stagingOnly" } });
    const target = await openStagingTarget(options(server));
    const error: unknown = await target
      .sendText({ testPhoneId: "tp-04", words: WORDS })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(StagingCallError);
    expect(error).toMatchObject({ call: "testPhoneSend", status: 200, error: "stagingOnly" });
    expect(String(error)).not.toContain(SESSION);
    expect(String(error)).not.toContain(WORDS);
  });

  it("refuses an answer K-21 v1 does not define", async () => {
    const server = standIn({}, { testPhoneSend: { result: "sent" } });
    const target = await openStagingTarget(options(server));
    await expect(target.sendText({ testPhoneId: "tp-04", words: WORDS })).rejects.toMatchObject({
      name: "StagingCallError",
      error: null,
    });
  });
});

describe("what the staging target collects", () => {
  it("reads the parts the Linq double sent to the test phone through K-21's testPhoneParts", async () => {
    const server = standIn();
    const target = await openStagingTarget(options(server));
    const collected = await target.collect("trace-alex-a7-03", "tp-03");
    expect(collected.parts.map((part) => [part.sent.idempotencyKey, part.outcome?.result])).toEqual([
      ["out-a7-03-alex/1/1", "accepted"],
      ["out-a7-03-alex/2/1", "accepted"],
    ]);
    expect(collected.outbox).toBeNull();
    expect(collected.linqEvents).toBeNull();
    expect(collected.trace).toBeNull();
    expect(collected.traceProblems).toEqual([
      "no span reader: trace trace-alex-a7-03 is in Workers Logs, read on the build Mac (DL-024)",
    ]);
    const posted = server.seen[1];
    expect(posted?.url).toBe(`${BASE}/page/testPhoneParts`);
    expect(schemaProblems(K21, "testPhoneParts.request", posted?.body)).toEqual([]);
  });

  it("reads the trace by its id from the span log lines it is given, and checks the hops", async () => {
    const lines = skeleton.spans.map((span) =>
      JSON.stringify({ level: "info", msg: "span", ...span, environment: "staging", version: "test-sha" }),
    );
    const target = await openStagingTarget(options(standIn(), { spans: () => lines }));
    const collected = await target.collect(skeleton.trace_id, "tp-03");
    expect(collected.trace).toEqual(skeleton);
    const report = checkRun(collected);
    expect(report.problems).toEqual([]);
    expect(report.parts).toEqual({
      parts: 2,
      sends: 2,
      duplicateSends: [],
      unjudgedSends: [],
      repeatedKeys: [],
    });
  });
});
