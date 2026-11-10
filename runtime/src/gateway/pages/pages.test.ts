// The page entry held to the frozen contracts (T-266), run under Node because Ajv cannot run in the Workers runtime: its
// calls and staging-only calls are K-21 v1's own enums (`$defs/callName`, `$defs/stagingOnlyCall`), its stagingOnly
// answer is fire-now-in-production.json's outcome, and every span it writes, and the trace a handler is handed, pass
// K-08 v1's `$defs/span` and `$defs/trace`. The entry runs as the Worker runs it, with the same stubs as the Workers tests.
import { afterEach, describe, expect, it, vi } from "vitest";

import fireNowInProduction from "../../../../contracts/page-api/fixtures/fire-now-in-production.json";
import { readContractJson, schemaErrors } from "../../trace/test-support";
import type { TraceContext } from "../../trace";
import {
  PAGE_CALLS,
  STAGING_ONLY_CALLS,
  STAGING_ONLY_OUTCOME,
  handlePageCall,
  pagePathOf,
  pageRouteOf,
  unconfiguredPages,
  type PageCallName,
  type PageDeps,
  type PageHandlers,
} from ".";
import { captureLogLines, pagePost, pageSpans, recordingPages } from "./test-support";

const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };
const NOW = Date.parse("2026-11-10T09:00:00Z");
const STAGING = { environment: "staging", version: "test-sha" };
const PRODUCTION = { environment: "production", version: "test-sha" };
const REQUEST = {
  page: { requestId: "req-0001", traceId: "trace-0001", sessionToken: null, linkCode: null },
};

interface K21Schema {
  $defs: { callName: { enum: string[] }; stagingOnlyCall: { enum: string[] } };
}

const k21 = readContractJson("page-api/page-api.v1.schema.json") as K21Schema;

function depsWith(handlers: PageHandlers): PageDeps {
  return { handlers, bundleId: () => BUNDLE, now: () => NOW };
}

/** A span's own fields: its log line without what the log sink adds beside it (level, msg, environment, version). */
function spanOf(line: Record<string, unknown>): Record<string, unknown> {
  const span = { ...line };
  delete span.level;
  delete span.msg;
  delete span.environment;
  delete span.version;
  return span;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the page entry's calls are K-21 v1's", () => {
  it("routes exactly the calls of `$defs/callName`, in its order", () => {
    expect([...PAGE_CALLS]).toEqual(k21.$defs.callName.enum);
  });

  it("refuses outside staging exactly the calls of `$defs/stagingOnlyCall`", () => {
    expect([...STAGING_ONLY_CALLS]).toEqual(k21.$defs.stagingOnlyCall.enum);
  });

  it("answers them there as fire-now-in-production.json's outcome", () => {
    expect(STAGING_ONLY_OUTCOME).toEqual(fireNowInProduction.outcome);
  });

  it("gives each call one path under BASE_PATH, and a path back its call only", () => {
    for (const call of PAGE_CALLS) {
      expect(pagePathOf(call)).toBe(`/page-api/${call}`);
      expect(pageRouteOf(pagePathOf(call))).toBe(call);
      expect(pageRouteOf(`${pagePathOf(call)}/`)).toBeNull();
      expect(pageRouteOf(`/page-api/${call.toLowerCase()}`)).toBeNull();
      expect(pageRouteOf(`/page-api/${call.toUpperCase()}`)).toBeNull();
    }
    for (const path of [
      "",
      "/",
      "/page-api",
      "/page-api/",
      "/page-api/hasOwnProperty",
      "/page-api/__proto__",
    ]) {
      expect(pageRouteOf(path), path).toBeNull();
    }
  });

  it("has a not-connected stub for every call", () => {
    expect(Object.keys(unconfiguredPages()).sort()).toEqual([...PAGE_CALLS].sort());
  });
});

describe("every span the page entry writes is a K-08 v1 span", () => {
  /** Each way a call ends, posted as the Worker posts it, with what it is: its environment, body and handlers. */
  const cases: {
    name: string;
    call: PageCallName;
    where: typeof STAGING;
    body: unknown;
    handlers: PageHandlers;
    outcome: string;
  }[] = [
    {
      name: "a response",
      call: "openLink",
      where: STAGING,
      body: REQUEST,
      handlers: recordingPages().handlers,
      outcome: "ok",
    },
    {
      name: "one of the call's errors",
      call: "signOut",
      where: STAGING,
      body: REQUEST,
      handlers: recordingPages(() => Promise.resolve({ error: "signInNeeded" })).handlers,
      outcome: "refused",
    },
    {
      name: "transient",
      call: "teamConsole",
      where: STAGING,
      body: REQUEST,
      handlers: recordingPages(() => Promise.resolve({ error: "transient" })).handlers,
      outcome: "failed",
    },
    {
      name: "stagingOnly in production",
      call: "fireNow",
      where: PRODUCTION,
      body: REQUEST,
      handlers: recordingPages().handlers,
      outcome: "refused",
    },
    {
      name: "a body that is not JSON",
      call: "testPhoneSend",
      where: STAGING,
      body: "not json",
      handlers: recordingPages().handlers,
      outcome: "refused",
    },
    {
      name: "a handler not connected",
      call: "testPhoneParts",
      where: STAGING,
      body: REQUEST,
      handlers: unconfiguredPages(),
      outcome: "failed",
    },
    {
      name: "a handler that answers no object",
      call: "billCard",
      where: STAGING,
      body: REQUEST,
      handlers: recordingPages(() => Promise.resolve([] as unknown as Record<string, unknown>)).handlers,
      outcome: "failed",
    },
  ];

  it.each(cases)(
    "$name: one pageRequest span, accepted by K-08 v1",
    async ({ call, where, body, handlers, outcome }) => {
      const logLines = captureLogLines();

      const response = await handlePageCall(
        pagePost(pagePathOf(call), body),
        call,
        depsWith(handlers),
        where,
      );

      const spans = pageSpans(logLines());
      expect(spans).toHaveLength(1);
      const span = spanOf(spans[0] ?? {});
      expect(schemaErrors("span", span)).toEqual([]);
      expect(span).toMatchObject({
        trace_id: response.headers.get("x-trace-id"),
        outcome,
        bundle_id: BUNDLE,
      });
    },
  );

  it("the trace a handler is handed is a K-08 v1 trace opened by pageRequest, with the entry's span on it", async () => {
    captureLogLines();
    const handed: { trace?: TraceContext } = {};
    const stubs = recordingPages((page) => {
      handed.trace = page.trace;
      return Promise.resolve({ result: "stub" });
    });

    const response = await handlePageCall(
      pagePost(pagePathOf("readStaffPage"), REQUEST),
      "readStaffPage",
      depsWith(stubs.handlers),
      STAGING,
    );

    const trace = handed.trace?.toTrace();
    expect(schemaErrors("trace", trace)).toEqual([]);
    expect(trace).toMatchObject({
      trace_id: response.headers.get("x-trace-id"),
      opened_by: "pageRequest",
      bundle_id: BUNDLE,
      job_id: null,
      spans: [{ hop: "pageRequest", seq: 1, got: { pageCall: "readStaffPage" } }],
    });
  });
});
