// T-524's proof that in production the thread view is absent (T-522; build prompt 9.4: "Never in production"). With the
// routes web/src/routes.ts lists, the view's address answers every request outside staging exactly as an address no
// route takes does, whatever the request carries (a session cookie, a query naming a phone, a POST from this site's own
// origin): the shell's 404 page, null from serve, one notFound log line, and no call. So it is with the folder's
// staging-only mark taken away, the guard alone; and the route's handler, handed a config that is not staging's,
// answers the shell's 404 having read nothing else. On staging the same address answers, under the test-phone page's
// own, listed right after the picker's. Every value is made up or a K-21 fixture's own placeholder (rule 9).
import { describe, expect, it } from "vitest";
import { STAGING_TOOLS_PATH } from "../../../auth/consoles";
import { cookies, post } from "../../../auth/test-support";
import { ROUTE_MODULES } from "../../../routes";
import { readWebConfig, type WebConfig, type WebVars } from "../../../shell/config";
import { renderErrorPage } from "../../../shell/error-pages";
import type { RouteContext, RouteModule } from "../../../shell/route";
import { TEST_LINK_HOST, TRACE_ID, get, testShell, testVars } from "../../../shell/test-support";
import { isGuarded } from "../../guard";
import { PARTS_PATH, WORDS, partsHref } from "./page";
import { ROUTES } from "./routes";
import { FOLDER, PICKER_MODULE, sessionOf } from "./test-support";

/** Vars of a web app that is not on staging, under production's base path and staging's. */
const NOT_STAGING = ["production", "Staging", "staging ", "preview"].flatMap((environment) =>
  ["", "/test"].map((basePath) => ({
    where: `ENVIRONMENT ${JSON.stringify(environment)} under ${JSON.stringify(basePath)}`,
    vars: { ...testVars("staging"), ENVIRONMENT: environment, BASE_PATH: basePath },
  })),
);

/** Every request a tester's browser could send the view, each under the tests' trace id. */
function requestsTo(config: WebConfig): { what: string; request: Request }[] {
  const traced = { "x-trace-id": TRACE_ID };
  const session = sessionOf(config);
  const view = `${config.basePath}${PARTS_PATH}`;
  return [
    { what: "GET the view", request: get(view, traced) },
    {
      what: "GET the view signed in, a phone chosen",
      request: get(`${view}?phone=tp-03`, { ...traced, cookie: cookies(session) }),
    },
    {
      what: "HEAD the view",
      request: new Request(`https://${TEST_LINK_HOST}${view}`, { method: "HEAD", headers: traced }),
    },
    { what: "POST to the view", request: post(view, { phone: "tp-03" }, session, traced) },
  ];
}

/** Sends each request and holds its answer to an unknown address's: the 404 page, null from serve, no call. */
async function expectAbsent(modules: readonly RouteModule[] | undefined, vars: WebVars): Promise<void> {
  const { shell, config, transport, rawLines } = testShell({
    vars,
    ...(modules === undefined ? {} : { modules }),
  });
  expect(config.staging).toBe(false);
  const unknown = await shell.fetch(
    get(`${config.basePath}/dummy-unknown-address/page`, { "x-trace-id": TRACE_ID }),
  );
  expect(unknown.status).toBe(404);
  const asked = requestsTo(config);
  for (const { what, request } of asked) {
    expect(shell.serve(request.clone()), what).toBeNull();
    const response = await shell.fetch(request);
    expect(response.status, what).toBe(404);
    expect([...response.headers], what).toEqual([...unknown.headers]);
    expect(await response.text(), what).toBe(
      request.method === "HEAD"
        ? ""
        : renderErrorPage({ status: 404, basePath: config.basePath, traceId: TRACE_ID }),
    );
  }
  expect(transport.sent).toEqual([]);
  const notFound = JSON.stringify({
    level: "info",
    msg: "page",
    trace_id: TRACE_ID,
    route: "notFound",
    status: 404,
  });
  expect(rawLines()).toEqual(Array.from({ length: asked.length + 1 }, () => notFound));
}

/** A route context that holds a config and the shell's 404 alone: reading any other part of it throws. */
function contextOf(config: WebConfig, notFound: Response): RouteContext {
  const made = { config, notFound: () => notFound };
  for (const part of ["request", "url", "path", "params", "traceId", "client", "envelope", "page"])
    Object.defineProperty(made, part, {
      get: () => {
        throw new Error(`the route read the context's ${part}`);
      },
    });
  return made as unknown as RouteContext;
}

describe("in production the thread view is absent (T-522)", () => {
  it.each(NOT_STAGING)(
    "$where: the view answers as an unknown address does, for GET, HEAD and POST, and no call is made",
    async ({ vars }) => {
      await expectAbsent(undefined, vars);
    },
  );

  it.each(NOT_STAGING)(
    "$where, the folder's staging-only mark taken away: the guard alone keeps it absent",
    async ({ vars }) => {
      await expectAbsent([{ folder: FOLDER, stagingOnly: false, routes: ROUTES }], vars);
    },
  );

  it("its route's handler, handed a config that is not staging's, answers the shell's 404 and reads nothing else", async () => {
    for (const { vars } of NOT_STAGING) {
      const config = readWebConfig(vars);
      for (const route of ROUTES) {
        const notFound = new Response(null, { status: 404 });
        expect(await route.handle(contextOf(config, notFound)), route.label).toBe(notFound);
      }
    }
  });

  it("its route is behind the staging-only guard, in the folder web/src/routes.ts marks staging only, listed right after the picker's", () => {
    const listed = ROUTE_MODULES.filter((module) => module.folder === FOLDER);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.stagingOnly).toBe(true);
    expect(listed[0]?.routes).toBe(ROUTES);
    const folders = ROUTE_MODULES.map((module) => module.folder);
    expect(folders.indexOf(FOLDER)).toBe(folders.indexOf(PICKER_MODULE.folder) + 1);
    expect(ROUTES.map(({ label, path, methods }) => ({ label, path, methods }))).toEqual([
      { label: "testPhone.parts", path: "/staging/test-phone/parts", methods: ["GET"] },
    ]);
    expect(ROUTES.map(isGuarded)).toEqual([true]);
  });
});

describe("on staging the same address answers", () => {
  it("the view is under the test-phone page's address, with the routes web/src/routes.ts lists: signed out it asks for sign-in, and it takes GET alone", async () => {
    expect(PARTS_PATH).toBe(`${STAGING_TOOLS_PATH}/parts`);
    const { shell, config, transport } = testShell();
    expect(config.staging).toBe(true);
    expect(partsHref(config, "tp-03")).toBe("/test/staging/test-phone/parts?phone=tp-03");

    const signedOut = await shell.fetch(get(partsHref(config, "tp-03")));
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain(`<h1>${WORDS.signInTitle}</h1>`);
    const head = await shell.fetch(
      new Request(`https://${TEST_LINK_HOST}${partsHref(config, "tp-03")}`, { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const posted = await shell.fetch(
      post(`${config.basePath}${PARTS_PATH}`, { phone: "tp-03" }, sessionOf(config)),
    );
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
    expect(transport.sent).toEqual([]);
  });
});
