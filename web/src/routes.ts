// What web serves, each at its path under BASE_PATH.
//
// PAGE_ROUTES (T-1171): the static pages. servePage (shell/serve.ts) answers these paths and no other, and the shell
// (shell/shell.ts) serves them too. Every page renders through the page frame (shell/frame.ts), so every page's footer
// links to the privacy notice (RULES 4.3; Q-30).
//
// ROUTE_MODULES (T-511; build prompt 3.5 (c)): the route module of every feature folder, routes.ts, each exporting
// ROUTES. The shell serves whatever those lists hold, so a page task adds its routes in its own folder and changes
// nothing here. Each starts empty. A folder marked staging only is one of staging's test tools (build prompt 9.4): the
// shell serves none of its routes unless ENVIRONMENT is exactly "staging". The link folder comes last: a link is the
// host plus a short code, so its route takes any one-segment address that no exact path has (shell/route.ts).
import { ROUTES as authRoutes } from "./auth/routes";
import { ROUTES as ownerConsoleRoutes } from "./console/owner/routes";
import { ROUTES as fireNowRoutes } from "./console/team/fire-now/routes";
import { ROUTES as teamPagingRoutes } from "./console/team/paging/routes";
import { ROUTES as teamShellRoutes } from "./console/team/shell/routes";
import { ROUTES as textHoursRoutes } from "./console/team/text-hours/routes";
import { ROUTES as linkRoutes } from "./link/routes";
import { ROUTES as bookingRoutes } from "./pages/booking/routes";
import { ROUTES as idUploadRoutes } from "./pages/id-upload/routes";
import { renderPrivacyPage } from "./pages/privacy/page";
import { ROUTES as secureRoutes } from "./pages/secure/routes";
import { PRIVACY_PATH } from "./shell/frame";
import type { RouteModule } from "./shell/route";
import { ROUTES as testPhoneSendRoutes } from "./staging/test-phone/send/routes";

/** One static page: its path under BASE_PATH, its label in the shell's log line, and the whole HTML document it shows. */
export interface PageRoute {
  path: string;
  /** Fixed letters naming the page (shell/route.ts ShellRoute.label). */
  label: string;
  render: (basePath: string) => string;
}

export const PAGE_ROUTES: readonly PageRoute[] = [
  { path: PRIVACY_PATH, label: "privacy", render: renderPrivacyPage },
];

/** Every feature folder's route module (see the top of this file). */
export const ROUTE_MODULES: readonly RouteModule[] = [
  { folder: "auth", stagingOnly: false, routes: authRoutes },
  { folder: "pages/secure", stagingOnly: false, routes: secureRoutes },
  { folder: "pages/id-upload", stagingOnly: false, routes: idUploadRoutes },
  { folder: "pages/booking", stagingOnly: false, routes: bookingRoutes },
  { folder: "console/owner", stagingOnly: false, routes: ownerConsoleRoutes },
  { folder: "console/team/shell", stagingOnly: false, routes: teamShellRoutes },
  { folder: "console/team/paging", stagingOnly: false, routes: teamPagingRoutes },
  { folder: "console/team/fire-now", stagingOnly: true, routes: fireNowRoutes },
  { folder: "console/team/text-hours", stagingOnly: true, routes: textHoursRoutes },
  { folder: "staging/test-phone/send", stagingOnly: true, routes: testPhoneSendRoutes },
  { folder: "link", stagingOnly: false, routes: linkRoutes },
];
