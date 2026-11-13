// The web app's config (T-511; C-185): where it runs, the path it answers under and the host its links start with.
// All three are the Worker's vars (wrangler.jsonc), never constants in the code:
//   ENVIRONMENT  "staging" on staging; staging's test tools exist nowhere else (build prompt 9.4).
//   BASE_PATH    "" in production, "/test" on staging (d000-factory-spec section 6; DL-014, DL-023).
//   LINK_HOST    the host every link starts with, such as rosfield.com (Q-51's default: "the link host is a config
//                value"). A link is always the host plus a short code (A4-42; C-185), under BASE_PATH:
//                https://<LINK_HOST><BASE_PATH>/<code>.
// A var that is missing or does not read as its kind is refused (WebConfigError), never guessed, so no page links
// outside the site and no link is built on a host nobody set.

import { BasePathError, basePathOf } from "./frame";

/** The Worker's vars the web app reads. Each is checked, so any value may come in. */
export interface WebVars {
  ENVIRONMENT?: unknown;
  BASE_PATH?: unknown;
  LINK_HOST?: unknown;
}

/** The web app's config, as readWebConfig reads it. */
export interface WebConfig {
  /** ENVIRONMENT as the Worker has it. */
  readonly environment: string;
  /** True only when ENVIRONMENT is exactly "staging": the one place staging's test tools exist. */
  readonly staging: boolean;
  /** BASE_PATH as the frame reads it (frame.ts basePathOf): "" or /segments, no closing slash. */
  readonly basePath: string;
  /** LINK_HOST: a host name in lower case, with a port only where one is set. */
  readonly linkHost: string;
}

/** A var the web app cannot run on. */
export class WebConfigError extends Error {
  override name = "WebConfigError";
}

/** The one ENVIRONMENT staging's test tools run in (wrangler.jsonc env.staging), as the page entry reads it. */
const STAGING = "staging";

/** A host name: labels of lowercase letters, digits and hyphens joined by dots, then a port or none. */
const HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;
const HOST_MAX = 253;

/** A link's short code (K-21 v1 `$defs/linkCode`). */
const LINK_CODE = /^[A-Za-z0-9-]{3,64}$/;

/** The config from the Worker's vars. Throws WebConfigError for a var that is missing or is not its kind. */
export function readWebConfig(vars: WebVars): WebConfig {
  const environment = vars.ENVIRONMENT;
  if (typeof environment !== "string" || environment === "")
    throw new WebConfigError("ENVIRONMENT is not set");

  if (typeof vars.BASE_PATH !== "string") throw new WebConfigError("BASE_PATH is not set");
  let basePath: string;
  try {
    basePath = basePathOf(vars.BASE_PATH);
  } catch (error) {
    if (error instanceof BasePathError) throw new WebConfigError(`BASE_PATH: ${error.message}`);
    throw error;
  }

  const linkHost = vars.LINK_HOST;
  if (typeof linkHost !== "string" || linkHost === "") throw new WebConfigError("LINK_HOST is not set");
  if (linkHost.length > HOST_MAX || !HOST.test(linkHost))
    throw new WebConfigError(
      "LINK_HOST is not a host name (lowercase letters, digits, hyphens and dots, with a port or none)",
    );

  return { environment, staging: environment === STAGING, basePath, linkHost };
}

/**
 * A link's address: the host plus the short code, under BASE_PATH (see the top of this file). Throws WebConfigError
 * for a code that is not a link's short code, so nothing else is ever put after the host.
 */
export function linkUrl(config: WebConfig, code: string): string {
  if (!LINK_CODE.test(code)) throw new WebConfigError("not a link's short code (K-21 v1 linkCode)");
  return `https://${config.linkHost}${config.basePath}/${code}`;
}
