// T-511's proof that the link host and BASE_PATH come from config (Q-51; DL-014, DL-023): the web app reads both from
// the Worker's vars, a link's address and every page's path follow them, and a var that is missing or is not its kind
// is refused, never guessed. BASE_PATH is read from wrangler.jsonc itself, as T-1171's tests read it.
import { describe, expect, it } from "vitest";
import { readBasePath } from "../../../compiler/src/fixed-lines";
import { renderPrivacyPage } from "../pages/privacy/page";
import { WebConfigError, linkUrl, readWebConfig, type WebVars } from "./config";
import { TEST_LINK_HOST, get, testShell, testVars } from "./test-support";

/** A link's short code, made up (K-21 v1 linkCode: 22 or more characters of A-Z, a-z, 0-9 and -). */
const CODE = "dummy-code-0123456789abcd";

describe("the web app's config is the Worker's vars", () => {
  it("reads staging's vars: ENVIRONMENT staging, wrangler.jsonc's BASE_PATH /test, and the link host", () => {
    expect(readBasePath("staging")).toBe("/test");
    expect(readWebConfig(testVars("staging"))).toEqual({
      environment: "staging",
      staging: true,
      basePath: "/test",
      linkHost: TEST_LINK_HOST,
    });
  });

  it("reads production's vars: wrangler.jsonc's empty BASE_PATH, and never staging", () => {
    expect(readBasePath("production")).toBe("");
    expect(readWebConfig(testVars("production"))).toEqual({
      environment: "production",
      staging: false,
      basePath: "",
      linkHost: TEST_LINK_HOST,
    });
  });

  it("counts as staging only when ENVIRONMENT is exactly staging", () => {
    for (const environment of ["production", "Staging", "staging ", " staging", "preview", "stage"])
      expect(readWebConfig({ ...testVars("staging"), ENVIRONMENT: environment }).staging, environment).toBe(
        false,
      );
  });

  it("drops BASE_PATH's closing slashes, as the Worker does", () => {
    expect(readWebConfig({ ...testVars("staging"), BASE_PATH: "/test/" }).basePath).toBe("/test");
    expect(readWebConfig({ ...testVars("staging"), BASE_PATH: "/" }).basePath).toBe("");
  });

  it("takes a host name, with a port only where one is set", () => {
    for (const host of [
      "rosfield.com",
      "links.example.test",
      "rosie-staging.example.workers.dev",
      "localhost:8787",
    ])
      expect(readWebConfig({ ...testVars("staging"), LINK_HOST: host }).linkHost).toBe(host);
  });

  it("refuses a var that is missing, naming the var and guessing nothing", () => {
    const vars = testVars("staging");
    const without = (name: keyof WebVars): WebVars =>
      Object.fromEntries(Object.entries(vars).filter(([key]) => key !== name));
    expect(() => readWebConfig(without("ENVIRONMENT"))).toThrow(new WebConfigError("ENVIRONMENT is not set"));
    expect(() => readWebConfig(without("BASE_PATH"))).toThrow(new WebConfigError("BASE_PATH is not set"));
    expect(() => readWebConfig(without("LINK_HOST"))).toThrow(new WebConfigError("LINK_HOST is not set"));
    expect(() => readWebConfig({})).toThrow(WebConfigError);
    for (const empty of ["", undefined, null, 7])
      expect(() => readWebConfig({ ...vars, LINK_HOST: empty })).toThrow("LINK_HOST is not set");
  });

  it("refuses a link host that is not a bare host name, so no link leaves the site it names", () => {
    for (const host of [
      "https://rosfield.com",
      "rosfield.com/test",
      "rosfield.com/",
      "//rosfield.com",
      "user@rosfield.com",
      "Rosfield.com",
      "rosfield .com",
      "rosfield.com?x=1",
      "rosfield.com#x",
      "rosfield..com",
      "-rosfield.com",
      ".rosfield.com",
      "rosfield.com:",
      "rosfield.com:port",
      `${"a".repeat(64)}.com`,
      `${"a.".repeat(130)}com`,
    ])
      expect(() => readWebConfig({ ...testVars("staging"), LINK_HOST: host }), host).toThrow(
        "LINK_HOST is not a host name",
      );
  });

  it("refuses a BASE_PATH that is not a base path", () => {
    for (const basePath of ["test", "/Test", "//evil.example", "https://evil.example", "/test?x=1", "/../x"])
      expect(() => readWebConfig({ ...testVars("staging"), BASE_PATH: basePath }), basePath).toThrow(
        WebConfigError,
      );
  });
});

describe("a link is the host plus a short code, under BASE_PATH (A4-42; C-185)", () => {
  it("builds the link from the config's host and base path, never from a constant", () => {
    expect(linkUrl(readWebConfig(testVars("staging")), CODE)).toBe(`https://rosfield.com/test/${CODE}`);
    expect(linkUrl(readWebConfig(testVars("production")), CODE)).toBe(`https://rosfield.com/${CODE}`);
    const other = readWebConfig({
      ENVIRONMENT: "staging",
      BASE_PATH: "/x-1",
      LINK_HOST: "links.example.test",
    });
    expect(linkUrl(other, CODE)).toBe(`https://links.example.test/x-1/${CODE}`);
  });

  it("puts nothing but a short code after the host", () => {
    const config = readWebConfig(testVars("staging"));
    for (const code of ["", "ab", "a/b", "../privacy", "abc?x=1", "abc#x", "abc def", "a".repeat(65)])
      expect(() => linkUrl(config, code), code).toThrow(WebConfigError);
  });
});

describe("the shell serves under the BASE_PATH its config gives", () => {
  it("serves the privacy notice at another base path when the var says so, and no longer at /test", async () => {
    const { shell, config } = testShell({ vars: { BASE_PATH: "/x-1", LINK_HOST: "links.example.test" } });
    expect(config.basePath).toBe("/x-1");
    const moved = await shell.fetch(get("/x-1/privacy"));
    expect(moved.status).toBe(200);
    const html = await moved.text();
    expect(html).toBe(renderPrivacyPage("/x-1"));
    expect(html).toContain('<a href="/x-1/privacy" aria-current="page">');
    expect((await shell.fetch(get("/test/privacy"))).status).toBe(404);
    expect((await shell.fetch(get("/privacy"))).status).toBe(404);
  });
});
