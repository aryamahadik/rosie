// Staging's test-phone page inputs (the D-017 path audit's P6b: ops/reviews/D-017-path-audit/order_d017.txt line 48;
// T-1305). T-1257 made this file with its final signature; T-1305 binds it and edits nothing else.
//
// T-1305 gives RootOptions.testPhone (../test-phone TestPhoneInputs): K-05 v1.12 items 53 to 55 on job-side clients
// (part.db.runtime, never the Tool API's: DL-557), the roster's one list, and staging's test-phone line; the chat link's
// address from part.env.ROSIE_NUMBER. Until then: null, as the Worker's root has always handed, so the page's two calls
// stay unconfigured (503) on staging, as every page call does until its handler is joined. Nothing here reads a binding.

import type { TestPhoneInputs } from "../test-phone";
import type { StagingPart } from "./part";

/** What T-1305's builder is handed: the env (ROSIE_NUMBER, TEST_PHONE_LINE) and the root's handle. */
export type TestPhonePart = StagingPart;

/** RootOptions.testPhone for staging: null until T-1305 binds it, so both page calls stay unconfigured. */
export const stagingTestPhone: (part: TestPhonePart) => TestPhoneInputs | null = () => null;
