// T-511's proof for the feature folders' route modules (build prompt 3.5 (c)): web/src/routes.ts imports the route
// module of every feature folder the plan names, each starts empty, and adding a route needs no change outside its own
// folder: a route put in a folder's own ROUTES list is served by the shell as it stands.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTES as authRoutes } from "../auth/routes";
import { ROUTES as ownerConsoleRoutes } from "../console/owner/routes";
import { ROUTES as fireNowRoutes } from "../console/team/fire-now/routes";
import { ROUTES as teamPagingRoutes } from "../console/team/paging/routes";
import { ROUTES as teamShellRoutes } from "../console/team/shell/routes";
import { ROUTES as textHoursRoutes } from "../console/team/text-hours/routes";
import { ROUTES as linkRoutes } from "../link/routes";
import { ROUTES as bookingRoutes } from "../pages/booking/routes";
import { ROUTES as idUploadRoutes } from "../pages/id-upload/routes";
import { ROUTES as secureRoutes } from "../pages/secure/routes";
import { PAGE_ROUTES, ROUTE_MODULES } from "../routes";
import { ROUTES as testPhoneSendRoutes } from "../staging/test-phone/send/routes";
import { routeTable, type ShellRoute } from "./route";
import { TRACE_ID, get, testShell } from "./test-support";

/** The feature folders T-511's card names (its "May touch" route modules), each with its own ROUTES list. */
const FOLDERS: Readonly<Record<string, readonly ShellRoute[]>> = {
  link: linkRoutes,
  "pages/secure": secureRoutes,
  "pages/booking": bookingRoutes,
  "console/owner": ownerConsoleRoutes,
  "console/team/shell": teamShellRoutes,
  "console/team/paging": teamPagingRoutes,
  auth: authRoutes,
  "pages/id-upload": idUploadRoutes,
  "staging/test-phone/send": testPhoneSendRoutes,
  "console/team/fire-now": fireNowRoutes,
  "console/team/text-hours": textHoursRoutes,
};

/** Staging's test tools among them (build prompt 9.4): the test-phone page, Fire now and the text-hours override. */
const STAGING_ONLY = ["console/team/fire-now", "console/team/text-hours", "staging/test-phone/send"];

const SRC = new URL("../", import.meta.url);
const ROUTES_SOURCE = readFileSync(new URL("routes.ts", SRC), "utf8");

const sorted = (names: readonly string[]): string[] => [...names].sort((a, b) => a.localeCompare(b));

describe("web/src/routes.ts imports the route module of every feature folder the plan names", () => {
  it("lists each of the 11 folders once", () => {
    expect(Object.keys(FOLDERS)).toHaveLength(11);
    expect(sorted(ROUTE_MODULES.map((module) => module.folder))).toEqual(sorted(Object.keys(FOLDERS)));
  });

  it.each(Object.keys(FOLDERS))(
    "%s: imports the folder's routes.ts, and lists the folder's own ROUTES",
    (folder) => {
      expect(ROUTES_SOURCE).toContain(` from "./${folder}/routes";`);
      const module = ROUTE_MODULES.find((listed) => listed.folder === folder);
      // The very list the folder exports, not a copy: what the folder adds to it is what the shell serves.
      expect(module?.routes).toBe(FOLDERS[folder]);
    },
  );

  it("marks staging's test tools staging only, and nothing else", () => {
    expect(
      sorted(ROUTE_MODULES.filter((module) => module.stagingOnly).map((module) => module.folder)),
    ).toEqual(sorted(STAGING_ONLY));
  });

  it("lists the link folder last: its route takes any short code no exact path has", () => {
    expect(ROUTE_MODULES.at(-1)?.folder).toBe("link");
  });

  it("holds a route list the shell can serve, with the static pages", () => {
    expect(() =>
      routeTable([
        ...PAGE_ROUTES.map((page) => ({ ...page, methods: ["GET" as const], handle: () => new Response() })),
        ...ROUTE_MODULES.flatMap((module) => module.routes),
      ]),
    ).not.toThrow();
  });
});

describe("each route module starts empty", () => {
  // A folder that holds its routes.ts alone is one no page task has started: it serves no route. Once a page task adds
  // its files beside routes.ts, the folder's own tests say what it serves, and this test steps aside for it, so adding
  // a route never means changing a test outside the folder.
  it.each(Object.keys(FOLDERS))("%s: no route while the folder holds its routes.ts alone", (folder) => {
    const files = readdirSync(new URL(`${folder}/`, SRC));
    expect(files).toContain("routes.ts");
    if (files.length === 1) expect(FOLDERS[folder]).toEqual([]);
  });
});

describe("adding a route needs no change outside its own folder", () => {
  it("serves a route put in a folder's own ROUTES list, with nothing else changed", async () => {
    const added: ShellRoute = {
      label: "example.added",
      path: "/example/added",
      methods: ["GET"],
      handle: (context) => context.page({ title: "Added", main: "<h1>Added</h1>" }),
    };
    // The list web/src/auth/routes.ts exports, as a page task would add to it in that file.
    const list = authRoutes as ShellRoute[];
    expect((await testShell().shell.fetch(get("/test/example/added"))).status).toBe(404);
    list.push(added);
    try {
      const { shell, lines } = testShell();
      const response = await shell.fetch(get("/test/example/added", { "x-trace-id": TRACE_ID }));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
      expect(await response.text()).toContain('<main id="main" tabindex="-1">\n<h1>Added</h1>\n</main>');
      expect(lines()).toEqual([
        { level: "info", msg: "page", trace_id: TRACE_ID, route: "example.added", status: 200 },
      ]);
    } finally {
      list.pop();
    }
    expect(authRoutes).not.toContain(added);
  });

  it("serves a staging-only folder's added route on staging alone", async () => {
    const added: ShellRoute = {
      label: "example.tool",
      path: "/example/tool",
      methods: ["GET"],
      handle: (context) => context.page({ title: "Tool", main: "<h1>Tool</h1>" }),
    };
    const list = testPhoneSendRoutes as ShellRoute[];
    list.push(added);
    try {
      expect((await testShell().shell.fetch(get("/test/example/tool"))).status).toBe(200);
      const production = testShell({ environment: "production" });
      expect((await production.shell.fetch(get("/example/tool"))).status).toBe(404);
      expect(production.shell.serve(get("/example/tool"))).toBeNull();
    } finally {
      list.pop();
    }
  });
});
