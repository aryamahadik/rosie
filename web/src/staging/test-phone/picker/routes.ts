// The routes of web/src/staging/test-phone/picker (T-525's route module; build prompt 3.5 (c); DL-800). web/src/routes.ts
// lists this module and the shell (web/src/shell/shell.ts) serves whatever ROUTES holds.
// One of staging's test tools (build prompt 9.4): web/src/routes.ts marks the folder staging only, so the shell serves
// none of these routes unless ENVIRONMENT is exactly "staging", and each route is behind the staging-only guard besides
// (web/src/staging/guard, T-522). The route is the test-phone page's picker (picker.ts, T-525), made here with the
// Worker's own request ids.
import type { ShellRoute } from "../../../shell/route";
import { stagingOnlyRoutes } from "../../guard";
import { testPhonePickerRoutes } from "./picker";

export const ROUTES: readonly ShellRoute[] = stagingOnlyRoutes(testPhonePickerRoutes());
