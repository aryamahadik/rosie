// T-1534's web proofs (S1-10 slice card S10-8; K-09 README defaults 212 and 213; D4 and D5 of the S1-10 ruling): the
// link route is listed (ROUTES = linkRoutes()), so the web app the Worker serves opens a link; and S1-10's setupIdCheck
// page is the honest page: the title "Secure ID upload", "For <business>", and in place of its sections' contents the two
// lines "The ID upload is not open yet." and "Nothing goes live until your ID is uploaded.", with or without a session
// of the link's own person, with no upload control, form, script or email step. Every value is a K-21 fixture's
// placeholder or made up (rule 9).
import { describe, expect, it } from "vitest";
import { cookieNames } from "../auth/cookies";
import type { OutcomeOf, RequestOf } from "../client/calls";
import { ROUTE_MODULES } from "../routes";
import { readWebConfig } from "../shell/config";
import { escapeHtml } from "../shell/frame";
import { createWebShell } from "../shell/shell";
import { TRACE_ID, attributeValues, get, rethrow, testVars } from "../shell/test-support";
import { PAGE_KIND_WORDS, SECTION_WORDS } from "./kinds";
import { LINK_LABEL, LINK_PATH } from "./open";
import { EXPIRED_STATUS, HONEST_LINES, SIGN_IN_WORDS, SIGNED_IN_WORDS } from "./pages";
import { ROUTES } from "./routes";
import { stubLinkShell } from "./test-support";

/** A made code in its one made form (K-09 README default 211: 32 lowercase hex), made up. */
const CODE = "0123456789abcdef0123456789abcdef";

/** openLink's answer as staging's handler gives it for a live S1-10 link, before proof (default 212 (5)). */
const STAGING_OPEN: OutcomeOf<"openLink"> = {
  result: "open",
  pageKind: "setupIdCheck",
  stepId: "S1-10",
  businessName: "Lee's Barbershop",
  proof: "none",
  acting: null,
  securePageOnly: false,
  sections: ["idUpload"],
  signIn: { ways: ["email", "text"] },
  expiresAt: "2026-10-26T14:20:00Z",
};

/** The same link opened with a session of the link's own person (proof session). */
const STAGING_PROVEN: OutcomeOf<"openLink"> = {
  ...STAGING_OPEN,
  proof: "session",
  acting: { personId: "person-dummy-owner-1" },
  signIn: null,
};

const HONEST = ["The ID upload is not open yet.", "Nothing goes live until your ID is uploaded."];

describe("ROUTES lists the link route, so the web app the Worker serves opens a link", () => {
  it("is linkRoutes(): the one GET /:code route under its fixed label", () => {
    expect(ROUTES.map((route) => [route.label, route.path, route.methods])).toEqual([
      [LINK_LABEL, LINK_PATH, ["GET"]],
    ]);
    const link = ROUTE_MODULES.find((module) => module.folder === "link");
    expect(link?.routes).toBe(ROUTES);
    expect(link?.stagingOnly).toBe(false);
    expect(ROUTE_MODULES.at(-1)).toBe(link);
  });

  it("serves a made code through openLink on the shell's own route lists, and the expired page for linkExpired", async () => {
    const sent: { call: string; request: unknown }[] = [];
    const lines: string[] = [];
    const shell = createWebShell({
      config: readWebConfig(testVars("staging")),
      transport: {
        send(call, request) {
          sent.push({ call, request });
          return Promise.resolve({ error: "linkExpired" });
        },
      },
      log: (line) => lines.push(line),
      onRouteError: rethrow,
      newTraceId: () => TRACE_ID,
    });
    const response = await shell.fetch(get(`/test/${CODE}`));
    expect(response.status).toBe(EXPIRED_STATUS);
    expect(sent.map((call) => call.call)).toEqual(["openLink"]);
    expect((sent[0]?.request as RequestOf<"openLink">).page.linkCode).toBe(CODE);
    // The shell's one line holds the route's fixed label, never the code.
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: "info", msg: "page", trace_id: TRACE_ID, route: LINK_LABEL, status: EXPIRED_STATUS },
    ]);
    expect(lines.join("\n")).not.toContain(CODE);
  });
});

describe("S1-10's setupIdCheck page is the honest page (default 213)", () => {
  it("holds the default's words: two lines, standing until Jay gives words", () => {
    expect(PAGE_KIND_WORDS.setupIdCheck.title).toBe("Secure ID upload");
    expect(HONEST_LINES).toEqual({ setupIdCheck: HONEST });
  });

  it("before proof: the title, For <business>, the idUpload section's name, the two lines in place of its contents, and the sign-in offer", async () => {
    const stub = stubLinkShell(() => STAGING_OPEN);
    const response = await stub.shell.fetch(get(`/test/${CODE}`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Secure ID upload</title>");
    expect(html).toContain("<h1>Secure ID upload</h1>");
    expect(html).toContain("<p>For Lee&#39;s Barbershop</p>");
    expect(html).toContain(
      [
        `<li>${escapeHtml(SECTION_WORDS.idUpload)}</li>`,
        "</ul>",
        ...HONEST.map((line) => `<p>${escapeHtml(line)}</p>`),
        `<h2>${escapeHtml(SIGN_IN_WORDS.heading)}</h2>`,
      ].join("\n"),
    );
    expect(attributeValues(html, "href")).toEqual(["#main", `/test/sign-in?link=${CODE}`, "/test/privacy"]);
  });

  it("with a session of the link's own person: the same two lines, the signed-in line and the sign-out", async () => {
    const stub = stubLinkShell(() => STAGING_PROVEN);
    const session = `${cookieNames(stub.config).session}=dummy-session-token-0001`;
    const html = await (await stub.shell.fetch(get(`/test/${CODE}`, { cookie: session }))).text();
    expect((stub.sent[0]?.request as RequestOf<"openLink">).page.sessionToken).toBe(
      "dummy-session-token-0001",
    );
    expect(html).toContain("<h1>Secure ID upload</h1>");
    expect(html).toContain(`<p>${escapeHtml(SIGNED_IN_WORDS)}</p>`);
    for (const line of HONEST) expect(html).toContain(`<p>${escapeHtml(line)}</p>`);
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/sign-out", "/test/privacy"]);
    expect(html).not.toContain(escapeHtml(SIGN_IN_WORDS.heading));
  });

  it("holds no upload control, form, script or email step, names no person or time before proof, and promises nothing", async () => {
    const stub = stubLinkShell(() => STAGING_OPEN);
    const html = await (await stub.shell.fetch(get(`/test/${CODE}`))).text();
    for (const absent of [
      "<form",
      "<input",
      "<button",
      "<script",
      'type="file"',
      escapeHtml(SECTION_WORDS.ownerEmail),
      "person-",
      "<time",
      "2026-10-26",
      "S1-10",
      "we'll",
      "we will",
      "when it opens",
    ])
      expect(html, absent).not.toContain(absent);
  });

  it("is setupIdCheck's alone: another page kind, the expired page and the page that could not open show neither line", async () => {
    const staff = stubLinkShell(() => ({
      ...STAGING_OPEN,
      pageKind: "staffPage",
      stepId: "S2-06",
      sections: ["profile"],
    }));
    const expired = stubLinkShell(() => ({ error: "linkExpired" }));
    const notOpened = stubLinkShell(() => ({ error: "transient", sqlstate: "40001" }));
    for (const stub of [staff, expired, notOpened]) {
      const html = await (await stub.shell.fetch(get(`/test/${CODE}`))).text();
      for (const line of HONEST) expect(html, line).not.toContain(escapeHtml(line));
    }
  });
});
