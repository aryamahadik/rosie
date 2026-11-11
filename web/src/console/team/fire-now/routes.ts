// The routes of web/src/console/team/fire-now (T-511's empty route module; build prompt 3.5 (c)). web/src/routes.ts
// lists this module and the shell (web/src/shell/shell.ts) serves whatever ROUTES holds, so this folder's page task
// adds its routes here and changes nothing outside the folder. Empty until then.
// One of staging's test tools (build prompt 9.4): web/src/routes.ts marks the folder staging only, so the shell serves
// none of these routes unless ENVIRONMENT is exactly "staging".
import type { ShellRoute } from "../../../shell/route";

export const ROUTES: readonly ShellRoute[] = [];
