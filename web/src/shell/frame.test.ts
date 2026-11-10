// The page frame (T-1171): every page it makes carries the footer's privacy link at BASE_PATH + "/privacy" (RULES 4.3;
// Q-30), with its language, title, skip link and landmarks (RULES 4.11), and the frame refuses a base path that is not
// one, so no page links outside the site.
import { describe, expect, it } from "vitest";
import {
  BasePathError,
  PRIVACY_PATH,
  basePathOf,
  escapeHtml,
  htmlComment,
  privacyHref,
  renderFooter,
  renderPage,
  type FramedPage,
} from "./frame";

/** A made-up page, not one of web's: the frame gives any page the footer. */
const EXAMPLE: FramedPage = {
  basePath: "/test",
  path: "/example",
  title: "Example <page>",
  main: "<h1>Example</h1>",
  noindex: false,
};

describe("basePathOf: BASE_PATH as the Worker reads it", () => {
  it("takes the empty base path and /segments, dropping closing slashes as the Worker does", () => {
    expect(basePathOf("")).toBe("");
    expect(basePathOf("/")).toBe("");
    expect(basePathOf("/test")).toBe("/test");
    expect(basePathOf("/test/")).toBe("/test");
    expect(basePathOf("/test/pr-12")).toBe("/test/pr-12");
  });

  it("refuses anything that is not a base path, so a link never leaves the site", () => {
    for (const raw of [
      "test",
      "/Test",
      "//evil.example",
      "https://evil.example",
      "/test?x=1",
      "/test#x",
      "/te st",
      "/../x",
      '/test"><b>',
    ])
      expect(() => basePathOf(raw), raw).toThrow(BasePathError);
  });
});

describe("the footer every page carries", () => {
  it("links to the privacy notice at BASE_PATH + /privacy", () => {
    expect(privacyHref("/test")).toBe("/test/privacy");
    expect(privacyHref("")).toBe("/privacy");
    expect(renderFooter("/test", "/example")).toBe(
      '<footer>\n<p><a href="/test/privacy">Privacy notice</a></p>\n</footer>',
    );
  });

  it("marks the link as the current page only on the privacy notice", () => {
    expect(renderFooter("", PRIVACY_PATH)).toContain('<a href="/privacy" aria-current="page">');
    expect(renderFooter("", "/example")).not.toContain("aria-current");
  });

  it("is in every page the frame makes, after the main landmark, on staging and in production", () => {
    for (const basePath of ["/test", ""]) {
      const html = renderPage({ ...EXAMPLE, basePath });
      expect(html).toContain(renderFooter(basePath, EXAMPLE.path));
      expect(html.indexOf("<footer>")).toBeGreaterThan(html.indexOf("</main>"));
    }
  });

  it("refuses a page whose base path is not one", () => {
    expect(() => renderPage({ ...EXAMPLE, basePath: "//evil.example" })).toThrow(BasePathError);
  });
});

describe("the frame gives each page what WCAG 2.1 AA asks of it (RULES 4.11)", () => {
  it("writes the language, the escaped title, a skip link to the main landmark, and the page inside main", () => {
    const html = renderPage(EXAMPLE);
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n')).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("<title>Example &lt;page&gt;</title>");
    expect(html).toContain('<a class="skip" href="#main">Skip to main content</a>');
    expect(html).toContain('<main id="main" tabindex="-1">\n<h1>Example</h1>\n</main>');
  });

  it("asks search engines not to index a page only when the page says so", () => {
    expect(renderPage(EXAMPLE)).not.toContain('name="robots"');
    expect(renderPage({ ...EXAMPLE, noindex: true })).toContain('<meta name="robots" content="noindex">');
  });

  it("adds no script and no form of its own", () => {
    expect(renderPage(EXAMPLE)).not.toMatch(/<script|<form|<input|<link|<img|<iframe/i);
  });
});

describe("escapeHtml and htmlComment", () => {
  it("escapes the five characters HTML reads", () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &#39; f");
  });

  it("writes a source note as a comment, and refuses text that could end the comment early", () => {
    expect(htmlComment("Stand-in words.")).toBe("<!-- Stand-in words. -->");
    for (const text of ["a -- b", "a > b", "a < b", "-->"]) expect(() => htmlComment(text), text).toThrow();
  });
});
