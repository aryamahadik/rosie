// T-522's proof that a server refusal in refuse-fire-now-in-production.json's shape is shown as refused: never as a
// success, never as a blank page.
//
// That fixture (contracts/page-api/fixtures/invalid/) is fire-now.json's exchange run in production with the clock row
// fired, which K-21 v1's schema refuses: in production the only answer is { "error": "stagingOnly" }
// (fire-now-in-production.json, the same request). So its request is sent here through the typed K-21 client over the
// Tool API mock, as T-511's tests send a call, to a server that is not staging, and the refusal that comes back must
// show as the refused page. The tool is made up, written as a test tool's routes.ts would write it; every request
// value is a fixture's placeholder (rule 9).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPageError, type OutcomeOf, type PageCall, type RequestOf } from "../../client/calls";
import { mockTransport, type MockTransport } from "../../client/test-support";
import { readWebConfig } from "../../shell/config";
import { REFERENCE_LABEL, renderErrorPage } from "../../shell/error-pages";
import type { RouteModule } from "../../shell/route";
import { createWebShell, type PageLogLine, type WebShell } from "../../shell/shell";
import { TEST_LINK_HOST, TRACE_ID, rethrow, testVars, type TestEnvironment } from "../../shell/test-support";
import {
  REFUSED_STATUS,
  REFUSED_WORDS,
  STAGING_ONLY_ERROR,
  isStagingOnlyRefusal,
  refusedPage,
  stagingOnlyRoutes,
} from "./index";

const FIXTURES = new URL("../../../../contracts/page-api/fixtures/", import.meta.url);

interface IndexRow {
  file: string;
  version: string;
  def: string;
  expect: string;
}

/** One K-21 fixture: a request paired with its outcome, in the environment its given names. */
interface Exchange {
  call: string;
  given: { environment: TestEnvironment };
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));
}
const exchangeOf = (file: string): Exchange => readJson(file) as Exchange;

const INDEX = (readJson("index.json") as { fixtures: IndexRow[] }).fixtures;
const rowOf = (file: string): IndexRow | undefined => INDEX.find((row) => row.file === file);

/** The exchange the schema refuses: Fire now answered as fired, in production. */
const REFUSED_BY_SCHEMA = "invalid/refuse-fire-now-in-production.json";
/** The same request's only answer in production. */
const ANSWER_IN_PRODUCTION = "fire-now-in-production.json";
/** The same request's answer on staging. */
const FIRED_ON_STAGING = "fire-now.json";

/** K-21 v1's staging-only calls (contracts/page-api/README.md, "Staging only"). */
const STAGING_ONLY_CALLS = [
  "testRoster",
  "testPhoneSend",
  "testPhoneParts",
  "testClockRows",
  "fireNow",
  "textHoursOverride",
] as const satisfies readonly PageCall[];
type StagingOnlyCall = (typeof STAGING_ONLY_CALLS)[number];

/**
 * Each staging-only call's refusal, as K-21 v1 types that call's outcome: this stops compiling if one of them loses
 * its stagingOnly error.
 */
const REFUSALS: { [C in StagingOnlyCall]: Extract<OutcomeOf<C>, { error: "stagingOnly" }> } = {
  testRoster: { error: "stagingOnly" },
  testPhoneSend: { error: "stagingOnly" },
  testPhoneParts: { error: "stagingOnly" },
  testClockRows: { error: "stagingOnly" },
  fireNow: { error: "stagingOnly" },
  textHoursOverride: { error: "stagingOnly" },
};

const FIRE_NOW_PATH = "/console/team/example-fire-now";

/** A made-up Fire now tool: one guarded route that makes the call and shows what came back. */
function fireNowTool(
  request: unknown,
  marked: boolean,
): { outcomes: OutcomeOf<"fireNow">[]; module: RouteModule } {
  const outcomes: OutcomeOf<"fireNow">[] = [];
  const routes = stagingOnlyRoutes([
    {
      label: "example.fireNow",
      path: FIRE_NOW_PATH,
      methods: ["POST"],
      handle: async (context) => {
        const outcome = await context.client.call("fireNow", request as RequestOf<"fireNow">);
        outcomes.push(outcome);
        if (isStagingOnlyRefusal(outcome)) return refusedPage(context);
        if (isPageError(outcome))
          return context.page({ title: "Not fired", main: "<h1>Not fired</h1>", status: 409 });
        return context.page({ title: "Fired", main: `<h1>Fired</h1>\n<p>${outcome.result}</p>` });
      },
    },
  ]);
  return { outcomes, module: { folder: "console/team/example-fire-now", stagingOnly: marked, routes } };
}

/** A web app in `web` whose K-21 calls reach a server that answers as `server` does (the Tool API mock). */
function webOn(
  web: TestEnvironment,
  server: TestEnvironment,
  module: RouteModule,
): { shell: WebShell; transport: MockTransport; basePath: string; lines: () => PageLogLine[] } {
  const transport = mockTransport(server);
  const raw: string[] = [];
  const config = readWebConfig(testVars(web));
  const shell = createWebShell({
    config,
    transport,
    modules: [module],
    log: (line) => raw.push(line),
    onRouteError: rethrow,
  });
  return {
    shell,
    transport,
    basePath: config.basePath,
    lines: () => raw.map((line) => JSON.parse(line) as PageLogLine),
  };
}

/** What a POST to a route that is meant to answer carries: this site's own Origin (shell/post-guard.ts; T-520). */
const SAME_ORIGIN = { origin: `https://${TEST_LINK_HOST}` };

/** The tester presses Fire now: a POST to the tool's route, under the tests' trace id, with the headers given. */
const press = (basePath: string, headers: Record<string, string> = {}): Request =>
  new Request(`https://${TEST_LINK_HOST}${basePath}${FIRE_NOW_PATH}`, {
    method: "POST",
    headers: { "x-trace-id": TRACE_ID, ...headers },
  });

describe("a server refusal in refuse-fire-now-in-production.json's shape is shown as refused", () => {
  it("the shape: Fire now's request in production, where the schema refuses the fired answer and stagingOnly is the only one", () => {
    const refused = exchangeOf(REFUSED_BY_SCHEMA);
    const answer = exchangeOf(ANSWER_IN_PRODUCTION);
    const fired = exchangeOf(FIRED_ON_STAGING);
    expect(rowOf(REFUSED_BY_SCHEMA)).toMatchObject({
      version: "v1",
      def: "fireNow.exchange",
      expect: "refuse",
    });
    expect(rowOf(ANSWER_IN_PRODUCTION)).toMatchObject({
      version: "v1",
      def: "fireNow.exchange",
      expect: "accept",
    });
    expect([refused.call, refused.given.environment]).toEqual(["fireNow", "production"]);
    expect([answer.call, answer.given.environment]).toEqual(["fireNow", "production"]);
    expect(answer.request).toEqual(refused.request);
    expect(answer.outcome).toEqual({ error: STAGING_ONLY_ERROR });
    // What the schema refuses in production is staging's own success.
    expect([fired.call, fired.given.environment]).toEqual(["fireNow", "staging"]);
    expect(refused.request).toEqual(fired.request);
    expect(refused.outcome).toEqual(fired.outcome);
    expect(fired.outcome.result).toBe("fired");
  });

  it("its request, sent through the typed K-21 client to a server that is not staging, comes back stagingOnly and shows the refused page: 403, inside the frame, with the trace id", async () => {
    const { request } = exchangeOf(REFUSED_BY_SCHEMA);
    const { outcomes, module } = fireNowTool(request, true);
    const { shell, transport, basePath, lines } = webOn("staging", "production", module);
    const response = await shell.fetch(press(basePath, SAME_ORIGIN));
    // The call went to the mock as the fixture holds it, and the server refused it.
    expect(transport.sent).toEqual([{ call: "fireNow", request, traceId: TRACE_ID }]);
    expect(outcomes).toEqual([{ error: "stagingOnly" }]);
    // Shown as refused: not a success.
    expect(response.status).toBe(403);
    expect(response.status).toBe(REFUSED_STATUS);
    expect(response.ok).toBe(false);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(response.headers.has("set-cookie")).toBe(false);
    // And not a blank page: a whole page inside the frame that says so.
    const html = await response.text();
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n')).toBe(true);
    expect(html).toContain("<title>Refused</title>");
    expect(html).toContain(
      [
        '<main id="main" tabindex="-1">',
        "<h1>Refused</h1>",
        "<p>The server refused this: it runs on staging only.</p>",
        "<p>Nothing was done.</p>",
        `<p>${REFERENCE_LABEL}: <code>${TRACE_ID}</code></p>`,
        "</main>",
      ].join("\n"),
    );
    expect(html).toContain(`<h1>${REFUSED_WORDS.title}</h1>`);
    for (const line of REFUSED_WORDS.lines) expect(html).toContain(`<p>${line}</p>`);
    expect(html).not.toMatch(/fired/i);
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: TRACE_ID, route: "example.fireNow", status: 403 },
    ]);
  });

  it("on staging the same request fires and the tool shows its own page: only the refusal is shown as refused", async () => {
    const fired = exchangeOf(FIRED_ON_STAGING);
    const { outcomes, module } = fireNowTool(fired.request, true);
    const { shell, basePath } = webOn("staging", "staging", module);
    const response = await shell.fetch(press(basePath, SAME_ORIGIN));
    expect(outcomes).toEqual([fired.outcome]);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Fired</h1>\n<p>fired</p>");
    expect(html).not.toContain(REFUSED_WORDS.title);
  });

  it.each([
    { layers: "the shell's check and the guard", marked: true },
    { layers: "the guard alone", marked: false },
  ])(
    "in production the tool is not there to make the call ($layers): the shell's 404, nothing sent, nothing to show",
    async ({ marked }) => {
      const { outcomes, module } = fireNowTool(exchangeOf(REFUSED_BY_SCHEMA).request, marked);
      const { shell, transport, basePath } = webOn("production", "production", module);
      const response = await shell.fetch(press(basePath));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(renderErrorPage({ status: 404, basePath, traceId: TRACE_ID }));
      expect(transport.sent).toEqual([]);
      expect(outcomes).toEqual([]);
    },
  );
});

describe("isStagingOnlyRefusal: the server's refusal of a staging-only call, and nothing else", () => {
  it("is true for each staging-only call's stagingOnly error", () => {
    for (const call of STAGING_ONLY_CALLS) expect(isStagingOnlyRefusal(REFUSALS[call]), call).toBe(true);
    expect(isStagingOnlyRefusal({ error: "stagingOnly", more: "dummy" })).toBe(true);
  });

  it("is false for any other error, for every response and for a value that only looks like it", () => {
    const others: object[] = [
      exchangeOf(FIRED_ON_STAGING).outcome,
      exchangeOf(REFUSED_BY_SCHEMA).outcome,
      { error: "signInNeeded" },
      { error: "notTester" },
      { error: "transient" },
      { error: "StagingOnly" },
      { error: "stagingOnly " },
      { error: ["stagingOnly"] },
      { error: null },
      { result: "stagingOnly" },
      { outcome: { error: "stagingOnly" } },
      Object.create({ error: "stagingOnly" }) as object,
      ["stagingOnly"],
      {},
    ];
    for (const [at, outcome] of others.entries())
      expect(isStagingOnlyRefusal(outcome), `item ${String(at)}`).toBe(false);
  });

  it("finds every stagingOnly answer K-21's accepted fixtures hold, each a staging-only call in production", () => {
    const refusals: string[] = [];
    for (const row of INDEX.filter(
      (listed) => listed.expect === "accept" && listed.def.endsWith(".exchange"),
    )) {
      const exchange = exchangeOf(row.file);
      expect(isStagingOnlyRefusal(exchange.outcome), row.file).toBe(exchange.outcome.error === "stagingOnly");
      if (!isStagingOnlyRefusal(exchange.outcome)) continue;
      refusals.push(row.file);
      expect(exchange.given.environment, row.file).toBe("production");
      expect(STAGING_ONLY_CALLS as readonly string[], row.file).toContain(exchange.call);
    }
    expect(refusals).toContain(ANSWER_IN_PRODUCTION);
  });
});
