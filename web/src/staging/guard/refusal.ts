// A staging-only call the server refused, shown as refused (T-522; K-21 v1 "Staging only"; build prompt 9.4).
//
// K-21 v1's staging-only calls (testRoster, testPhoneSend, testPhoneParts, testClockRows, fireNow, textHoursOverride)
// do nothing and answer { "error": "stagingOnly" } when the server is not staging: fixtures/fire-now-in-production.json
// holds that answer, and the schema refuses every other answer there (fixtures/invalid/
// refuse-fire-now-in-production.json: the same request, in production, answered as fired). The guard (guard.ts) keeps
// a tool from calling anywhere but on staging, so this answer reaches a tool page only when the web app is on staging
// and the server it calls is not. The page must then say so: never a success, never a blank page.
//
// isStagingOnlyRefusal tells that answer from every other outcome, and refusedPage is the page that shows it: inside
// the frame, with status 403, saying that the server refused and that nothing was done, with the request's trace id as
// a reference. No source gives these words; they are plain stand-ins, as the shell's error pages are.

import { REFERENCE_LABEL } from "../../shell/error-pages";
import { escapeHtml } from "../../shell/frame";
import type { RouteContext } from "../../shell/route";

/** The `error` of K-21 v1's refusal of a staging-only call outside staging (fixtures/fire-now-in-production.json). */
export const STAGING_ONLY_ERROR = "stagingOnly";

/** The refused page's status: the server understood the call and refused it. */
export const REFUSED_STATUS = 403;

/** The refused page's words. */
export const REFUSED_WORDS = {
  title: "Refused",
  lines: ["The server refused this: it runs on staging only.", "Nothing was done."],
} as const;

/**
 * True when a K-21 call's outcome is the server's refusal of a staging-only call: its own `error` is exactly
 * "stagingOnly". Any other error, and every response, is false.
 */
export function isStagingOnlyRefusal<O extends object>(
  outcome: O,
): outcome is Extract<O, { error: typeof STAGING_ONLY_ERROR }> {
  return Object.hasOwn(outcome, "error") && (outcome as { error?: unknown }).error === STAGING_ONLY_ERROR;
}

/** The page that shows the server's refusal as refused (see the top of this file). */
export function refusedPage(context: RouteContext): Response {
  const main = [
    `<h1>${escapeHtml(REFUSED_WORDS.title)}</h1>`,
    ...REFUSED_WORDS.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p>${escapeHtml(REFERENCE_LABEL)}: <code>${escapeHtml(context.traceId)}</code></p>`,
  ].join("\n");
  return context.page({ title: REFUSED_WORDS.title, main, status: REFUSED_STATUS });
}
