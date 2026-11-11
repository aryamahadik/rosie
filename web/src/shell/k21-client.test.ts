// T-511's proof for the K-21 client a page gets from the shell: it sends each v1 call to the Tool API mock (C-186) and
// gets the fixture's response, under the page request's trace id; and a request no fixture holds fails loudly, never
// with a made-up answer. The requests are K-21 v1's own accepted fixtures (contracts/page-api/fixtures), each sent in
// the environment its `given` names, through a made-up feature folder's route.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ToolApiMockError } from "../../../contracts/mock/mock.mjs";
import { PAGE_CALLS, isPageCall, isPageError, type PageCall, type RequestOf } from "../client/calls";
import { PageApiError } from "../client/client";
import { renderErrorPage } from "./error-pages";
import type { RouteContext, RouteModule } from "./route";
import { TRACE_ID, get, testShell, type TestEnvironment } from "./test-support";

const FIXTURES = new URL("../../../contracts/page-api/fixtures/", import.meta.url);

interface IndexRow {
  file: string;
  version: string;
  def: string;
  expect: string;
}

/** One K-21 fixture: a request paired with its outcome, in the environment its given names. */
interface Exchange {
  file: string;
  call: PageCall;
  environment: TestEnvironment;
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));
}

/** Every accepted exchange fixture of K-21 v1, as the index lists them. */
const V1_EXCHANGES: Exchange[] = (readJson("index.json") as { fixtures: IndexRow[] }).fixtures
  .filter((row) => row.version === "v1" && row.expect === "accept" && row.def.endsWith(".exchange"))
  .map((row) => {
    const fixture = readJson(row.file) as {
      call: string;
      given: { environment: TestEnvironment };
      request: Record<string, unknown>;
      outcome: Record<string, unknown>;
    };
    if (!isPageCall(fixture.call) || `${fixture.call}.exchange` !== row.def)
      throw new Error(`${row.file}: its call is not the one its index row names`);
    return {
      file: row.file,
      call: fixture.call,
      environment: fixture.given.environment,
      request: fixture.request,
      outcome: fixture.outcome,
    };
  });

/** A made-up feature folder with one route, which runs what the test hands it with the route's context. */
function probe(run: (context: RouteContext) => Promise<unknown>): {
  module: RouteModule;
  results: unknown[];
} {
  const results: unknown[] = [];
  return {
    results,
    module: {
      folder: "example",
      stagingOnly: false,
      routes: [
        {
          label: "example.probe",
          path: "/example/probe",
          methods: ["GET"],
          handle: async (context) => {
            results.push(await run(context));
            return context.page({ title: "Probe", main: "<h1>Probe</h1>" });
          },
        },
      ],
    },
  };
}

/** One call through a route's client, with a request read from a fixture file. */
const send = (context: RouteContext, call: PageCall, request: unknown): Promise<unknown> =>
  context.client.call(call, request as RequestOf<PageCall>);

describe("the K-21 client sends each v1 call to the mock and gets the fixture's response", () => {
  it("has an accepted fixture for every call of K-21 v1", () => {
    expect(V1_EXCHANGES.length).toBeGreaterThanOrEqual(PAGE_CALLS.length);
    expect([...new Set(V1_EXCHANGES.map((exchange) => exchange.call))].sort()).toEqual(
      [...PAGE_CALLS].sort(),
    );
    expect([...new Set(V1_EXCHANGES.map((exchange) => exchange.environment))].sort()).toEqual([
      "production",
      "staging",
    ]);
  });

  it.each(V1_EXCHANGES)("$file: $call on $environment answers the fixture's outcome", async (exchange) => {
    const { module, results } = probe((context) => send(context, exchange.call, exchange.request));
    const { shell, transport, config } = testShell({ environment: exchange.environment, modules: [module] });
    const response = await shell.fetch(get(`${config.basePath}/example/probe`, { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(200);
    expect(results).toEqual([exchange.outcome]);
    // The call went to the mock as the page gave it, under the page request's own trace id.
    expect(transport.sent).toEqual([{ call: exchange.call, request: exchange.request, traceId: TRACE_ID }]);
  });

  it("tells a call's error from its response by the outcome's own error", () => {
    const outcomes = V1_EXCHANGES.map((exchange) => exchange.outcome);
    const errors = outcomes.filter((outcome) => isPageError(outcome));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThan(outcomes.length);
    for (const outcome of outcomes) expect(isPageError(outcome)).toBe(typeof outcome.error === "string");
  });

  it("gives a call's envelope the page request's trace id", async () => {
    const { module, results } = probe((context) =>
      Promise.resolve([
        context.traceId,
        context.client.traceId,
        context.envelope({ requestId: "req-example-0001", sessionToken: null, linkCode: "dummy-code-01" }),
      ]),
    );
    await testShell({ modules: [module] }).shell.fetch(
      get("/test/example/probe", { "x-trace-id": TRACE_ID }),
    );
    expect(results).toEqual([
      [
        TRACE_ID,
        TRACE_ID,
        { requestId: "req-example-0001", traceId: TRACE_ID, sessionToken: null, linkCode: "dummy-code-01" },
      ],
    ]);
  });
});

describe("an unmatched request fails loudly", () => {
  const OPEN_LINK = V1_EXCHANGES.find((exchange) => exchange.file === "open-link-secure-page.json");
  if (OPEN_LINK === undefined) throw new Error("open-link-secure-page.json is not among K-21 v1's fixtures");
  /** The fixture's request with one field changed: a request no fixture holds. */
  const CHANGED = { page: { ...(OPEN_LINK.request.page as object), requestId: "req-no-fixture-holds-this" } };

  it("rejects with the mock's own error naming the call, and the test shell lets it through", async () => {
    const { module, results } = probe((context) => send(context, "openLink", CHANGED));
    const { shell, transport } = testShell({ modules: [module] });
    const failed = await shell.fetch(get("/test/example/probe")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ToolApiMockError);
    expect((failed as ToolApiMockError).code).toBe("noFixture");
    expect((failed as ToolApiMockError).contract).toBe("page-api");
    expect((failed as ToolApiMockError).call).toBe("openLink");
    expect((failed as ToolApiMockError).message).toContain(
      "page-api openLink (staging): no fixture holds this request",
    );
    expect(results).toEqual([]);
    expect(transport.sent.map((sent) => sent.call)).toEqual(["openLink"]);
  });

  it("is a request sent in an environment its fixture does not name, too", async () => {
    const { module, results } = probe((context) => send(context, "openLink", OPEN_LINK.request));
    const { shell } = testShell({ environment: "production", modules: [module] });
    await expect(shell.fetch(get("/example/probe"))).rejects.toBeInstanceOf(ToolApiMockError);
    expect(results).toEqual([]);
  });

  it("gets no made-up answer on the Worker either: the handler's call rejects, and the reader gets the 500 page", async () => {
    const thrown: unknown[] = [];
    const { module, results } = probe((context) => send(context, "openLink", CHANGED));
    const { shell, lines } = testShell({ modules: [module], onRouteError: (error) => thrown.push(error) });
    const response = await shell.fetch(get("/test/example/probe", { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(
      renderErrorPage({ status: 500, basePath: "/test", traceId: TRACE_ID }),
    );
    expect(results).toEqual([]);
    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toBeInstanceOf(ToolApiMockError);
    expect(lines()).toEqual([
      { level: "error", msg: "page", trace_id: TRACE_ID, route: "example.probe", status: 500 },
    ]);
  });

  it("refuses a call K-21 v1 does not hold before anything is sent", async () => {
    const { module } = probe((context) => send(context, "notACall" as PageCall, OPEN_LINK.request));
    const { shell, transport } = testShell({ modules: [module] });
    const failed = await shell.fetch(get("/test/example/probe")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(PageApiError);
    expect((failed as PageApiError).code).toBe("unknownCall");
    expect(transport.sent).toEqual([]);
  });
});
