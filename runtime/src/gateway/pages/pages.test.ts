// The page entry held to the frozen contracts (T-266), run under Node because Ajv cannot run in the Workers runtime: its
// calls and staging-only calls are K-21 v1's own enums (`$defs/callName`, `$defs/stagingOnlyCall`), its stagingOnly
// answer is fire-now-in-production.json's outcome, and every span it writes, and the trace a handler is handed, pass
// K-08 v1's `$defs/span` and `$defs/trace`. The entry runs as the Worker runs it, with the same stubs as the Workers tests.
// T-1180: the error names its span takes are every name K-21 v1's `<call>.errors` can carry, and its body cap is larger
// than every K-21 fixture's request.
import { afterEach, describe, expect, it, vi } from "vitest";

import fireNowInProduction from "../../../../contracts/page-api/fixtures/fire-now-in-production.json";
import { readContractJson, schemaErrors } from "../../trace/test-support";
import type { TraceContext } from "../../trace";
import { PAGE_BODY_LIMIT_BYTES } from "../body";
import {
  PAGE_CALLS,
  PAGE_ERRORS,
  STAGING_ONLY_CALLS,
  STAGING_ONLY_OUTCOME,
  UNKNOWN_PAGE_ERROR,
  handlePageCall,
  isPageError,
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
  $defs: { callName: { enum: string[] }; stagingOnlyCall: { enum: string[] } } & Record<string, unknown>;
}

const k21 = readContractJson("page-api/page-api.v1.schema.json") as K21Schema;

/** Where every contract's `$id` lives, so a schema's relative `$ref` resolves as the contracts name each other. */
const CONTRACTS_BASE = "https://rosie.invalid/contracts/";
const K21_URL = new URL("page-api/page-api.v1.schema.json", CONTRACTS_BASE);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The schema node a resolved `$ref` names: its contract file, then its JSON pointer. A pointer to nothing throws. */
function nodeAt(target: URL): unknown {
  let node = readContractJson(target.pathname.slice("/contracts/".length));
  const pointer = decodeURIComponent(target.hash).replace(/^#\/?/u, "");
  for (const part of pointer === "" ? [] : pointer.split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) node = /^[0-9]+$/u.test(key) ? (node as unknown[])[Number(key)] : undefined;
    else node = isRecord(node) ? node[key] : undefined;
  }
  if (node === undefined) throw new Error(`no schema node at ${target.href}`);
  return node;
}

/**
 * Every `error` name a schema node can carry: its own `properties.error` (a const, or an enum), and each one it reaches
 * through `$ref`, `anyOf`, `oneOf` and `allOf`. An error whose name is not closed, or a `$ref` to nothing, throws.
 */
function errorNamesOf(node: unknown, base: URL): string[] {
  if (!isRecord(node)) throw new Error(`no schema node under ${base.href}`);
  const names: string[] = [];
  if (typeof node.$ref === "string") {
    const target = new URL(node.$ref, base);
    const file = new URL(target.href);
    file.hash = "";
    names.push(...errorNamesOf(nodeAt(target), file));
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = node[key];
    if (Array.isArray(list)) for (const item of list) names.push(...errorNamesOf(item, base));
  }
  const properties = node.properties;
  if (isRecord(properties) && "error" in properties) {
    const error = properties.error;
    if (isRecord(error) && typeof error.const === "string") names.push(error.const);
    else if (isRecord(error) && Array.isArray(error.enum)) names.push(...error.enum.map(String));
    else throw new Error(`an error with no closed name under ${base.href}`);
  }
  return names;
}

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

describe("the error names the span takes are K-21 v1's (T-1180)", () => {
  /** Every call's `<call>.errors`, by its call. */
  const errorsByCall = new Map(
    k21.$defs.callName.enum.map((call) => [call, errorNamesOf(k21.$defs[`${call}.errors`], K21_URL)]),
  );

  it("PAGE_ERRORS is every name a call's `<call>.errors` can carry, each once", () => {
    const names = new Set([...errorsByCall.values()].flat());

    expect([...PAGE_ERRORS].sort()).toEqual([...names].sort());
    expect(new Set(PAGE_ERRORS).size).toBe(PAGE_ERRORS.length);
    for (const [call, errors] of errorsByCall) expect(errors.length, call).toBeGreaterThan(0);
  });

  it("a handler's answer of each name, and of a name K-21 does not have, gives a span K-08 v1 accepts", async () => {
    const logLines = captureLogLines();
    const answers = [...PAGE_ERRORS, "notAK21Error"];

    for (const error of answers) {
      await handlePageCall(
        pagePost(pagePathOf("signOut"), REQUEST),
        "signOut",
        depsWith(recordingPages(() => Promise.resolve({ error })).handlers),
        STAGING,
      );
    }

    const spans = pageSpans(logLines()).map(spanOf);
    expect(spans.map((span) => span.error_code)).toEqual([...PAGE_ERRORS, UNKNOWN_PAGE_ERROR]);
    for (const span of spans) expect(schemaErrors("span", span), String(span.error_code)).toEqual([]);
    expect(isPageError(UNKNOWN_PAGE_ERROR)).toBe(false);
  });

  it("takes a name by its exact spelling only", () => {
    for (const value of [
      "LinkExpired",
      "linkexpired",
      " linkExpired",
      "linkExpired ",
      "constructor",
      "__proto__",
      "toString",
      "",
      null,
      undefined,
      7,
      ["linkExpired"],
      { error: "linkExpired" },
    ]) {
      expect(isPageError(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("the body cap is larger than every K-21 fixture's request (T-1180)", () => {
  interface FixtureIndex {
    fixtures: { file: string; version: string; def: string }[];
  }

  it("every fixture of index.json, every version, sends a request under PAGE_BODY_LIMIT_BYTES", () => {
    const index = readContractJson("page-api/fixtures/index.json") as FixtureIndex;
    const sizes = index.fixtures.map(({ file, def }) => {
      const json = readContractJson(`page-api/fixtures/${file}`);
      const request = def.endsWith(".exchange") && isRecord(json) ? json.request : json;
      return { file, bytes: new TextEncoder().encode(JSON.stringify(request)).byteLength };
    });

    expect(sizes.length).toBeGreaterThan(41);
    for (const { file, bytes } of sizes) {
      expect(bytes, file).toBeGreaterThan(2);
      expect(bytes, file).toBeLessThan(PAGE_BODY_LIMIT_BYTES);
    }
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
