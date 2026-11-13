// The routes of web/src/auth (T-520; C-193; build prompt 3.5 (c)): sign-in by code, and sign-out. web/src/routes.ts
// lists this module and the shell (shell/shell.ts) serves whatever ROUTES holds. The routes themselves are made in
// sign-in.ts, here with the clock and the random ids the Worker gives.
import type { ShellRoute } from "../shell/route";
import { signInRoutes } from "./sign-in";

export const ROUTES: readonly ShellRoute[] = signInRoutes();
