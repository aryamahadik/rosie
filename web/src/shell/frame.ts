// The page frame every web page renders through (T-1171; RULES 4.3 and 4.11; Q-30's default).
//
// RULES 4.3: "Every page and first text links to a plain privacy notice." Q-30's default: every page also carries the
// privacy link. So the frame, not each page, writes the footer, and the footer always links to the privacy notice at
// BASE_PATH + "/privacy": rosfield.com/test/privacy on staging, rosfield.com/privacy in production (wrangler.jsonc
// vars.BASE_PATH, a config value: Q-51), the address Rosie's first text names (bundle v0's privacyLink line, T-1146).
// RULES 4.11: pages meet WCAG 2.1 AA, so the frame gives each page its language, a title, a skip link and the main and
// footer landmarks.
//
// A page made here holds no script, form, cookie, tracking or outside resource: its one style sheet is inline, and the
// content security policy servePage sends (shell/serve.ts) allows that sheet by its hash and nothing else.
// T-511 (the web app shell) builds on this frame; every page keeps its footer.

/** The privacy notice's path under BASE_PATH. */
export const PRIVACY_PATH = "/privacy";

/** The footer link's words: the label Rosie's privacyLink line gives the notice ("Privacy notice: <address>"). */
export const PRIVACY_LINK_LABEL = "Privacy notice";

/** A base path the frame refuses. */
export class BasePathError extends Error {
  override name = "BasePathError";
}

/** A base path: "" or one or more /segments of lowercase letters, digits and hyphens (wrangler.jsonc's BASE_PATH). */
const BASE_PATH = /^(?:\/[a-z0-9][a-z0-9-]*)*$/;

/**
 * BASE_PATH as the Worker reads it, closing slashes dropped as runtime/src/index.ts drops them: "" in production, "/test"
 * on staging. Throws BasePathError for anything else, so a page never links outside the site.
 */
export function basePathOf(raw: string): string {
  const basePath = raw.replace(/\/+$/, "");
  if (!BASE_PATH.test(basePath))
    throw new BasePathError(
      `"${raw}" is not a base path ("" or /<segment> of lowercase letters, digits and hyphens)`,
    );
  return basePath;
}

/** Text, or an attribute's value, made safe to place in HTML. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A note in the page's source only, as an HTML comment; throws for text that could end the comment early. */
export function htmlComment(text: string): string {
  if (text.includes("--") || text.includes("<") || text.includes(">"))
    throw new Error(`an HTML comment cannot hold "--", "<" or ">": ${text}`);
  return `<!-- ${text} -->`;
}

/** The frame's one style sheet, inline in each page (nothing is loaded from outside the page). */
export const FRAME_STYLE = [
  "body{font-family:system-ui,sans-serif;line-height:1.5;margin:0 auto;max-width:40rem;padding:1rem}",
  ".skip{position:absolute;left:-100vw}",
  ".skip:focus{position:static}",
  ".draft{border:2px solid;padding:0.5rem 1rem}",
  "footer{border-top:1px solid;margin-top:2rem;padding-top:1rem}",
].join("");

/**
 * The content security policy's source that allows FRAME_STYLE and no other style: its SHA-256 in base64, written
 * here so a page needs no hashing when it is served. pages/privacy/privacy.test.ts hashes the style each served page
 * carries and checks the policy against it, so a change to FRAME_STYLE fails there, showing the new hash, until this
 * is changed with it.
 */
export const FRAME_STYLE_SOURCE = "'sha256-J8mbj8ym0WXhehLCOEa5IvvQCwUEw7+nL+ukzGEwwXw='";

/** One page for the frame to wrap. */
export interface FramedPage {
  /** BASE_PATH as basePathOf reads it. */
  basePath: string;
  /** The page's own path under BASE_PATH, such as PRIVACY_PATH. */
  path: string;
  /** The page's title, plain text. */
  title: string;
  /** The main landmark's content: HTML the page has built, every text in it escaped with escapeHtml. */
  main: string;
  /** True: search engines are asked not to index the page. */
  noindex: boolean;
}

/** The privacy notice's address on this site: BASE_PATH + "/privacy". */
export function privacyHref(basePath: string): string {
  return `${basePathOf(basePath)}${PRIVACY_PATH}`;
}

/** The footer every page carries: the link to the privacy notice, marked as the current page on the notice itself. */
export function renderFooter(basePath: string, path: string): string {
  const current = path === PRIVACY_PATH ? ' aria-current="page"' : "";
  return [
    "<footer>",
    `<p><a href="${escapeHtml(privacyHref(basePath))}"${current}>${escapeHtml(PRIVACY_LINK_LABEL)}</a></p>`,
    "</footer>",
  ].join("\n");
}

/** One whole HTML document: the page inside the frame, with the footer's privacy link (see the top of this file). */
export function renderPage(page: FramedPage): string {
  const basePath = basePathOf(page.basePath);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(page.noindex ? ['<meta name="robots" content="noindex">'] : []),
    `<title>${escapeHtml(page.title)}</title>`,
    `<style>${FRAME_STYLE}</style>`,
    "</head>",
    "<body>",
    '<a class="skip" href="#main">Skip to main content</a>',
    '<main id="main" tabindex="-1">',
    page.main,
    "</main>",
    renderFooter(basePath, page.path),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
