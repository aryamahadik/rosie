// T-520's proof that no password field exists anywhere in web/ (FS section 8: "No password"; C-193): no page the web
// app serves holds an input that takes a password, and no file under web/ writes one. The served pages are every page
// of the shell (the static pages, each feature folder's GET routes, the error pages) on staging and in production, and
// every page sign-in can answer with: one for each answer signInStart and signInCheck may give, and for each form a
// browser may send badly.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGE_ROUTES, ROUTE_MODULES } from "../routes";
import { renderErrorPage, type ErrorStatus } from "../shell/error-pages";
import { TRACE_ID, get, testShell } from "../shell/test-support";
import { cookieNames } from "./cookies";
import { CHECK_OUTCOMES, START_OUTCOMES, post, stubShell } from "./test-support";

/** An input that takes a password, as HTML writes it: the type, quoted or not. */
const PASSWORD_INPUT = /<input\b[^>]*\btype\s*=\s*["']?password/i;
/** The same in a source file, where the quote may be escaped, and the autofill hints that only a password field has. */
const PASSWORD_SOURCE =
  /\btype\s*=\s*\\?["'`]?password|autocomplete\s*=\s*\\?["'`]?(?:current|new)-password/i;

/** The word itself, for the samples below. */
const WORD = ["pass", "word"].join("");

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const SKIPPED = new Set(["node_modules", "dist", ".wrangler"]);

/** Every file under `folder`, by its path. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = `${folder}${entry.name}`;
    return entry.isDirectory() ? filesUnder(`${path}/`) : [path];
  });
}

/** Every page the web app serves, each with what it is. */
async function servedPages(): Promise<{ what: string; html: string }[]> {
  const pages: { what: string; html: string }[] = [];
  const keep = async (what: string, response: Response | Promise<Response>): Promise<void> => {
    pages.push({ what, html: await (await response).text() });
  };

  for (const environment of ["staging", "production"] as const) {
    const { shell, config } = testShell({ environment });
    for (const page of PAGE_ROUTES)
      await keep(`${environment} ${page.label}`, shell.fetch(get(`${config.basePath}${page.path}`)));
    for (const module of ROUTE_MODULES)
      for (const route of module.routes)
        if (route.methods.includes("GET") && !route.path.includes(":"))
          await keep(`${environment} ${route.label}`, shell.fetch(get(`${config.basePath}${route.path}`)));
    await keep(
      `${environment} sign-in from a link`,
      shell.fetch(get(`${config.basePath}/sign-in?link=dummy-link-01`)),
    );
    await keep(`${environment} 404`, shell.fetch(get(`${config.basePath}/unknown`)));
    for (const status of [403, 404, 405, 413, 500] satisfies ErrorStatus[])
      pages.push({
        what: `${environment} error ${String(status)}`,
        html: renderErrorPage({ status, basePath: config.basePath, traceId: TRACE_ID }),
      });

    const device = { [cookieNames(config).device]: "dummy-device-token-0001" };
    const at = { now: "2026-10-26T13:00:00Z", environment };
    const start = { requestId: "req-dummy-start-0001", account: "dummy@lee.example", way: "email" };
    const check = {
      requestId: "req-dummy-check-0001",
      attempt: "attempt-dummy-0001",
      way: "email",
      code: "123456",
    };
    for (const outcome of [...START_OUTCOMES, { error: "transient" }]) {
      const { shell: stub } = stubShell(() => outcome, at);
      await keep(
        `${environment} start ${JSON.stringify(outcome)}`,
        stub.fetch(post(`${config.basePath}/sign-in`, start, device)),
      );
    }
    for (const outcome of [...CHECK_OUTCOMES, { error: "transient" }])
      for (const way of ["email", "text"]) {
        const { shell: stub } = stubShell(() => outcome, at);
        await keep(
          `${environment} check by ${way} ${JSON.stringify(outcome)}`,
          stub.fetch(post(`${config.basePath}/sign-in/check`, { ...check, way }, device)),
        );
      }
    const { shell: stub } = stubShell(() => ({ result: "signedOut", repeated: false }), at);
    await keep(
      `${environment} bad start`,
      stub.fetch(post(`${config.basePath}/sign-in`, { ...start, way: "" }, device)),
    );
    await keep(
      `${environment} bad check`,
      stub.fetch(post(`${config.basePath}/sign-in/check`, { ...check, code: "" }, device)),
    );
    await keep(
      `${environment} lost check`,
      stub.fetch(post(`${config.basePath}/sign-in/check`, { ...check, attempt: "" }, device)),
    );
    await keep(`${environment} no cookie`, stub.fetch(post(`${config.basePath}/sign-in/check`, check)));
    await keep(
      `${environment} signed out`,
      stub.fetch(post(`${config.basePath}/sign-out`, { requestId: "req-dummy-out-0001" })),
    );
    await keep(`${environment} bad sign-out`, stub.fetch(post(`${config.basePath}/sign-out`, {})));
  }
  return pages;
}

describe("no password field exists anywhere in web/", () => {
  it("knows a password field when it sees one, in a page and in a source file", () => {
    // Each sample is put together here, so this file holds no password field of its own for the last test to find.
    const quote = '"';
    const field = `<input name="secret" type=${quote}${WORD}${quote}>`;
    expect(field).toMatch(PASSWORD_INPUT);
    expect(field).toMatch(PASSWORD_SOURCE);
    expect(`<input type=${WORD}>`).toMatch(PASSWORD_INPUT);
    expect(`<INPUT TYPE = '${WORD.toUpperCase()}'>`).toMatch(PASSWORD_INPUT);
    expect(`type=\\${quote}${WORD}\\${quote}`).toMatch(PASSWORD_SOURCE);
    expect(`autocomplete=${quote}current-${WORD}${quote}`).toMatch(PASSWORD_SOURCE);
    // The fields sign-in does have are not ones.
    expect('<input id="code" name="code" type="text" autocomplete="one-time-code">').not.toMatch(
      PASSWORD_INPUT,
    );
    expect("<p>There is no password.</p>").not.toMatch(PASSWORD_INPUT);
  });

  it("no page the web app serves holds one, and every input a page holds is hidden or plain text", async () => {
    const pages = await servedPages();
    // Every kind of page is among them: the forms, each answer's page and the error pages.
    expect(pages.length).toBeGreaterThan(70);
    for (const title of [
      "Sign in",
      "Type your code",
      "Send this text",
      "Your text has not come yet",
      "Sign-in is paused",
      "You are signed in",
      "That code has run out",
      "This sign-in is already done",
      "A second proof is needed",
      "Start again",
      "Sign out",
      "You are signed out",
    ])
      expect(
        pages.some((page) => page.html.includes(`<h1>${title}</h1>`)),
        title,
      ).toBe(true);

    const inputs = new Set<string>();
    for (const { what, html } of pages) {
      expect(html, what).not.toMatch(PASSWORD_INPUT);
      expect(html.toLowerCase(), what).not.toContain(`type=${WORD}`);
      for (const input of html.match(/<input\b[^>]*>/gi) ?? [])
        inputs.add(/\btype="([^"]*)"/.exec(input)?.[1] ?? "(none)");
    }
    expect([...inputs].sort()).toEqual(["hidden", "text"]);
  });

  it("no file under web/ writes one", () => {
    const files = filesUnder(WEB);
    const read = files.filter((path) => /\.(?:ts|tsx|js|mjs|cjs|html|css|json|md)$/.test(path));
    // The sign-in pages' own sources are among the files read.
    for (const name of ["src/auth/pages.ts", "src/auth/sign-in.ts", "src/shell/frame.ts", "README.md"])
      expect(read).toContain(`${WEB}${name}`);
    expect(read.length).toBeGreaterThan(40);
    const found = read.filter((path) => PASSWORD_SOURCE.test(readFileSync(path, "utf8")));
    expect(found).toEqual([]);
  });
});
