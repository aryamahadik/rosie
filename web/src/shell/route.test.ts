// The route table (T-511): how the shell finds the route at an address, an exact path before a :name path whatever the
// order, and the route lists it refuses, so a mistake in one folder's list is found when the shell is made.
import { describe, expect, it } from "vitest";
import { NOT_FOUND_LABEL, RouteError, routeTable, type RouteMethod, type ShellRoute } from "./route";

const handle = (): Response => new Response(null, { status: 204 });

function route(label: string, path: string, methods: readonly RouteMethod[] = ["GET"]): ShellRoute {
  return { label, path, methods, handle };
}

describe("the route at an address", () => {
  const SIGN_IN = route("auth.signIn", "/sign-in", ["GET", "POST"]);
  const PAGING = route("team.paging", "/team/paging");
  const PAGE = route("team.page", "/team/paging/:pageId");
  const LINK = route("link.open", "/:code");
  // The wide route is listed first on purpose: an exact path still wins.
  const table = routeTable([LINK, PAGE, SIGN_IN, PAGING]);

  it("finds an exact path, by its exact spelling", () => {
    expect(table.match("/sign-in")).toEqual({ route: SIGN_IN, params: {} });
    expect(table.match("/team/paging")).toEqual({ route: PAGING, params: {} });
    for (const path of [
      "/team",
      "/team/",
      "/team/paging/",
      "/Team/paging",
      "/sign-in/",
      "//sign-in",
      "sign-in",
      "",
    ])
      expect(table.match(path)?.route, path).not.toBe(SIGN_IN);
    expect(table.match("/team/paging/")).toBeNull();
    expect(table.match("/Team/paging")).toBeNull();
    expect(table.match("")).toBeNull();
    expect(table.match("sign-in")).toBeNull();
  });

  it("hands a :name the one segment the address gave it, as it came, not decoded", () => {
    expect(table.match("/team/paging/page-0001")).toEqual({ route: PAGE, params: { pageId: "page-0001" } });
    expect(table.match("/dummy-code-0123456789abcd")).toEqual({
      route: LINK,
      params: { code: "dummy-code-0123456789abcd" },
    });
    expect(table.match("/a%2Fb")?.params).toEqual({ code: "a%2Fb" });
    expect(table.match("/Privacy")?.params).toEqual({ code: "Privacy" });
  });

  it("never gives a :name an empty segment or more than one", () => {
    for (const path of ["/", "/team/paging//", "/a/b", "/team/paging/a/b"])
      expect(table.match(path), path).toBeNull();
  });

  it("lets an exact path win over a :name path, whatever the order they were listed in", () => {
    expect(table.match("/sign-in")?.route).toBe(SIGN_IN);
    expect(routeTable([SIGN_IN, LINK]).match("/sign-in")?.route).toBe(SIGN_IN);
    expect(routeTable([LINK, SIGN_IN]).match("/sign-in")?.route).toBe(SIGN_IN);
    expect(table.match("/sign-up")?.route).toBe(LINK);
  });

  it("holds a :name that is an object's own word as any other", () => {
    const odd = routeTable([route("example.odd", "/odd/:constructor")]);
    expect(odd.match("/odd/__proto__")?.params).toEqual({ constructor: "__proto__" });
  });

  it("serves an empty list: no address has a route", () => {
    expect(routeTable([]).routes).toEqual([]);
    expect(routeTable([]).match("/sign-in")).toBeNull();
  });
});

describe("the route lists the shell refuses", () => {
  it("refuses a label that is not fixed letters, is too long, or is the 404's own", () => {
    for (const label of [
      "",
      "Sign-in",
      "sign in",
      "sign/in",
      "1st",
      "a..b",
      "a.",
      "x".repeat(65),
      NOT_FOUND_LABEL,
    ])
      expect(() => routeTable([route(label, "/sign-in")]), label).toThrow(RouteError);
    for (const label of ["privacy", "auth.signIn", "team.fire-now", "a1", "x".repeat(64)])
      expect(() => routeTable([route(label, "/sign-in")]), label).not.toThrow();
  });

  it("refuses two routes with one label", () => {
    expect(() => routeTable([route("auth.signIn", "/sign-in"), route("auth.signIn", "/sign-out")])).toThrow(
      "two routes are labelled auth.signIn",
    );
  });

  it("refuses a path that is not /segments or /:names", () => {
    for (const path of [
      "",
      "/",
      "sign-in",
      "/sign-in/",
      "//sign-in",
      "/Sign-in",
      "/sign in",
      "/sign_in",
      "/sign-in?x=1",
      "/:",
      "/:Code",
      "/:co-de",
      "/a/:b/:b",
      "/*",
      "/..",
    ])
      expect(() => routeTable([route("example.path", path)]), path).toThrow(RouteError);
  });

  it("refuses two paths that take the same addresses, exact or by :name", () => {
    expect(() => routeTable([route("a.one", "/sign-in"), route("b.two", "/sign-in")])).toThrow(
      "a.one and b.two take the same addresses (/sign-in)",
    );
    expect(() => routeTable([route("a.one", "/:code"), route("b.two", "/:other")])).toThrow(RouteError);
    expect(() => routeTable([route("a.one", "/v/:code"), route("b.two", "/v/:id")])).toThrow(RouteError);
    // A different shape is another address.
    expect(() => routeTable([route("a.one", "/:code"), route("b.two", "/v/:code")])).not.toThrow();
  });

  it("refuses a route that takes no method, or one that is not GET or POST", () => {
    expect(() => routeTable([route("a.one", "/sign-in", [])])).toThrow("a.one: the route takes no method");
    for (const method of ["HEAD", "PUT", "DELETE", "get"])
      expect(() => routeTable([route("a.one", "/sign-in", [method as RouteMethod])]), method).toThrow(
        RouteError,
      );
  });
});
