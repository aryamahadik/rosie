// Where a signed-in person's roles take them (T-520; C-193; FS section 8; S13-45 rows 8 and 9).
//
// signInCheck's signedIn answer names the person's roles once (K-21 v1 `SignedInPerson`: a role per business, whether
// they are on Rosie's team, whether they are a tester on staging). The sign-in page uses them, in that one answer, to
// send the person to the consoles that are theirs. From then on the session carries the role: the browser holds only
// the session token (cookies.ts), each console puts it in its calls' envelopes (sessionTokenOf), and the server answers
// every call for the session's person and what their roles allow (K-21 v1: signInNeeded, notAllowed, notTeam,
// notTester). No role is ever kept in a cookie, a link or a form, and K-21 v1 has no call that reads a session's roles
// back, so a console never takes a role from the browser.
//
// The console paths are the feature folders' own names under web/src (console/owner, console/team, staging/test-phone);
// each console's task serves its routes there.

import type { ResponseOf } from "../client/calls";
import type { WebConfig } from "../shell/config";

/** The signed-in person as signInCheck's signedIn answer gives them (K-21 v1 `SignedInPerson`). */
export type SignedInPerson = Extract<ResponseOf<"signInCheck">, { result: "signedIn" }>["person"];

/** What a person may be signed in as: a role in a business, Rosie's team, or a tester on staging. */
export type SignedInAs = SignedInPerson["roles"][number]["role"] | "team" | "tester";

/** Each one's words on the page, in the order the page lists them. */
export const SIGNED_IN_AS_WORDS: Readonly<Record<SignedInAs, string>> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
  ownBusiness: "Your own business",
  team: "Rosie's team",
  tester: "Tester",
};

/** The owner console's path under BASE_PATH (web/src/console/owner): owners, admins and staff, each seeing only what is theirs. */
export const BUSINESS_CONSOLE_PATH = "/console/owner";
/** The team console's path under BASE_PATH (web/src/console/team): Rosie's team. */
export const TEAM_CONSOLE_PATH = "/console/team";
/** Staging's test tools' path under BASE_PATH (web/src/staging/test-phone): roster testers and Rosie's team, on staging only. */
export const STAGING_TOOLS_PATH = "/staging/test-phone";

/** One console a signed-in person is sent to. */
export interface ConsoleLink {
  readonly kind: "business" | "team" | "stagingTools";
  /** Its path under BASE_PATH. */
  readonly path: string;
  /** Its name on the page. */
  readonly words: string;
}

/** What the person is signed in as, each once, in SIGNED_IN_AS_WORDS' order. A tester exists on staging only. */
export function signedInAs(person: SignedInPerson, config: WebConfig): SignedInAs[] {
  const held = new Set<SignedInAs>(person.roles.map((row) => row.role));
  if (person.team) held.add("team");
  if (person.tester && config.staging) held.add("tester");
  return (Object.keys(SIGNED_IN_AS_WORDS) as SignedInAs[]).filter((as) => held.has(as));
}

/**
 * The consoles the person's roles open: the owner console for an owner, an admin, a staff member or someone with their
 * own business; the team console for Rosie's team; staging's test tools for a roster tester or a team member, on
 * staging only (build prompt 9.4: never in production).
 */
export function consolesFor(person: SignedInPerson, config: WebConfig): ConsoleLink[] {
  const consoles: ConsoleLink[] = [];
  if (person.roles.length > 0)
    consoles.push({ kind: "business", path: BUSINESS_CONSOLE_PATH, words: "Your business console" });
  if (person.team) consoles.push({ kind: "team", path: TEAM_CONSOLE_PATH, words: "Rosie's team console" });
  if (config.staging && (person.tester || person.team))
    consoles.push({ kind: "stagingTools", path: STAGING_TOOLS_PATH, words: "Staging's test tools" });
  return consoles;
}
