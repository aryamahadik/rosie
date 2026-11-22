// The routes of web/src/link (T-511's route module; build prompt 3.5 (c)). web/src/routes.ts lists this module last and
// the shell (shell/shell.ts) serves whatever ROUTES holds.
//
// The signed-link opener's route is built and proven in this folder (open.ts linkRoutes; T-512), but not listed here
// yet. Its path, /:code, takes every one-segment address under BASE_PATH that no exact path has, and tests outside this
// folder still use such addresses ("/test/unknown", the staging tools' "unknown address" checks) as addresses no route
// takes, on web's own lists: listing it turns those into openLink calls (T-512's report names each test). Once those
// tests move to an address of two segments, this list becomes `linkRoutes()` and nothing else changes.
import type { ShellRoute } from "../shell/route";

export const ROUTES: readonly ShellRoute[] = [];
