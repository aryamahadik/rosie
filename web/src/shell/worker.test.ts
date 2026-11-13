// The web app's Worker entry (T-511): fetch(request, env) serves pages under the BASE_PATH the Worker's vars give,
// through the shell, with the transport made for that config; and vars the web app cannot run on fail closed, with the
// trace id and one log line still there.
import { describe, expect, it } from "vitest";
import { mockTransport } from "../client/test-support";
import { renderPrivacyPage } from "../pages/privacy/page";
import type { WebConfig } from "./config";
import { renderErrorPage } from "./error-pages";
import type { RouteModule } from "./route";
import type { PageLogLine } from "./shell";
import { TRACE_ID, UUID, get, testVars } from "./test-support";
import { CONFIG_LABEL, createWebWorker, type WebWorker } from "./worker";

/** A made-up feature folder whose page shows what the config holds. */
const EXAMPLE: RouteModule = {
  folder: "example",
  stagingOnly: false,
  routes: [
    {
      label: "example.config",
      path: "/example/config",
      methods: ["GET"],
      handle: (context) =>
        context.page({
          title: "Config",
          main: `<h1>${context.config.linkHost}${context.config.basePath}</h1>`,
        }),
    },
  ],
};

/** A Worker entry on the Tool API mock, with what it logged and each config its transport was made for. */
function testWorker(): { worker: WebWorker; lines: () => PageLogLine[]; configs: WebConfig[] } {
  const raw: string[] = [];
  const configs: WebConfig[] = [];
  const worker = createWebWorker({
    modules: [EXAMPLE],
    log: (line) => raw.push(line),
    transport: (config) => {
      configs.push(config);
      return mockTransport(config.staging ? "staging" : "production");
    },
  });
  return { worker, lines: () => raw.map((line) => JSON.parse(line) as PageLogLine), configs };
}

describe("the Worker entry serves pages under BASE_PATH, from the Worker's vars", () => {
  it("serves the privacy notice at /test/privacy with staging's vars and at /privacy with production's", async () => {
    const { worker, lines } = testWorker();
    const staging = await worker.fetch(get("/test/privacy", { "x-trace-id": TRACE_ID }), testVars("staging"));
    expect(staging.status).toBe(200);
    expect(staging.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await staging.text()).toBe(renderPrivacyPage("/test"));

    const production = testVars("production");
    expect((await worker.fetch(get("/privacy"), production)).status).toBe(200);
    const missing = await worker.fetch(get("/test/privacy", { "x-trace-id": TRACE_ID }), production);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(renderErrorPage({ status: 404, basePath: "", traceId: TRACE_ID }));
    expect(lines().map((line) => [line.route, line.status])).toEqual([
      ["privacy", 200],
      ["privacy", 200],
      ["notFound", 404],
    ]);
  });

  it("hands a route the config the vars gave: the link host and BASE_PATH", async () => {
    const { worker } = testWorker();
    const vars = { ENVIRONMENT: "staging", BASE_PATH: "/x-1", LINK_HOST: "links.example.test" };
    const response = await worker.fetch(get("/x-1/example/config"), vars);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>links.example.test/x-1</h1>");
  });

  it("makes one shell, and one transport, for each env it is handed", async () => {
    const { worker, configs } = testWorker();
    const vars = testVars("staging");
    await worker.fetch(get("/test/privacy"), vars);
    await worker.fetch(get("/test/unknown"), vars);
    expect(configs).toHaveLength(1);
    await worker.fetch(get("/privacy"), testVars("production"));
    expect(configs.map((config) => config.environment)).toEqual(["staging", "production"]);
  });
});

describe("vars the web app cannot run on fail closed", () => {
  it.each([
    ["no LINK_HOST", { ENVIRONMENT: "staging", BASE_PATH: "/test" }],
    ["a LINK_HOST with a path", { ENVIRONMENT: "staging", BASE_PATH: "/test", LINK_HOST: "example.test/x" }],
    [
      "a BASE_PATH that is not one",
      { ENVIRONMENT: "staging", BASE_PATH: "//example.test", LINK_HOST: "example.test" },
    ],
    ["no vars at all", {}],
  ])("%s: a plain 500 with the trace id and one line, and no page", async (_name, vars) => {
    const { worker, lines, configs } = testWorker();
    for (const path of ["/test/privacy", "/test/unknown"]) {
      const response = await worker.fetch(get(path, { "x-trace-id": TRACE_ID }), vars);
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(await response.text()).toBe("The page could not be shown.\n");
    }
    const line = { level: "error", msg: "page", trace_id: TRACE_ID, route: CONFIG_LABEL, status: 500 };
    expect(lines()).toEqual([line, line]);
    expect(configs).toEqual([]);
  });

  it("gives a new trace id when none comes in", async () => {
    const { worker, lines } = testWorker();
    const response = await worker.fetch(get("/test/privacy"), {});
    const traceId = response.headers.get("x-trace-id") ?? "";
    expect(traceId).toMatch(UUID);
    expect(lines().map((line) => line.trace_id)).toEqual([traceId]);
  });
});
