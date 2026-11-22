// The routes of web/src/link (T-511's route module; build prompt 3.5 (c)). web/src/routes.ts lists this module last and
// the shell (shell/shell.ts) serves whatever ROUTES holds.
//
// The signed-link opener's route (open.ts linkRoutes; T-512), listed since T-1534 (S1-10 slice card S10-8; K-09 README
// default 212; DL-1153): its path, /:code, takes every one-segment address under BASE_PATH that no exact path has, so
// the tests that used such an address as one no route takes now use an address of two segments (T-512's report names
// each test). A code not in K-21's linkCode pattern still gets the shell's 404 with nothing sent (open.ts), and the
// server's openLink checks a code's made form before any read (runtime/src/wiring/open-link.ts).
import type { ShellRoute } from "../shell/route";
import { linkRoutes } from "./open";

export const ROUTES: readonly ShellRoute[] = linkRoutes();
