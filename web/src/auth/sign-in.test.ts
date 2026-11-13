// T-520's proofs for sign-in by code (C-193), through the web shell on the Tool API mock with K-21 v1's own fixtures:
//   1. sign-in-request.json's request is sent, and the page names the way the code went as the response gives it;
//   2. after sign-in-wrong-five.json the page shows the 15-minute pause and sends no further check until it ends;
//   4. a signed-in session carries the person's role to the consoles (owner, admin, staff, Rosie's team).
// (Proof 3, no password field anywhere in web/, is no-password.test.ts.) Beside them: K-21's other sign-in fixtures
// (sign-in-from-link-by-text, sign-in-done, sign-in-already-signed-in, sign-out), every other answer the two calls may
// give, what a browser may send, the cookies, and what is never shown or logged. Every value is a fixture's own
// placeholder or made up (rule 9).
import { describe, expect, it } from "vitest";
import { ToolApiMockError } from "../../../contracts/mock/mock.mjs";
import { readWebConfig, type WebConfig } from "../shell/config";
import { contentSecurityPolicy } from "../shell/serve";
import { TEST_LINK_HOST, TRACE_ID, attributeValues, get, testShell, testVars } from "../shell/test-support";
import {
  BUSINESS_CONSOLE_PATH,
  STAGING_TOOLS_PATH,
  TEAM_CONSOLE_PATH,
  consolesFor,
  signedInAs,
} from "./consoles";
import {
  DEVICE_COOKIE_SECONDS,
  cookieNames,
  cookieOf,
  deviceTokenOf,
  newDeviceToken,
  pauseOf,
  sessionCookie,
  sessionTokenOf,
} from "./cookies";
import { BAD_FORM, FIVE_WRONG, NEVER_ASKED, TRY_AGAIN, startPage, waitWords } from "./pages";
import { ROUTES } from "./routes";
import {
  CHECK_OUTCOMES,
  ORIGIN,
  START_OUTCOMES,
  cookiePair,
  cookies,
  exchange,
  hiddenFields,
  mockShell,
  person,
  post,
  signedIn,
  stubShell,
} from "./test-support";

const STAGING: WebConfig = readWebConfig(testVars("staging"));
const PRODUCTION: WebConfig = readWebConfig(testVars("production"));
const NAMES = cookieNames(STAGING);

const REQUEST = exchange("sign-in-request.json", "signInStart");
const BY_TEXT = exchange("sign-in-from-link-by-text.json", "signInStart");
const WRONG_FIVE = exchange("sign-in-wrong-five.json", "signInCheck");
const DONE = exchange("sign-in-done.json", "signInCheck");
const ALREADY = exchange("sign-in-already-signed-in.json", "signInCheck");
const SIGN_OUT = exchange("sign-out.json", "signOut");

/** The attributes every cookie here has, after its name, value and life. */
const ATTRIBUTES = "Path=/test; HttpOnly; Secure; SameSite=Lax";

/** A made-up browser's device cookie. */
const DEVICE = { [NAMES.device]: "dummy-device-token-0001" };
/** A check form's fields for a made-up attempt by the email way. */
const CHECK = {
  requestId: "req-dummy-check-0001",
  attempt: "attempt-dummy-0001",
  way: "email",
  code: "123456",
};
const AT = "2026-10-26T13:00:00Z";

describe("sign-in-request.json's request is sent and the page names the way the code went as the response gives it", () => {
  it("the sign-in page's own form, sent with the email typed, sends the fixture's request; the page then names email", async () => {
    const { page } = REQUEST.request;
    const { shell, transport } = mockShell({
      now: REQUEST.given.now,
      traceId: page.traceId,
      requestIds: [page.requestId],
    });
    const device = { [NAMES.device]: REQUEST.request.deviceToken };

    const opened = await shell.fetch(get("/test/sign-in", { cookie: cookies(device) }));
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-security-policy")).toBe(contentSecurityPolicy({ forms: true }));
    // The browser already has its device cookie, so none is set.
    expect(opened.headers.getSetCookie()).toEqual([]);
    const form = await opened.text();
    expect(form).toContain('<form method="post" action="/test/sign-in">');
    expect(form).toContain("There is no password.");
    expect(form).toContain(NEVER_ASKED);
    expect(hiddenFields(form)).toEqual({ requestId: page.requestId });
    expect(transport.sent).toEqual([]);

    // The form as the page gave it, with Sam's email typed and the email button pressed.
    const typed = "sam@lees-barbershop.example";
    const response = await shell.fetch(
      post("/test/sign-in", { ...hiddenFields(form), account: `  ${typed} `, way: "email" }, device),
    );
    expect(transport.sent).toEqual([
      { call: "signInStart", request: REQUEST.request, traceId: page.traceId },
    ]);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Type your code</h1>");
    expect(html).toContain(
      "<p>If an account matches what you typed, a code is on its way by email, to the email on file. It works for 10 minutes.</p>",
    );
    expect(html).toContain(FIVE_WRONG);
    expect(html).toContain(NEVER_ASKED);
    // Nothing typed is shown back, and nothing says whether an account matched.
    for (const value of [typed, "lees-barbershop", "sam@"]) expect(html).not.toContain(value);
    // The next form carries the attempt the answer gave, and a request id of its own.
    expect(html).toContain('<form method="post" action="/test/sign-in/check">');
    expect(hiddenFields(html)).toEqual({
      requestId: "req-made-in-test-2",
      attempt: "attempt-sam-signin-1",
      way: "email",
    });
    expect(html).toContain('name="code" type="text" inputmode="numeric" autocomplete="one-time-code"');
  });

  it("names the way the answer gives, not the one the form asked for", async () => {
    const { shell, sent } = stubShell(() => START_OUTCOMES[1], { now: AT });
    const response = await shell.fetch(
      post(
        "/test/sign-in",
        { requestId: "req-dummy-start-0001", account: "+1 555 555 0142", way: "email" },
        DEVICE,
      ),
    );
    expect(sent.map((call) => call.request)).toEqual([
      {
        page: { requestId: "req-dummy-start-0001", traceId: TRACE_ID, sessionToken: null, linkCode: null },
        account: { from: "typed", kind: "mobile", typed: "+1 555 555 0142" },
        way: "email",
        deviceToken: "dummy-device-token-0001",
      },
    ]);
    const html = await response.text();
    expect(html).toContain("<h1>Send this text</h1>");
    expect(html).toContain("Your sign-in goes by text.");
    expect(html).not.toContain("by email");
    expect(hiddenFields(html).way).toBe("text");
    expect(html).not.toContain("555 555 0142");
  });

  it("sign-in-from-link-by-text.json: a signed link's own sign-in sends the link's code and no typed account, and shows the ready text to send", async () => {
    const { page } = BY_TEXT.request;
    const link = page.linkCode ?? "";
    const { shell, transport } = mockShell({
      now: BY_TEXT.given.now,
      traceId: page.traceId,
      requestIds: [page.requestId],
    });
    const device = { [NAMES.device]: BY_TEXT.request.deviceToken };

    const opened = await shell.fetch(get(`/test/sign-in?link=${link}`, { cookie: cookies(device) }));
    const form = await opened.text();
    expect(hiddenFields(form)).toEqual({ requestId: page.requestId, link });
    // A link's own sign-in asks for no mobile or email: the server takes whose account from the link.
    expect(form).not.toContain('name="account"');

    const response = await shell.fetch(post("/test/sign-in", { ...hiddenFields(form), way: "text" }, device));
    expect(transport.sent).toEqual([
      { call: "signInStart", request: BY_TEXT.request, traceId: page.traceId },
    ]);
    const html = await response.text();
    expect(html).toContain("Your sign-in goes by text.");
    expect(html).toContain("<p><strong>My Rosie sign-in code is 000000</strong></p>");
    expect(html).toContain(
      '<p><a href="sms:+15555550188&amp;body=My%20Rosie%20sign-in%20code%20is%20000000">Open Messages with the text ready</a></p>',
    );
    expect(html).toContain("It works for 10 minutes.");
    expect(hiddenFields(html)).toEqual({
      requestId: "req-made-in-test-2",
      attempt: "attempt-sam-s01-1",
      way: "text",
      link,
    });
    // The text way's check form asks for no code: the code goes by the text alone.
    expect(html).not.toContain('name="code"');
  });
});

describe("after sign-in-wrong-five.json the page shows the 15-minute pause and sends no further check until it ends", () => {
  const { page } = WRONG_FIVE.request;
  const device = { [NAMES.device]: WRONG_FIVE.request.deviceToken };
  /** The fifth wrong code's form, as the code page posts it. */
  const fifth = {
    requestId: page.requestId,
    attempt: WRONG_FIVE.request.attemptId,
    way: "email",
    code: WRONG_FIVE.request.code ?? "",
  };
  const PAUSE_PAGE_TIME = '<time datetime="2026-10-28T15:22:10Z">2026-10-28 15:22 UTC</time>';

  it("shows the pause the answer gave, holds no form that checks a code, and sends nothing more until the pause's end", async () => {
    let clock = new Date(WRONG_FIVE.given.now);
    const { shell, transport } = mockShell({ now: () => clock, traceId: page.traceId });

    const paused = await shell.fetch(post("/test/sign-in/check", fifth, device));
    expect(transport.sent).toEqual([
      { call: "signInCheck", request: WRONG_FIVE.request, traceId: page.traceId },
    ]);
    expect(paused.status).toBe(200);
    const html = await paused.text();
    expect(html).toContain("<h1>Sign-in is paused</h1>");
    expect(html).toContain(`<p>${FIVE_WRONG}</p>`);
    expect(html).toContain(`<p>You can try again in 15 minutes, at ${PAUSE_PAGE_TIME}.</p>`);
    expect(html).toContain("<p>Nothing more is checked until then.</p>");
    // No form at all, so the page itself can send no further check; and no script that could.
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http-equiv");
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/sign-in", "/test/privacy"]);
    // The pause's end and its attempt are kept for this browser until the pause ends.
    const kept = paused.headers.getSetCookie();
    expect(kept).toEqual([
      `${NAMES.pause}=2026-10-28T15:22:10.000Z|attempt-sam-signin-3; Expires=Wed, 28 Oct 2026 15:22:10 GMT; ${ATTRIBUTES}`,
    ]);
    const browser = { ...device, ...cookiePair(kept[0] ?? "") };

    // The same form sent again (a reload), and another code from a page gone back to: the pause page, and no call.
    const tries = [
      { at: "2026-10-28T15:07:11Z", fields: fifth, left: "15 minutes" },
      {
        at: "2026-10-28T15:20:00Z",
        fields: { ...fifth, requestId: "req-dummy-try-6", code: "222222" },
        left: "3 minutes",
      },
      {
        at: "2026-10-28T15:22:09.999Z",
        fields: { ...fifth, requestId: "req-dummy-try-7", code: "333333" },
        left: "1 minute",
      },
    ];
    for (const { at, fields, left } of tries) {
      clock = new Date(at);
      const again = await shell.fetch(post("/test/sign-in/check", fields, browser));
      expect(again.status, at).toBe(200);
      const shown = await again.text();
      expect(shown, at).toContain("<h1>Sign-in is paused</h1>");
      expect(shown, at).toContain(`<p>You can try again in ${left}, at ${PAUSE_PAGE_TIME}.</p>`);
      expect(shown, at).not.toContain("<form");
      expect(transport.sent, at).toHaveLength(1);
    }

    // The pause has ended: a check is sent again (the mock answers the fixture's request as before).
    clock = new Date("2026-10-28T15:22:10Z");
    await shell.fetch(post("/test/sign-in/check", fifth, browser));
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]).toEqual(transport.sent[0]);
  });

  it("holds only the attempt the pause was for: another attempt's check is sent", async () => {
    const { shell, transport } = mockShell({ now: WRONG_FIVE.given.now, traceId: page.traceId });
    const paused = await shell.fetch(post("/test/sign-in/check", fifth, device));
    const browser = { ...device, ...cookiePair(paused.headers.getSetCookie()[0] ?? "") };
    // No fixture holds this other attempt, so the mock fails loudly: the call was made.
    await expect(
      shell.fetch(post("/test/sign-in/check", { ...fifth, attempt: "attempt-dummy-other" }, browser)),
    ).rejects.toBeInstanceOf(ToolApiMockError);
    expect(transport.sent).toHaveLength(2);
  });

  it("reads the pause from the cookie only when it reads as one", () => {
    const ask = (value: string): unknown =>
      pauseOf(get("/test/sign-in", { cookie: `${NAMES.pause}=${value}` }), STAGING);
    expect(ask("2026-10-28T15:22:10.000Z|attempt-sam-signin-3")).toEqual({
      until: new Date("2026-10-28T15:22:10Z"),
      attemptId: "attempt-sam-signin-3",
    });
    expect(ask("2026-10-28T15:22:10Z|a%22b%20c")).toEqual({
      until: new Date("2026-10-28T15:22:10Z"),
      attemptId: 'a"b c',
    });
    for (const value of [
      "",
      "2026-10-28T15:22:10Z",
      "tomorrow|attempt-1",
      "2026-13-45T99:99:99Z|attempt-1",
      "2026-10-28T15:22:10Z|",
      "2026-10-28T15:22:10Z|%E0%A4%A",
    ])
      expect(ask(value), value).toBeNull();
    expect(pauseOf(get("/test/sign-in"), STAGING)).toBeNull();
  });

  it("shows the pause signInStart answers, with no reason named and no form", async () => {
    const { shell, sent } = stubShell(() => START_OUTCOMES[2], { now: AT });
    const response = await shell.fetch(
      post(
        "/test/sign-in",
        { requestId: "req-dummy-start-0001", account: "dummy@lee.example", way: "email" },
        DEVICE,
      ),
    );
    expect(sent).toHaveLength(1);
    const html = await response.text();
    expect(html).toContain("<h1>Sign-in is paused</h1>");
    expect(html).toContain("You can try again in 15 minutes, at ");
    expect(html).not.toContain(FIVE_WRONG);
    expect(html).not.toContain("<form");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("says a wait in whole minutes, then hours", () => {
    const now = new Date("2026-10-28T15:07:10Z");
    const after = (seconds: number): string => waitWords(new Date(now.getTime() + seconds * 1000), now);
    expect([
      after(900),
      after(899),
      after(61),
      after(60),
      after(1),
      after(-5),
      after(5400),
      after(5401),
      after(86_400),
    ]).toEqual([
      "15 minutes",
      "15 minutes",
      "2 minutes",
      "1 minute",
      "1 minute",
      "1 minute",
      "90 minutes",
      "2 hours",
      "24 hours",
    ]);
  });
});

describe("a signed-in session carries the person's role to the consoles (owner, admin, staff, Rosie's team)", () => {
  it("sign-in-done.json: the session cookie holds the token alone, the page sends the owner to their console, and sign-out.json's call then carries that session", async () => {
    const { page } = DONE.request;
    const link = page.linkCode ?? "";
    const { shell, transport } = mockShell({ now: DONE.given.now, traceId: page.traceId });
    const device = { [NAMES.device]: DONE.request.deviceToken };

    // The text way's "I have sent it": no code is typed.
    const response = await shell.fetch(
      post(
        "/test/sign-in/check",
        { requestId: page.requestId, attempt: DONE.request.attemptId, way: "text", link },
        device,
      ),
    );
    expect(transport.sent).toEqual([{ call: "signInCheck", request: DONE.request, traceId: page.traceId }]);
    expect(response.status).toBe(200);

    // The cookie: the opaque token the server gave, until the session's own end, and nothing of the person.
    const set = response.headers.getSetCookie();
    expect(set).toEqual([
      `${NAMES.session}=placeholder-session-token-sam-0001; Expires=Wed, 18 Nov 2026 14:22:10 GMT; ${ATTRIBUTES}`,
    ]);
    for (const value of ["owner", "person-sam", "biz-lees-barbershop", "team", "tester"])
      expect(set[0]).not.toContain(value);

    // The page: what Sam is signed in as, his console, and the way back to the link's page, built from the config.
    const html = await response.text();
    expect(html).toContain("<h1>You are signed in</h1>");
    expect(html).toContain("<p>Signed in as: Owner.</p>");
    expect(attributeValues(html, "href")).toEqual([
      "#main",
      `https://${TEST_LINK_HOST}/test/${link}`,
      `/test${BUSINESS_CONSOLE_PATH}`,
      "/test/privacy",
    ]);
    for (const value of ["person-sam", "biz-lees-barbershop", "placeholder-session-token"])
      expect(html).not.toContain(value);

    // A console reads the session from the cookie, and the token is all it gets.
    const browser = cookiePair(set[0] ?? "");
    expect(sessionTokenOf(get(`/test${BUSINESS_CONSOLE_PATH}`, { cookie: cookies(browser) }), STAGING)).toBe(
      "placeholder-session-token-sam-0001",
    );

    // The session travels in a later call's envelope: sign-out.json's request, which the mock answers for Sam's token alone.
    const out = mockShell({ now: SIGN_OUT.given.now, traceId: SIGN_OUT.request.page.traceId });
    const signedOut = await out.shell.fetch(
      post("/test/sign-out", { requestId: SIGN_OUT.request.page.requestId }, browser),
    );
    expect(out.transport.sent).toEqual([
      { call: "signOut", request: SIGN_OUT.request, traceId: SIGN_OUT.request.page.traceId },
    ]);
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain("<h1>You are signed out</h1>");
    expect(signedOut.headers.getSetCookie()).toEqual([`${NAMES.session}=; Max-Age=0; ${ATTRIBUTES}`]);
  });

  it.each([
    { name: "an owner", who: person(["owner"]), as: "Owner", paths: [BUSINESS_CONSOLE_PATH] },
    { name: "an admin", who: person(["admin"]), as: "Admin", paths: [BUSINESS_CONSOLE_PATH] },
    { name: "a staff member", who: person(["staff"]), as: "Staff", paths: [BUSINESS_CONSOLE_PATH] },
    {
      name: "someone on Rosie's team",
      who: person([], { team: true }),
      as: "Rosie's team",
      paths: [TEAM_CONSOLE_PATH, STAGING_TOOLS_PATH],
    },
    {
      name: "an owner who is also on Rosie's team",
      who: person(["owner", "staff", "owner"], { team: true }),
      as: "Owner, Staff, Rosie's team",
      paths: [BUSINESS_CONSOLE_PATH, TEAM_CONSOLE_PATH, STAGING_TOOLS_PATH],
    },
    {
      name: "a tester on staging",
      who: person([], { tester: true }),
      as: "Tester",
      paths: [STAGING_TOOLS_PATH],
    },
  ])("$name is sent to their console, and the cookie is the token alone", async ({ who, as, paths }) => {
    const { shell } = stubShell(() => signedIn(who), { now: AT });
    const response = await shell.fetch(post("/test/sign-in/check", CHECK, DEVICE));
    const html = await response.text();
    expect(html).toContain(`<p>Signed in as: ${as.replaceAll("'", "&#39;")}.</p>`);
    expect(attributeValues(html, "href")).toEqual([
      "#main",
      ...paths.map((path) => `/test${path}`),
      "/test/privacy",
    ]);
    expect(response.headers.getSetCookie()).toEqual([
      `${NAMES.session}=dummy-session-token-0001; Expires=Tue, 01 Dec 2026 00:00:00 GMT; ${ATTRIBUTES}`,
    ]);
    for (const value of ["person-dummy", "biz-dummy"]) expect(html).not.toContain(value);
  });

  it("never opens staging's test tools in production, and a tester exists on staging only", async () => {
    const both = person(["owner"], { team: true, tester: true });
    expect(consolesFor(both, PRODUCTION).map((open) => open.kind)).toEqual(["business", "team"]);
    expect(consolesFor(both, STAGING).map((open) => open.kind)).toEqual(["business", "team", "stagingTools"]);
    expect(signedInAs(both, PRODUCTION)).toEqual(["owner", "team"]);
    expect(signedInAs(both, STAGING)).toEqual(["owner", "team", "tester"]);
    expect(signedInAs(person(["staff", "ownBusiness", "admin", "owner", "staff"]), PRODUCTION)).toEqual([
      "owner",
      "admin",
      "staff",
      "ownBusiness",
    ]);
    expect(consolesFor(person([]), STAGING)).toEqual([]);

    const { shell } = stubShell(() => signedIn(person([], { tester: true })), {
      now: AT,
      environment: "production",
    });
    const response = await shell.fetch(
      post("/sign-in/check", CHECK, { [cookieNames(PRODUCTION).device]: "dummy-device-token-0001" }),
    );
    const html = await response.text();
    expect(html).toContain("<p>Nothing here is open to this account yet.</p>");
    expect(html).not.toContain("Tester");
    expect(attributeValues(html, "href")).toEqual(["#main", "/privacy"]);
    expect(response.headers.getSetCookie()).toEqual([
      "__Secure-rosie-session=dummy-session-token-0001; Expires=Tue, 01 Dec 2026 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("reads staging as the shell lists staging's tools: a config whose two values disagree is not staging", () => {
    // Configs readWebConfig would never give (staging/guard isStagingConfig fails closed on them): no tester, no link to
    // the tools, and the start page says nothing of testers.
    const both = person(["owner"], { team: true, tester: true });
    for (const config of [
      { ...STAGING, environment: "production" },
      { ...STAGING, environment: "Staging" },
      { ...PRODUCTION, staging: true },
      { ...STAGING, staging: false },
    ]) {
      const what = JSON.stringify(config);
      expect(
        consolesFor(both, config).map((open) => open.kind),
        what,
      ).toEqual(["business", "team"]);
      expect(signedInAs(both, config), what).toEqual(["owner", "team"]);
      expect(startPage(config, { requestId: "req-dummy-start-0001", link: null }).main, what).not.toContain(
        "So do testers on staging.",
      );
    }
    expect(startPage(STAGING, { requestId: "req-dummy-start-0001", link: null }).main).toContain(
      "So do testers on staging.",
    );
  });

  it("sign-in-already-signed-in.json: a later check of a signed-in attempt gives no token, so no cookie is set", async () => {
    const { page } = ALREADY.request;
    const { shell, transport } = mockShell({ now: ALREADY.given.now, traceId: page.traceId });
    const response = await shell.fetch(
      post(
        "/test/sign-in/check",
        {
          requestId: page.requestId,
          attempt: ALREADY.request.attemptId,
          way: "text",
          link: page.linkCode ?? "",
        },
        { [NAMES.device]: ALREADY.request.deviceToken },
      ),
    );
    expect(transport.sent).toEqual([
      { call: "signInCheck", request: ALREADY.request, traceId: page.traceId },
    ]);
    expect(response.headers.getSetCookie()).toEqual([]);
    const html = await response.text();
    expect(html).toContain("<h1>This sign-in is already done</h1>");
    expect(attributeValues(html, "href")).toEqual([
      "#main",
      "/test/sign-in?link=s01-placeholder-sam",
      "/test/privacy",
    ]);
  });

  it("reads a session token from the cookie only when it reads as one, and the first cookie of the name", () => {
    const ask = (cookie: string, config = STAGING): string | null =>
      sessionTokenOf(get("/test/x", { cookie }), config);
    expect(ask(`${NAMES.session}=dummy-session-token-0001`)).toBe("dummy-session-token-0001");
    expect(
      ask(`other=1; ${NAMES.session}=dummy-session-token-0001; ${NAMES.session}=dummy-session-token-0002`),
    ).toBe("dummy-session-token-0001");
    // A token with letters a cookie cannot hold is written encoded and read back whole.
    const odd = 'dummy token; with "odd" letters';
    const written = cookiePair(sessionCookie(odd, "not-a-time", STAGING));
    expect(written[NAMES.session]).toBe(encodeURIComponent(odd));
    expect(ask(cookies(written))).toBe(odd);
    expect(sessionCookie(odd, "not-a-time", STAGING)).toBe(
      `${NAMES.session}=${encodeURIComponent(odd)}; ${ATTRIBUTES}`,
    );
    // Too short, too long, undecodable, production's cookie on staging, or none.
    for (const cookie of [
      `${NAMES.session}=short`,
      `${NAMES.session}=${"a".repeat(513)}`,
      `${NAMES.session}=%E0%A4%A-dummy-session-token`,
      `${cookieNames(PRODUCTION).session}=dummy-session-token-0001`,
      "",
    ])
      expect(ask(cookie), cookie).toBeNull();
    expect(sessionTokenOf(get("/test/x"), STAGING)).toBeNull();
    expect(cookieOf(get("/x", { cookie: "a=1; b = two=2 ;c" }), "b")).toBe("two=2");
  });
});

describe("every other answer the two calls may give has its page, and none starts a session", () => {
  const checked = async (
    outcome: unknown,
    fields: Record<string, string> = CHECK,
  ): Promise<{ status: number; html: string; set: string[] }> => {
    const { shell } = stubShell(() => outcome, { now: AT });
    const response = await shell.fetch(post("/test/sign-in/check", fields, DEVICE));
    return { status: response.status, html: await response.text(), set: response.headers.getSetCookie() };
  };

  it("a wrong code: the form again with the tries left, and a request id of its own", async () => {
    const { status, html, set } = await checked({ result: "wrong", triesLeft: 4 });
    expect(status).toBe(200);
    expect(html).toContain('<p role="alert">That code is not right. 4 tries left.</p>');
    expect(hiddenFields(html)).toEqual({
      requestId: "req-made-in-test-1",
      attempt: "attempt-dummy-0001",
      way: "email",
    });
    expect(html).not.toContain("123456");
    expect(set).toEqual([]);
    expect((await checked({ result: "wrong", triesLeft: 1 })).html).toContain(
      "That code is not right. 1 try left.",
    );
  });

  it("a code past its 10 minutes: start again", async () => {
    const { html, set } = await checked({ result: "expired" });
    expect(html).toContain("<h1>That code has run out</h1>");
    expect(html).toContain("A code works for 10 minutes.");
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/sign-in", "/test/privacy"]);
    expect(set).toEqual([]);
  });

  it("the text has not come: the button again, and the ready text is not shown a second time", async () => {
    const fields = {
      requestId: "req-dummy-check-0001",
      attempt: "attempt-dummy-0002",
      way: "text",
      link: "dummy-link-01",
    };
    const { html, set } = await checked(
      { result: "waitingForText", expiresAt: "2026-10-26T13:10:00Z" },
      fields,
    );
    expect(html).toContain("<h1>Your text has not come yet</h1>");
    expect(hiddenFields(html)).toEqual({ ...fields, requestId: "req-made-in-test-1" });
    expect(html).not.toContain("000000");
    expect(html).not.toContain('name="code"');
    expect(set).toEqual([]);
  });

  it("a second proof needed on a new device: no session, and the page says so", async () => {
    const { html, set } = await checked({ result: "secondProofNeeded", ways: ["emailCode", "idReCheck"] });
    expect(html).toContain("<h1>A second proof is needed</h1>");
    expect(html).toContain("no session has started");
    expect(set).toEqual([]);
  });

  it("an attempt this browser did not start: start again, in the same words for everyone", async () => {
    const { status, html, set } = await checked({ error: "attemptNotFound" });
    expect(status).toBe(200);
    expect(html).toContain("<p>That sign-in was not found for this browser.</p>");
    expect(set).toEqual([]);
  });

  it.each(["transient", "bookingPaused"])(
    "%s: nothing was sent or checked, and the form comes again with a 503",
    async (error) => {
      const check = await checked({ error });
      expect(check.status).toBe(503);
      expect(check.html).toContain(`<p role="alert">${TRY_AGAIN}</p>`);
      expect(hiddenFields(check.html).attempt).toBe("attempt-dummy-0001");
      expect(check.set).toEqual([]);

      const { shell } = stubShell(() => ({ error }), { now: AT });
      const start = await shell.fetch(
        post(
          "/test/sign-in",
          { requestId: "req-dummy-start-0001", account: "dummy@lee.example", way: "email" },
          DEVICE,
        ),
      );
      expect(start.status).toBe(503);
      const html = await start.text();
      expect(html).toContain(`<p role="alert">${TRY_AGAIN}</p>`);
      expect(html).toContain('name="account"');
      expect(html).not.toContain("dummy@lee.example");

      const out = await shell.fetch(
        post(
          "/test/sign-out",
          { requestId: "req-dummy-out-0001" },
          { [NAMES.session]: "dummy-session-token-0001" },
        ),
      );
      expect(out.status).toBe(503);
      // Nothing changed on the server, so the cookie stays.
      expect(out.headers.getSetCookie()).toEqual([]);
    },
  );

  it("escapes whatever an answer holds, and places only a link that opens Messages", async () => {
    const answer = {
      result: "started",
      attemptId: 'attempt-"<dummy>&',
      way: "text",
      expiresAt: "not-a-time",
      readyText: '<b>dummy</b> & "words"',
      textLink: 'sms:+15555550188&body=<b>"dummy"',
    };
    const start = async (outcome: unknown): Promise<string> => {
      const { shell } = stubShell(() => outcome, { now: AT });
      const response = await shell.fetch(
        post(
          "/test/sign-in",
          { requestId: "req-dummy-start-0001", account: "dummy@lee.example", way: "text" },
          DEVICE,
        ),
      );
      return response.text();
    };
    const html = await start(answer);
    expect(html).toContain("<p><strong>&lt;b&gt;dummy&lt;/b&gt; &amp; &quot;words&quot;</strong></p>");
    expect(html).toContain('<a href="sms:+15555550188&amp;body=&lt;b&gt;&quot;dummy&quot;">');
    expect(html).toContain('name="attempt" value="attempt-&quot;&lt;dummy&gt;&amp;"');
    expect(hiddenFields(html).attempt).toBe('attempt-"<dummy>&');
    expect(html).not.toContain("<b>");
    // An end that is no time: FS section 8's own sentence instead.
    expect(html).toContain("A code works for 10 minutes from when it was made.");
    for (const textLink of ["javascript:alert(1)", "https://example.invalid/x", " sms:+15555550188", null])
      expect(await start({ ...answer, textLink }), String(textLink)).not.toContain("Open Messages");
  });
});

describe("what a browser sends is used only after it reads as its kind, and a bad form makes no call", () => {
  const START = { requestId: "req-dummy-start-0001", account: "dummy@lee.example", way: "email" };

  it.each([
    { name: "no request id", fields: { ...START, requestId: "" } },
    { name: "a request id with other letters", fields: { ...START, requestId: 'req-"dummy"-0001' } },
    { name: "a request id too long", fields: { ...START, requestId: "r".repeat(129) } },
    { name: "no way", fields: { requestId: START.requestId, account: START.account } },
    { name: "a way that is not one", fields: { ...START, way: "call" } },
    { name: "a link that is not a code", fields: { ...START, link: "../dummy" } },
    { name: "nothing typed", fields: { ...START, account: "   " } },
    { name: "too much typed", fields: { ...START, account: "d".repeat(255) } },
  ])("a start with $name: the form again with a 400", async ({ fields }) => {
    const { shell, sent } = stubShell(() => START_OUTCOMES[0], { now: AT });
    const response = await shell.fetch(post("/test/sign-in", fields, DEVICE));
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
    const html = await response.text();
    expect(html).toContain('<p role="alert">');
    expect(hiddenFields(html)).toEqual({ requestId: "req-made-in-test-1" });
    for (const value of ["dummy@lee.example", "../dummy", '"dummy"']) expect(html).not.toContain(value);
  });

  it.each([
    { name: "no request id", fields: { ...CHECK, requestId: "" }, words: BAD_FORM },
    { name: "no attempt", fields: { ...CHECK, attempt: "" }, words: BAD_FORM },
    { name: "an attempt with a space", fields: { ...CHECK, attempt: "attempt dummy" }, words: BAD_FORM },
    { name: "an attempt too long", fields: { ...CHECK, attempt: "a".repeat(257) }, words: BAD_FORM },
    { name: "a way that is not one", fields: { ...CHECK, way: "call" }, words: BAD_FORM },
    { name: "a link that is not a code", fields: { ...CHECK, link: "a/b" }, words: BAD_FORM },
    {
      name: "a code that is not digits",
      fields: { ...CHECK, code: "12ab56" },
      words: "Type the code&#39;s digits, as they came.",
    },
    { name: "no code", fields: { ...CHECK, code: "" }, words: "Type the code&#39;s digits, as they came." },
    {
      name: "a code too long",
      fields: { ...CHECK, code: "123456789" },
      words: "Type the code&#39;s digits, as they came.",
    },
  ])("a check with $name: a 400, and no try is used", async ({ fields, words }) => {
    const { shell, sent } = stubShell(() => CHECK_OUTCOMES[0], { now: AT });
    const response = await shell.fetch(post("/test/sign-in/check", fields, DEVICE));
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
    const html = await response.text();
    expect(html).toContain(words);
    for (const value of ["12ab56", "123456789", "attempt dummy"]) expect(html).not.toContain(value);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("takes a code typed with spaces, and sends its digits", async () => {
    const { shell, sent } = stubShell(() => ({ result: "expired" }), { now: AT });
    await shell.fetch(post("/test/sign-in/check", { ...CHECK, code: " 123 456 " }, DEVICE));
    expect(sent.map((call) => call.request)).toEqual([
      {
        page: { requestId: CHECK.requestId, traceId: TRACE_ID, sessionToken: null, linkCode: null },
        attemptId: CHECK.attempt,
        code: "123456",
        deviceToken: "dummy-device-token-0001",
      },
    ]);
  });

  it("never sends a session token with a sign-in call, whatever cookie the browser holds", async () => {
    const { shell, sent } = stubShell(() => ({ result: "expired" }), { now: AT });
    await shell.fetch(
      post("/test/sign-in/check", CHECK, { ...DEVICE, [NAMES.session]: "dummy-session-token-0001" }),
    );
    expect(JSON.stringify(sent)).not.toContain("dummy-session-token");
  });

  it("makes no check without the device cookie the attempt was started with", async () => {
    const { shell, sent } = stubShell(() => CHECK_OUTCOMES[0], { now: AT });
    for (const sentCookies of [
      {},
      { [NAMES.device]: "short" },
      { [NAMES.device]: "dummy device token 0001" },
    ]) {
      const response = await shell.fetch(post("/test/sign-in/check", CHECK, sentCookies));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("This browser did not keep the cookie sign-in needs.");
    }
    expect(sent).toEqual([]);
  });

  it("reads only a form: any other body is a 400 with no call", async () => {
    const { shell, sent } = stubShell(() => CHECK_OUTCOMES[0], { now: AT });
    for (const path of ["/test/sign-in", "/test/sign-in/check", "/test/sign-out"]) {
      const response = await shell.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json", cookie: cookies(DEVICE) },
          body: JSON.stringify(CHECK),
        }),
      );
      expect(response.status, path).toBe(400);
      expect(await response.text(), path).toContain(BAD_FORM);
    }
    expect(sent).toEqual([]);
  });

  it("gives the 404 page for a sign-in address whose link is not a code, and shows no part of it", async () => {
    const { shell } = stubShell(() => null, { now: AT });
    const response = await shell.fetch(get("/test/sign-in?link=%3Cscript%3Edummy"));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("dummy");
  });

  it("sends a GET of the check address to the sign-in form", async () => {
    const { shell, sent } = stubShell(() => null, { now: AT });
    const response = await shell.fetch(get("/test/sign-in/check?attempt=dummy"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/test/sign-in");
    expect(sent).toEqual([]);
  });

  it("refuses a sign-in form posted from another site before any call, as the shell refuses every such POST", async () => {
    const { shell, sent } = stubShell(() => CHECK_OUTCOMES[0], { now: AT });
    const response = await shell.fetch(
      post("/test/sign-in/check", CHECK, DEVICE, { origin: "https://example.invalid" }),
    );
    expect(response.status).toBe(403);
    expect(sent).toEqual([]);
  });
});

describe("sign-out", () => {
  it("shows its one button on a GET, and makes no call", async () => {
    const { shell, sent } = stubShell(() => null, { now: AT });
    const response = await shell.fetch(
      get("/test/sign-out", { cookie: `${NAMES.session}=dummy-session-token-0001` }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<form method="post" action="/test/sign-out">');
    expect(hiddenFields(html)).toEqual({ requestId: "req-made-in-test-1" });
    expect(sent).toEqual([]);
  });

  it("with no session in the browser, clears the cookie and makes no call", async () => {
    const { shell, sent } = stubShell(() => null, { now: AT });
    const response = await shell.fetch(post("/test/sign-out", { requestId: "req-dummy-out-0001" }));
    expect(response.status).toBe(200);
    expect(sent).toEqual([]);
    expect(response.headers.getSetCookie()).toEqual([`${NAMES.session}=; Max-Age=0; ${ATTRIBUTES}`]);
  });
});

describe("the device cookie: a random value set once per browser", () => {
  it("is set on the sign-in page for a browser that has none, or one that does not read as one", async () => {
    for (const cookie of ["", `${NAMES.device}=short`, `${NAMES.device}=dummy device token`]) {
      const { shell } = stubShell(() => null, { now: AT });
      const response = await shell.fetch(get("/test/sign-in", cookie === "" ? {} : { cookie }));
      expect(response.headers.getSetCookie(), cookie).toEqual([
        `${NAMES.device}=dummy-device-token-made-in-test; Max-Age=${String(DEVICE_COOKIE_SECONDS)}; ${ATTRIBUTES}`,
      ]);
    }
    expect(DEVICE_COOKIE_SECONDS).toBe(34_560_000);
  });

  it("is made for a start posted without one, sent with the call and set on the answer", async () => {
    const { shell, sent } = stubShell(() => START_OUTCOMES[0], { now: AT });
    const response = await shell.fetch(
      post("/test/sign-in", {
        requestId: "req-dummy-start-0001",
        account: "dummy@lee.example",
        way: "email",
      }),
    );
    expect((sent[0]?.request as { deviceToken: string }).deviceToken).toBe("dummy-device-token-made-in-test");
    expect(cookiePair(response.headers.getSetCookie()[0] ?? "")).toEqual({
      [NAMES.device]: "dummy-device-token-made-in-test",
    });
  });

  it("is 256 random bits in letters a cookie holds, never one twice", () => {
    const made = Array.from({ length: 50 }, () => newDeviceToken());
    expect(new Set(made).size).toBe(50);
    for (const token of made) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deviceTokenOf(get("/test/x", { cookie: `${NAMES.device}=${made[0] ?? ""}` }), STAGING)).toBe(
      made[0],
    );
  });
});

describe("the routes as the Worker gets them, and what is never logged", () => {
  it("lists the three routes in the folder's own ROUTES, which the shell serves on staging and in production", async () => {
    expect(ROUTES.map((route) => [route.label, route.path, route.methods])).toEqual([
      ["auth.signIn", "/sign-in", ["GET", "POST"]],
      ["auth.signInCheck", "/sign-in/check", ["GET", "POST"]],
      ["auth.signOut", "/sign-out", ["GET", "POST"]],
    ]);
    for (const environment of ["staging", "production"] as const) {
      const { shell, config } = testShell({ environment });
      const response = await shell.fetch(get(`${config.basePath}/sign-in`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<form method="post" action="${config.basePath}/sign-in">`);
      expect(html.includes("So do testers on staging.")).toBe(environment === "staging");
      // The Worker's own ids: a new request id for each form, and a new device token for each new browser.
      expect(hiddenFields(html).requestId).toMatch(/^[0-9a-f-]{36}$/);
      const set = response.headers.getSetCookie();
      expect(set).toHaveLength(1);
      expect(set[0]).toMatch(
        environment === "staging"
          ? /^__Secure-rosie-device-test=[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/test; HttpOnly; Secure; SameSite=Lax$/
          : /^__Secure-rosie-device=[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
      );
    }
    expect(cookieNames(PRODUCTION)).toEqual({
      session: "__Secure-rosie-session",
      device: "__Secure-rosie-device",
      pause: "__Secure-rosie-sign-in-pause",
    });
  });

  it("writes the shell's one line per request, with nothing typed, no code, no token and no attempt in it", async () => {
    const answers: Record<string, unknown> = {
      signInStart: START_OUTCOMES[1],
      signInCheck: CHECK_OUTCOMES[0],
      signOut: { result: "signedOut", repeated: false },
    };
    const { shell, rawLines } = stubShell((call) => answers[call], { now: AT });
    const browser = { ...DEVICE, [NAMES.session]: "dummy-session-token-0001" };
    await shell.fetch(get("/test/sign-in?link=dummy-link-01", { cookie: cookies(browser) }));
    await shell.fetch(
      post(
        "/test/sign-in",
        { requestId: "req-dummy-start-0001", account: "dummy@lee.example", way: "text" },
        browser,
      ),
    );
    await shell.fetch(post("/test/sign-in/check", CHECK, browser));
    await shell.fetch(post("/test/sign-in/check", { ...CHECK, code: "12ab" }, browser));
    await shell.fetch(post("/test/sign-out", { requestId: "req-dummy-out-0001" }, browser));
    const lines = rawLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line.route, line.status])).toEqual([
      ["auth.signIn", 200],
      ["auth.signIn", 200],
      ["auth.signInCheck", 200],
      ["auth.signInCheck", 400],
      ["auth.signOut", 200],
    ]);
    for (const line of lines)
      expect(Object.keys(line)).toEqual(["level", "msg", "trace_id", "route", "status"]);
    for (const value of ["dummy", "lee.example", "123456", "12ab", "000000", "attempt", "req-", "sms:"])
      expect(rawLines().join("\n")).not.toContain(value);
  });
});
