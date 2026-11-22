// T-512's proofs for the signed-link opener (C-185; A4-42; K-21 v1 openLink; FS line 701; S13-45): with
// open-link-secure-page.json the page renders its page type and only the fields the response allows; with
// open-link-expired.json the expired page shows and no field of the old page; and the client never sends a request
// shaped like refuse-link-as-proof.json (no identity claim from opening a link), nor takes such an answer as proof.
// Beside them: open-link-signed-in.json (the link's own person's session), and the route's own rules. The shell runs on
// the Tool API mock (test-support.ts); every value is a K-21 fixture's placeholder or made up (rule 9).
import { describe, expect, it } from "vitest";
import { isPageError, type OutcomeOf } from "../client/calls";
import { cookieNames } from "../auth/cookies";
import { authModule } from "../auth/test-support";
import { renderErrorPage } from "../shell/error-pages";
import { readWebConfig } from "../shell/config";
import { escapeHtml } from "../shell/frame";
import { TEST_LINK_HOST, TRACE_ID, attributeValues, get, testVars } from "../shell/test-support";
import { PAGE_KIND_WORDS, SECTION_WORDS, type PageKind, type PageSection } from "./kinds";
import { LINK_LABEL } from "./open";
import {
  EXPIRED_STATUS,
  EXPIRED_WORDS,
  NOT_OPENED_WORDS,
  SECTIONS_HEADING,
  SIGNED_IN_WORDS,
  SIGN_IN_WORDS,
} from "./pages";
import {
  linkPath,
  mockLinkShell,
  openLinkFixture,
  stubLinkShell,
  type OpenLinkExchange,
} from "./test-support";

const SECURE = openLinkFixture("open-link-secure-page.json");
const SIGNED_IN = openLinkFixture("open-link-signed-in.json");
const EXPIRED = openLinkFixture("open-link-expired.json");
const AS_PROOF = openLinkFixture("invalid/refuse-link-as-proof.json");

const ALL_KINDS = Object.keys(PAGE_KIND_WORDS) as PageKind[];
const ALL_SECTIONS = Object.keys(SECTION_WORDS) as PageSection[];

/** A fixture's answer that opens a page (never one of openLink's errors). */
function opened(fixture: OpenLinkExchange): Exclude<OutcomeOf<"openLink">, { error: string }> {
  if (isPageError(fixture.outcome)) throw new Error("this fixture's answer does not open a page");
  return fixture.outcome;
}

/** The words of every page kind and every section, as a page holds them (escaped). */
function kindAndSectionWords(): string[] {
  return [
    ...ALL_KINDS.flatMap((kind) => [PAGE_KIND_WORDS[kind].title, PAGE_KIND_WORDS[kind].purpose]),
    ...ALL_SECTIONS.map((section) => SECTION_WORDS[section]),
  ].map(escapeHtml);
}

/** The session cookie a browser signed in on staging sends, holding `token` (auth/cookies.ts). */
function sessionCookie(token: string): string {
  return `${cookieNames(readWebConfig(testVars("staging"))).session}=${encodeURIComponent(token)}`;
}

/** An answer's headers as name and value pairs, the trace id left out (each request has its own). */
function headersBesideTrace(response: Response): [string, string][] {
  return [...response.headers].filter(([name]) => name !== "x-trace-id");
}

describe("with open-link-secure-page.json the page renders its page type and only the fields the response allows", () => {
  it("sends exactly the fixture's request, once, under the page request's trace id", async () => {
    const { shell, config, transport } = mockLinkShell(SECURE);
    const response = await shell.fetch(get(linkPath(config, SECURE)));
    expect(response.status).toBe(200);
    expect(transport.sent).toEqual([
      { call: "openLink", request: SECURE.request, traceId: SECURE.request.page.traceId },
    ]);
  });

  it("shows what the page is for, the business's public name, its sections' names and the sign-in for the link's own account", async () => {
    const { shell, config } = mockLinkShell(SECURE);
    const html = await (await shell.fetch(get(linkPath(config, SECURE)))).text();
    const kind = PAGE_KIND_WORDS[opened(SECURE).pageKind];
    expect(opened(SECURE).pageKind).toBe("setupIdCheck");
    expect(html).toContain(`<title>${escapeHtml(kind.title)}</title>`);
    expect(html).toContain(`<h1>${escapeHtml(kind.title)}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(kind.purpose)}</p>`);
    expect(html).toContain("<p>For Lee&#39;s Barbershop</p>");
    expect(html).toContain(
      [
        `<h2>${SECTIONS_HEADING}</h2>`,
        "<ul>",
        `<li>${escapeHtml(SECTION_WORDS.idUpload)}</li>`,
        `<li>${escapeHtml(SECTION_WORDS.ownerEmail)}</li>`,
        "</ul>",
      ].join("\n"),
    );
    // Both ways, whatever is on file: the sign-in page the link opens offers email and text alike.
    expect(html).toContain(`<h2>${escapeHtml(SIGN_IN_WORDS.heading)}</h2>`);
    expect(html).toContain(`<p>${escapeHtml(SIGN_IN_WORDS.why)}</p>`);
    expect(html).toContain(`<p>${escapeHtml(SIGN_IN_WORDS.ways)}</p>`);
    expect(attributeValues(html, "href")).toEqual([
      "#main",
      "/test/sign-in?link=s01-placeholder-sam",
      "/test/privacy",
    ]);
  });

  it("shows nothing else: no time, no step id, no one it acts for, no other page's words, nothing signed in, no form", async () => {
    const { shell, config } = mockLinkShell(SECURE);
    const html = await (await shell.fetch(get(linkPath(config, SECURE)))).text();
    for (const absent of [
      "2026-10-26",
      "14:20",
      "<time",
      opened(SECURE).stepId,
      "person-",
      escapeHtml(SIGNED_IN_WORDS),
      "/test/sign-out",
      "<form",
      "<input",
      "<script",
    ])
      expect(html, absent).not.toContain(absent);
    const shown = new Set([
      ...[PAGE_KIND_WORDS.setupIdCheck.title, PAGE_KIND_WORDS.setupIdCheck.purpose].map(escapeHtml),
      ...opened(SECURE).sections.map((section) => escapeHtml(SECTION_WORDS[section])),
    ]);
    for (const words of kindAndSectionWords()) {
      if (shown.has(words)) expect(html, words).toContain(words);
      else expect(html, words).not.toContain(words);
    }
  });

  it("writes one log line under the route's fixed label, holding nothing of the link or the page", async () => {
    const { shell, config, lines, rawLines } = mockLinkShell(SECURE);
    await shell.fetch(get(linkPath(config, SECURE)));
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: SECURE.request.page.traceId, route: LINK_LABEL, status: 200 },
    ]);
    for (const value of ["s01-placeholder-sam", "Lee", "S1-10", "req-link-sam-s01-1"])
      expect(rawLines().join("\n")).not.toContain(value);
  });
});

describe("with open-link-signed-in.json, a session of the link's own person: the page may say so", () => {
  const TOKEN = SIGNED_IN.request.page.sessionToken ?? "";

  it("sends the session cookie's token in the envelope, and nothing else: exactly the fixture's request", async () => {
    const { shell, config, transport } = mockLinkShell(SIGNED_IN);
    const response = await shell.fetch(get(linkPath(config, SIGNED_IN), { cookie: sessionCookie(TOKEN) }));
    expect(response.status).toBe(200);
    expect(transport.sent).toEqual([
      { call: "openLink", request: SIGNED_IN.request, traceId: SIGNED_IN.request.page.traceId },
    ]);
  });

  it("says the reader is signed in, with the page's kind, sections and the link's end, and no sign-in offer", async () => {
    const { shell, config } = mockLinkShell(SIGNED_IN);
    const html = await (
      await shell.fetch(get(linkPath(config, SIGNED_IN), { cookie: sessionCookie(TOKEN) }))
    ).text();
    expect(html).toContain(`<h1>${escapeHtml(PAGE_KIND_WORDS.staffPage.title)}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(SIGNED_IN_WORDS)}</p>`);
    expect(html).toContain("<p>For Lee&#39;s Barbershop</p>");
    for (const section of opened(SIGNED_IN).sections)
      expect(html).toContain(`<li>${escapeHtml(SECTION_WORDS[section])}</li>`);
    expect(html).toContain(
      '<p>This link works until <time datetime="2026-10-27T15:00:00Z">2026-10-27 15:00 UTC</time>.</p>',
    );
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/sign-out", "/test/privacy"]);
    for (const absent of [escapeHtml(SIGN_IN_WORDS.heading), "/test/sign-in", "person-riley", "S2-06", TOKEN])
      expect(html, absent).not.toContain(absent);
  });
});

describe("with open-link-expired.json the expired page shows and no field of the old page", () => {
  it("sends the fixture's request and shows the plain expired page", async () => {
    const { shell, config, transport } = mockLinkShell(EXPIRED);
    const response = await shell.fetch(get(linkPath(config, EXPIRED)));
    expect(response.status).toBe(EXPIRED_STATUS);
    expect(transport.sent).toEqual([
      { call: "openLink", request: EXPIRED.request, traceId: EXPIRED.request.page.traceId },
    ]);
    const html = await response.text();
    expect(html).toContain(`<title>${escapeHtml(EXPIRED_WORDS.title)}</title>`);
    expect(html).toContain(
      [
        `<h1>${escapeHtml(EXPIRED_WORDS.title)}</h1>`,
        ...EXPIRED_WORDS.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
      ].join("\n"),
    );
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/privacy"]);
  });

  it("holds no field of the page the link opened: no business, page kind, section, sign-in, time or code", async () => {
    const { shell, config } = mockLinkShell(EXPIRED);
    const html = await (await shell.fetch(get(linkPath(config, EXPIRED)))).text();
    for (const absent of [
      ...kindAndSectionWords(),
      "Lee",
      opened(SECURE).stepId,
      "s01-placeholder-sam",
      escapeHtml(SECTIONS_HEADING),
      escapeHtml(SIGN_IN_WORDS.heading),
      escapeHtml(SIGNED_IN_WORDS),
      "<time",
      "<form",
    ])
      expect(html, absent).not.toContain(absent);
  });

  it("is one page for every code that does not open, unknown, lapsed or ended alike, byte for byte", async () => {
    const { shell, config } = mockLinkShell(EXPIRED);
    const fixture = await shell.fetch(get(linkPath(config, EXPIRED)));
    const expected = await fixture.text();
    const stub = stubLinkShell(() => ({ error: "linkExpired" }));
    for (const code of ["dummy-unknown-code-0001", "s206-placeholder-riley", "abc"]) {
      const response = await stub.shell.fetch(get(`/test/${code}`));
      expect(response.status, code).toBe(EXPIRED_STATUS);
      expect(headersBesideTrace(response), code).toEqual(headersBesideTrace(fixture));
      expect(await response.text(), code).toBe(expected);
    }
  });
});

describe("the client never sends a request shaped like refuse-link-as-proof.json (no identity claim from opening a link)", () => {
  it("is the refused fixture's request the link's own: its one fault is an answer that took the link as proof", () => {
    expect(AS_PROOF.request).toEqual(SECURE.request);
    expect(AS_PROOF.request.page.sessionToken).toBeNull();
  });

  it("sends the envelope alone, whatever the browser adds: no query, header or other cookie names anyone or brings a session", async () => {
    const { shell, config, transport } = mockLinkShell(SECURE);
    const response = await shell.fetch(
      get(
        `${linkPath(config, SECURE)}?personId=person-sam&proof=session&acting=person-sam&securePageOnly=true`,
        {
          "x-person-id": "person-sam",
          authorization: "Bearer dummy-token-0000000001",
          cookie: [
            "acting=person-sam",
            "session=dummy-session-token-0001",
            // Production's session cookie, which staging never reads as its own (auth/cookies.ts).
            "__Secure-rosie-session=placeholder-session-token-sam-0001",
            // Staging's own name, holding no value that reads as a token (under 16 characters).
            sessionCookie("short"),
          ].join("; "),
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(transport.sent).toEqual([
      { call: "openLink", request: SECURE.request, traceId: SECURE.request.page.traceId },
    ]);
    const request = transport.sent[0]?.request as typeof SECURE.request;
    expect(Object.keys(request)).toEqual(["page"]);
    expect(Object.keys(request.page)).toEqual(["requestId", "traceId", "sessionToken", "linkCode"]);
    expect(request.page.sessionToken).toBeNull();
    for (const claim of ["person", "acting", "proof", "securePageOnly", "dummy"])
      expect(JSON.stringify(request), claim).not.toContain(claim);
  });

  it("shows an answer shaped like refuse-link-as-proof.json's, to a request with no session, exactly as open-link-secure-page.json's answer: never as proof", async () => {
    expect(opened(AS_PROOF).proof).toBe("session");
    const stub = stubLinkShell(() => AS_PROOF.outcome);
    const claimed = await stub.shell.fetch(get(linkPath(stub.config, AS_PROOF)));
    expect((stub.sent[0]?.request as typeof SECURE.request).page.sessionToken).toBeNull();
    const { shell, config } = mockLinkShell(SECURE);
    const shown = await shell.fetch(get(linkPath(config, SECURE)));
    expect(claimed.status).toBe(200);
    const html = await claimed.text();
    expect(html).toBe(await shown.text());
    expect(html).toContain(`<h2>${escapeHtml(SIGN_IN_WORDS.heading)}</h2>`);
    for (const absent of [escapeHtml(SIGNED_IN_WORDS), "person-sam", "<time", "/test/sign-out"])
      expect(html, absent).not.toContain(absent);
  });
});

describe("the link route: the host plus a short code, under BASE_PATH", () => {
  it.each([
    "/test/ab",
    "/test/bad_code",
    "/test/%3Cb%3E",
    `/test/${"a".repeat(65)}`,
    "/test/privacy.html",
    "/test/s01.placeholder",
  ])("%s: not a link's short code, so the shell's 404 page and nothing is sent", async (path) => {
    const { shell, transport } = mockLinkShell(SECURE);
    const response = await shell.fetch(get(path, { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      renderErrorPage({ status: 404, basePath: "/test", traceId: TRACE_ID }),
    );
    expect(transport.sent).toEqual([]);
  });

  it("leaves every exact path its own page: sign-in, sign-out and the privacy notice are never taken for a link", async () => {
    const { shell, transport, lines } = mockLinkShell(SECURE, [authModule()]);
    for (const path of ["/test/sign-in", "/test/sign-out", "/test/privacy"])
      expect((await shell.fetch(get(path))).status, path).toBe(200);
    expect(transport.sent).toEqual([]);
    expect(lines().map((line) => line.route)).toEqual(["auth.signIn", "auth.signOut", "privacy"]);
  });

  it("is under BASE_PATH: on staging a code at the site's root is no page, and nothing is sent", async () => {
    const { shell, transport } = mockLinkShell(SECURE);
    expect((await shell.fetch(get("/s01-placeholder-sam"))).status).toBe(404);
    expect(shell.serve(get("/s01-placeholder-sam"))).toBeNull();
    expect(transport.sent).toEqual([]);
  });

  it("is at the site's root in production, where BASE_PATH is empty", async () => {
    const stub = stubLinkShell(() => ({ error: "linkExpired" }), "production");
    expect((await stub.shell.fetch(get("/s01-placeholder-sam"))).status).toBe(EXPIRED_STATUS);
    expect((await stub.shell.fetch(get("/test/s01-placeholder-sam"))).status).toBe(404);
    expect(stub.sent.map((sent) => (sent.request as typeof SECURE.request).page.linkCode)).toEqual([
      "s01-placeholder-sam",
    ]);
  });

  it("takes GET and HEAD only: a POST gets the shell's 405 page and nothing is sent", async () => {
    const { shell, config, transport } = mockLinkShell(SECURE);
    const response = await shell.fetch(
      new Request(`https://${TEST_LINK_HOST}${linkPath(config, SECURE)}`, {
        method: "POST",
        headers: { origin: `https://${TEST_LINK_HOST}` },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(transport.sent).toEqual([]);
  });

  it("gives HEAD the GET answer's status and headers, with no body", async () => {
    const { shell, config } = mockLinkShell(SECURE);
    const got = await shell.fetch(get(linkPath(config, SECURE)));
    const head = await shell.fetch(
      new Request(`https://${TEST_LINK_HOST}${linkPath(config, SECURE)}`, { method: "HEAD" }),
    );
    expect(head.status).toBe(got.status);
    expect([...head.headers]).toEqual([...got.headers]);
    expect(await head.text()).toBe("");
  });

  const NOT_OPENED: readonly OutcomeOf<"openLink">[] = [
    { error: "transient", sqlstate: "40001" },
    { error: "bookingPaused", retryAfterSeconds: 30 },
  ];

  it.each(NOT_OPENED)(
    "$error: the page that could not open (503), with no field of a page",
    async (outcome) => {
      const stub = stubLinkShell(() => outcome);
      const response = await stub.shell.fetch(get("/test/s01-placeholder-sam"));
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(html).toContain(`<h1>${escapeHtml(NOT_OPENED_WORDS.title)}</h1>`);
      expect(attributeValues(html, "href")).toEqual(["#main", "/test/privacy"]);
      for (const absent of [
        ...kindAndSectionWords(),
        escapeHtml(SIGN_IN_WORDS.heading),
        "s01-placeholder-sam",
      ])
        expect(html, absent).not.toContain(absent);
    },
  );
});
