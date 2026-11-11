// The cookies sign-in keeps in a browser (T-520; C-193; K-21 v1 README "The cookies", default 21). There are three,
// each HttpOnly, Secure and SameSite=Lax, each scoped to BASE_PATH, and none holds a role, a person, a phone or an
// email:
//   - the session cookie: only the opaque token signInCheck's first signedIn answer gave, until the session's own end
//     (K-21 v1 sessionExpiresAt). The server keeps who the session is and what they may do; a page sends the token in
//     each call's envelope and nothing else says who anyone is (K-21 v1 README, "No browser value says who anyone is").
//   - the device cookie: a random value made here once per browser (K-21 v1 signInStart.deviceToken), which the server
//     binds a sign-in attempt to.
//   - the pause cookie: the end of the 15-minute pause signInCheck answered for one attempt, with that attempt's id, so
//     the page sends no further check of it until the pause ends (FS section 8; K-21 v1 SignInPaused). It lapses at the
//     pause's end. The server holds the real pause; this only keeps the page from asking.
// SameSite=Lax keeps the session on the first page of a link opened from Messages, and off another site's form posts;
// the shell's origin check (shell/post-guard.ts) refuses those posts as well.
//
// Staging lives under a path of production's host (BASE_PATH "/test"; DL-014, DL-023), so each cookie's name carries
// the base path: staging's pages never read production's cookies as their own.

import type { WebConfig } from "../shell/config";

/** The three cookies' names for one environment. */
export interface CookieNames {
  readonly session: string;
  readonly device: string;
  readonly pause: string;
}

/** The cookies' names under the config's BASE_PATH: "-test" is added on staging, nothing in production. */
export function cookieNames(config: WebConfig): CookieNames {
  const suffix = config.basePath.replaceAll("/", "-");
  return {
    session: `__Secure-rosie-session${suffix}`,
    device: `__Secure-rosie-device${suffix}`,
    pause: `__Secure-rosie-sign-in-pause${suffix}`,
  };
}

/** How long a browser keeps its device cookie: 400 days, the longest browsers keep any cookie. */
export const DEVICE_COOKIE_SECONDS = 400 * 24 * 60 * 60;

/** K-21 v1 `$defs/opaqueToken`: 16 to 512 characters. */
const TOKEN_MIN = 16;
const TOKEN_MAX = 512;

/** A device token as this module makes it, and as a cookie may carry it. */
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;

/** K-21's `utc`: an instant in UTC ending in Z. */
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/;

/** The instant a K-21 `utc` names, or null when it is not one. */
export function instantOf(utc: string): Date | null {
  if (!UTC.test(utc)) return null;
  const at = new Date(utc);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The first cookie named `name` in the request, as sent, or null. A browser lists the cookie of the longer path first. */
export function cookieOf(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** A cookie's value as it was before setCookie's encoding, or null when it does not decode. */
function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** One Set-Cookie value: the name and value, how long it lives, then the attributes every cookie here has. */
function setCookie(name: string, value: string, life: string | null, config: WebConfig): string {
  return [
    `${name}=${value}`,
    ...(life === null ? [] : [life]),
    `Path=${config.basePath === "" ? "/" : config.basePath}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/** The Set-Cookie value that removes the cookie `name` from the browser. */
export function clearedCookie(name: string, config: WebConfig): string {
  return setCookie(name, "", "Max-Age=0", config);
}

/** A new device token: 256 random bits in the URL-safe alphabet. */
export function newDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The browser's device token, or null when it has none that reads as one. */
export function deviceTokenOf(request: Request, config: WebConfig): string | null {
  const value = cookieOf(request, cookieNames(config).device);
  return value !== null && DEVICE_TOKEN.test(value) ? value : null;
}

/** The Set-Cookie value that gives the browser its device token. */
export function deviceCookie(token: string, config: WebConfig): string {
  return setCookie(cookieNames(config).device, token, `Max-Age=${String(DEVICE_COOKIE_SECONDS)}`, config);
}

/**
 * The session token the browser sent, for a call's envelope (K-21 v1 `page.sessionToken`), or null when it sent none
 * that reads as one. Every console and signed-in page reads the session through this: the token is all the browser
 * holds, and the server answers each call for the session's person and what their roles allow.
 */
export function sessionTokenOf(request: Request, config: WebConfig): string | null {
  const value = cookieOf(request, cookieNames(config).session);
  const token = value === null ? null : decoded(value);
  return token !== null && token.length >= TOKEN_MIN && token.length <= TOKEN_MAX ? token : null;
}

/**
 * The Set-Cookie value for a session that has just started: the token alone, until the session's own end. An end that
 * does not read as an instant gives a cookie that lasts only until the browser closes.
 */
export function sessionCookie(token: string, expiresAt: string, config: WebConfig): string {
  const end = instantOf(expiresAt);
  return setCookie(
    cookieNames(config).session,
    encodeURIComponent(token),
    end === null ? null : `Expires=${end.toUTCString()}`,
    config,
  );
}

/** A pause the page was told about: when it ends, and the attempt it is for. */
export interface SignInPause {
  readonly until: Date;
  readonly attemptId: string;
}

/** The pause the browser holds, or null when it holds none that reads as one. Whether it still runs is the caller's check. */
export function pauseOf(request: Request, config: WebConfig): SignInPause | null {
  const value = cookieOf(request, cookieNames(config).pause);
  if (value === null) return null;
  const at = value.indexOf("|");
  if (at === -1) return null;
  const until = instantOf(value.slice(0, at));
  const attemptId = decoded(value.slice(at + 1));
  return until === null || attemptId === null || attemptId === "" ? null : { until, attemptId };
}

/** The Set-Cookie value that keeps a pause until it ends. */
export function pauseCookie(pause: SignInPause, config: WebConfig): string {
  return setCookie(
    cookieNames(config).pause,
    `${pause.until.toISOString()}|${encodeURIComponent(pause.attemptId)}`,
    `Expires=${pause.until.toUTCString()}`,
    config,
  );
}
