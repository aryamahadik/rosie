// T-1171's proof: the privacy notice page renders at BASE_PATH + "/privacy" with Q-30's stand-in words, each page's
// footer links to it, and it sets no cookie, loads no outside script, holds no form or tracking and shows the same page
// to every reader (no personal data). BASE_PATH is the config value wrangler.jsonc sets (Q-51), read as T-1146's
// fixed-lines module reads it, and the page answers at the very address bundle v0's privacyLink line names, the last
// line of Rosie's first text. Request values are made up (rule 9): a documentation IP address and dummy tokens.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRIVACY_LINK_LINE,
  privacyNoticeAddress,
  readBasePath,
  type FixedLines,
} from "../../../../compiler/src/fixed-lines";
import { PAGE_ROUTES } from "../../routes";
import { PRIVACY_LINK_LABEL, PRIVACY_PATH, escapeHtml } from "../../shell/frame";
import { servePage } from "../../shell/serve";
import {
  DRAFT_NOTE,
  NOTICE_INTRO,
  NOTICE_SECTIONS,
  NOTICE_STATUS,
  NOTICE_TITLE,
  PAGE_TITLE,
  STAND_IN_MARKER,
} from "./notice";
import { renderPrivacyPage } from "./page";

/** wrangler.jsonc's BASE_PATH on staging ("/test") and in production (""). */
const STAGING = readBasePath("staging");
const PRODUCTION = readBasePath("production");

/** Bundle v0's manifest, as a turn pinned to it reads its fixed lines (K-01 v1 lists.fixedLines). */
const V0 = JSON.parse(
  readFileSync(new URL("../../../../bundles/v0/bundle/manifest.json", import.meta.url), "utf8"),
) as { lists: { fixedLines: FixedLines } };

/** web's answer to `url` on BASE_PATH `basePath`; fails the test when web gives none. */
function answer(url: string, basePath: string, init?: RequestInit): Response {
  const response = servePage(new Request(url, init), basePath);
  if (response === null) throw new Error(`no page answers ${url} with BASE_PATH "${basePath}"`);
  return response;
}

/** The page's HTML at `url`, checked to be a 200 HTML answer. */
async function pageAt(url: string, basePath: string, init?: RequestInit): Promise<string> {
  const response = answer(url, basePath, init);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  return response.text();
}

/** Every value of `attribute` in `html`. */
function attributeValues(html: string, attribute: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, "g"))].map((match) => match[1] ?? "");
}

/** The one footer of `html`. */
function footerOf(html: string): string {
  const footers = html.match(/<footer>[\s\S]*?<\/footer>/g) ?? [];
  expect(footers).toHaveLength(1);
  return footers[0] ?? "";
}

describe("the privacy notice is served at BASE_PATH + /privacy", () => {
  it("answers rosfield.com/test/privacy on staging, BASE_PATH being wrangler.jsonc's /test", async () => {
    expect(STAGING).toBe("/test");
    const html = await pageAt("https://rosfield.com/test/privacy", STAGING);
    expect(html).toBe(renderPrivacyPage(STAGING));
    expect(html).toContain(`<h1>${NOTICE_TITLE}</h1>`);
  });

  it("answers rosfield.com/privacy in production, where BASE_PATH is empty", async () => {
    expect(PRODUCTION).toBe("");
    const html = await pageAt("https://rosfield.com/privacy", PRODUCTION);
    expect(html).toBe(renderPrivacyPage(PRODUCTION));
  });

  it("answers at the address Rosie's first text names: bundle v0's privacyLink line and the line's own address", async () => {
    const line = V0.lists.fixedLines.lines.find(
      (fixed) => fixed.id === PRIVACY_LINK_LINE && fixed.lang === "en",
    );
    const prefix = `${PRIVACY_LINK_LABEL}: `;
    expect(line?.text?.startsWith(prefix)).toBe(true);
    const address = line?.text?.slice(prefix.length) ?? "";
    expect(address).toBe(privacyNoticeAddress(STAGING));
    expect(address).toBe(`rosfield.com${STAGING}${PRIVACY_PATH}`);
    await pageAt(`https://${address}`, STAGING);
    // A phone may open the bare address over http before the site sends it on to https: the path is the same.
    await pageAt(`http://${address}`, STAGING);
    await pageAt(`https://${privacyNoticeAddress(PRODUCTION)}`, PRODUCTION);
  });

  it("serves the page at no other path, so every other path stays the Worker's", () => {
    for (const path of [
      "/privacy",
      "/test",
      "/test/",
      "/test/privacy/",
      "/test/privacy/more",
      "/test/privacy.html",
      "/test/Privacy",
      "/testprivacy",
      "/test/test/privacy",
      "/test/health",
    ])
      expect(servePage(new Request(`https://rosfield.com${path}`), STAGING), path).toBeNull();
    expect(servePage(new Request("https://rosfield.com/test/privacy"), PRODUCTION)).toBeNull();
  });

  it("serves the page whatever query the link carries", async () => {
    expect(await pageAt("https://rosfield.com/test/privacy?from=text", STAGING)).toBe(
      renderPrivacyPage(STAGING),
    );
  });

  it("gives HEAD the page's headers with no body, and any other method 405 with Allow: GET, HEAD", async () => {
    const head = answer("https://rosfield.com/test/privacy", STAGING, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const refused = answer("https://rosfield.com/test/privacy", STAGING, { method });
      expect(refused.status, method).toBe(405);
      expect(refused.headers.get("allow")).toBe("GET, HEAD");
      expect(refused.headers.has("set-cookie")).toBe(false);
    }
  });
});

describe("the page shows Q-30's stand-in words, marked as waiting for Jay's words, never as final", () => {
  it("shows the title, the draft note, the introduction and every section with each of its paragraphs", async () => {
    const html = await pageAt("https://rosfield.com/test/privacy", STAGING);
    expect(html).toContain(`<title>${escapeHtml(PAGE_TITLE)}</title>`);
    expect(html).toContain(
      `<p class="draft" role="note"><strong>Draft.</strong> ${escapeHtml(DRAFT_NOTE)}</p>`,
    );
    expect(html).toContain(`<p>${escapeHtml(NOTICE_INTRO.text)}</p>`);
    expect(NOTICE_SECTIONS.length).toBeGreaterThan(0);
    for (const section of NOTICE_SECTIONS) {
      expect(html).toContain(`<h2 id="notice-${section.id}">${escapeHtml(section.heading)}</h2>`);
      for (const paragraph of section.paragraphs)
        expect(html).toContain(`<p>${escapeHtml(paragraph.text)}</p>`);
    }
  });

  it("puts the draft note before any of the notice's words, and marks the title as a draft", async () => {
    const html = await pageAt("https://rosfield.com/test/privacy", STAGING);
    const draft = html.indexOf(escapeHtml(DRAFT_NOTE));
    expect(draft).toBeGreaterThan(-1);
    expect(draft).toBeLessThan(html.indexOf(escapeHtml(NOTICE_INTRO.text)));
    expect(PAGE_TITLE).toContain("(draft)");
    expect(DRAFT_NOTE).toContain("not Rosfield's final privacy notice");
  });

  it("marks the words in the page's source as a stand-in waiting for Jay's words before production", async () => {
    expect(NOTICE_STATUS.words).toBe("standIn");
    expect(NOTICE_STATUS.waitingFor).toBe("Jay's words (Q-30), before production");
    const html = await pageAt("https://rosfield.com/test/privacy", STAGING);
    expect(html).toContain(`<!-- ${STAND_IN_MARKER} -->`);
    expect(STAND_IN_MARKER).toContain("waiting for the final words before production");
    expect(html).toContain('<article data-words="stand-in">');
    // While the words are a stand-in, search engines are asked not to show them as Rosfield's notice.
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("gives every paragraph the rule it says, in RULES.md", () => {
    for (const paragraph of [NOTICE_INTRO, ...NOTICE_SECTIONS.flatMap((section) => section.paragraphs)])
      expect(paragraph.source, paragraph.text).toMatch(/\bRULES \d+\.\d+\b/);
  });
});

describe("every page's footer links to the privacy notice (RULES 4.3; Q-30)", () => {
  it("lists the privacy notice among web's pages", () => {
    expect(PAGE_ROUTES.map((route) => route.path)).toContain(PRIVACY_PATH);
  });

  it("gives each page web serves one footer linking to BASE_PATH + /privacy, on staging and in production", async () => {
    for (const basePath of [STAGING, PRODUCTION])
      for (const route of PAGE_ROUTES) {
        const footer = footerOf(await pageAt(`https://rosfield.com${basePath}${route.path}`, basePath));
        expect(attributeValues(footer, "href")).toEqual([`${basePath}${PRIVACY_PATH}`]);
        expect(footer).toContain(`>${PRIVACY_LINK_LABEL}</a>`);
      }
  });

  it("marks the footer link as the current page on the notice itself", async () => {
    const footer = footerOf(await pageAt("https://rosfield.com/test/privacy", STAGING));
    expect(footer).toContain('<a href="/test/privacy" aria-current="page">Privacy notice</a>');
  });
});

describe("the page sets no cookie, loads nothing from outside and holds no form, tracking or personal data", () => {
  const READER = {
    cookie: "session=dummy-session-token",
    "user-agent": "Mozilla/5.0 (made-up reader)",
    "x-forwarded-for": "203.0.113.7",
    referer: "https://example.invalid/from",
  };

  it("sends the reader's made-up cookie, address and browser with the request, as a real reader's would be", () => {
    const request = new Request("https://rosfield.com/test/privacy", { headers: READER });
    for (const [name, value] of Object.entries(READER)) expect(request.headers.get(name), name).toBe(value);
  });

  it("sets no cookie, even for a reader who sends one, on GET, HEAD and a refused method", () => {
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = answer("https://rosfield.com/test/privacy", STAGING, { method, headers: READER });
      expect(response.headers.has("set-cookie"), method).toBe(false);
    }
  });

  it("holds no script or outside resource, and its security policy loads nothing but its own inline style", async () => {
    const response = answer("https://rosfield.com/test/privacy", STAGING);
    const html = await response.text();
    expect(html).not.toMatch(/<script|<link|<iframe|<frame|<img|<object|<embed|<video|<audio|<source/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(attributeValues(html, "src")).toEqual([]);
    // Each link stays on the page or on this site: the skip link and the footer's privacy link.
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/privacy"]);

    const policy = (response.headers.get("content-security-policy") ?? "").split("; ");
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? "");
    expect(styles).toHaveLength(1);
    const styleHash = createHash("sha256")
      .update(styles[0] ?? "", "utf8")
      .digest("base64");
    expect(policy).toEqual([
      "default-src 'none'",
      `style-src 'sha256-${styleHash}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("holds no form, no input and no inline event handler, and sends no referrer", async () => {
    const response = answer("https://rosfield.com/test/privacy", STAGING);
    const html = await response.text();
    expect(html).not.toMatch(/<form|<input|<button|<select|<textarea/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("shows every reader the same page: nothing from the request reaches it", async () => {
    const plain = await pageAt("https://rosfield.com/test/privacy", STAGING);
    const read = await pageAt("https://rosfield.com/test/privacy?ref=dummy-ref-42", STAGING, {
      headers: READER,
    });
    expect(read).toBe(plain);
    for (const value of ["dummy-ref-42", "dummy-session-token", "203.0.113.7", "made-up reader"])
      expect(read).not.toContain(value);
  });
});
