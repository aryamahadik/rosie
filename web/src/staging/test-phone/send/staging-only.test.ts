// T-523's proof that in production the test-phone page is absent (T-522; build prompt 9.4: "Never in production"). With
// the routes web/src/routes.ts lists, the page and its send answer every request outside staging exactly as an address
// no route takes does, whatever the request carries (a chosen phone, a whole form from this site's own origin, a
// session cookie): the shell's 404 page, null from serve, one notFound log line, and no call. So it is with the folder's
// staging-only mark taken away, the guard alone; and each route's handler, handed a config that is not staging's,
// answers the shell's 404 having read nothing else. On staging the same addresses answer, and the address the
// signed-in page gives testers (auth/consoles.ts) is this page's. Every value is made up or a K-21 fixture's own
// placeholder (rule 9).
import { describe, expect, it } from "vitest";
import { STAGING_TOOLS_PATH } from "../../../auth/consoles";
import { cookies, post } from "../../../auth/test-support";
import { ROUTE_MODULES } from "../../../routes";
import { readWebConfig, type WebConfig, type WebVars } from "../../../shell/config";
import { renderErrorPage } from "../../../shell/error-pages";
import type { RouteContext, RouteModule } from "../../../shell/route";
import { TEST_LINK_HOST, TRACE_ID, get, testShell, testVars } from "../../../shell/test-support";
import { isGuarded } from "../../guard";
import { SEND_PATH, TEST_PHONE_PATH, WORDS, testPhoneHref } from "./page";
import { ROUTES } from "./routes";
import { FOLDER, SEND, sendFormOf, sessionOf, wholeForm } from "./test-support";

/** A whole send, as the page's form posts it for the fixture's phone and text. */
const WHOLE = wholeForm(SEND.request.testPhoneId, SEND.request.page.requestId, {
  words: SEND.request.words,
  replyTo: SEND.request.threadedReplyTo ?? "",
});

/** Vars of a web app that is not on staging, under production's base path and staging's. */
const NOT_STAGING = ["production", "Staging", "staging ", "preview"].flatMap((environment) =>
  ["", "/test"].map((basePath) => ({
    where: `ENVIRONMENT ${JSON.stringify(environment)} under ${JSON.stringify(basePath)}`,
    vars: { ...testVars("staging"), ENVIRONMENT: environment, BASE_PATH: basePath },
  })),
);

/** Every request a tester's browser could send the page and its send, each under the tests' trace id. */
function requestsTo(config: WebConfig): { what: string; request: Request }[] {
  const traced = { "x-trace-id": TRACE_ID };
  const session = sessionOf(config);
  const page = `${config.basePath}${TEST_PHONE_PATH}`;
  const send = `${config.basePath}${SEND_PATH}`;
  return [
    { what: "GET the page", request: get(page, traced) },
    {
      what: "GET the page signed in, a phone chosen",
      request: get(`${page}?phone=tp-04&replyTo=linq-msg-dummy-0001`, {
        ...traced,
        cookie: cookies(session),
      }),
    },
    {
      what: "HEAD the page",
      request: new Request(`https://${TEST_LINK_HOST}${page}`, { method: "HEAD", headers: traced }),
    },
    { what: "POST a whole send", request: post(send, WHOLE, session, traced) },
    { what: "POST a whole send to the page", request: post(page, WHOLE, session, traced) },
    { what: "GET the send", request: get(send, { ...traced, cookie: cookies(session) }) },
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

describe("in production the page is absent (T-522)", () => {
  it.each(NOT_STAGING)(
    "$where: the page and its send answer as an unknown address does, for GET, HEAD and POST, and no call is made",
    async ({ vars }) => {
      await expectAbsent(undefined, vars);
    },
  );

  it.each(NOT_STAGING)(
    "$where, the folder's staging-only mark taken away: the guard alone keeps both absent",
    async ({ vars }) => {
      await expectAbsent([{ folder: FOLDER, stagingOnly: false, routes: ROUTES }], vars);
    },
  );

  it("each route's handler, handed a config that is not staging's, answers the shell's 404 and reads nothing else", async () => {
    for (const { vars } of NOT_STAGING) {
      const config = readWebConfig(vars);
      for (const route of ROUTES) {
        const notFound = new Response(null, { status: 404 });
        expect(await route.handle(contextOf(config, notFound)), route.label).toBe(notFound);
      }
    }
  });

  it("its routes are behind the staging-only guard, in the folder web/src/routes.ts marks staging only", () => {
    const listed = ROUTE_MODULES.filter((module) => module.folder === FOLDER);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.stagingOnly).toBe(true);
    expect(listed[0]?.routes).toBe(ROUTES);
    expect(ROUTES.map(({ label, path, methods }) => ({ label, path, methods }))).toEqual([
      { label: "testPhone.page", path: "/staging/test-phone", methods: ["GET"] },
      { label: "testPhone.send", path: "/staging/test-phone/send", methods: ["POST"] },
    ]);
    expect(ROUTES.map(isGuarded)).toEqual([true, true]);
  });
});

describe("on staging the same addresses answer", () => {
  it("the page is at the address the signed-in page gives testers, and the routes web/src/routes.ts lists send the fixture's request", async () => {
    expect(TEST_PHONE_PATH).toBe(STAGING_TOOLS_PATH);
    const { shell, config, transport } = testShell({ newTraceId: () => SEND.request.page.traceId });
    expect(config.staging).toBe(true);

    const signedOut = await shell.fetch(get(`${config.basePath}${STAGING_TOOLS_PATH}`));
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain(`<h1>${WORDS.signInTitle}</h1>`);

    const page = await shell.fetch(
      get(testPhoneHref(config, "tp-04"), { cookie: cookies(sessionOf(config)) }),
    );
    expect(page.status).toBe(200);
    expect(sendFormOf(await page.text())).toContain(`<button>${WORDS.sendAs} tp-04</button>`);
    const head = await shell.fetch(
      new Request(`https://${TEST_LINK_HOST}${testPhoneHref(config, "tp-04")}`, {
        method: "HEAD",
        headers: { cookie: cookies(sessionOf(config)) },
      }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const sent = await shell.fetch(post(`${config.basePath}${SEND_PATH}`, WHOLE, sessionOf(config)));
    expect(sent.status).toBe(200);
    expect(transport.sent.map((call) => call.request)).toEqual([SEND.request]);
  });
});
