// Test support for the seeded test-state picker (T-525). For tests only: it loads the Tool API mock and reads K-21's
// fixture files, so nothing the Worker loads may import this module. Every value here is made up or a K-21 fixture's
// own placeholder (rule 9).
//
// mockPickerShell() runs the folder's route on the shell over the Tool API mock, with the trace id and the request id a
// fixture needs, so the page sends exactly test-roster.json's request. stubPickerShell() runs it over a transport that
// answers what a test hands it, typed by K-21 v1 testRoster, for the answers no frozen fixture shows. Both shells also
// serve T-523's own send routes (send/routes.ts, the very list web/src/routes.ts lists), so a test can follow a
// phone's link to the send side.

import { cookieNames } from "../../../auth/cookies";
import { cookies, exchange, ids } from "../../../auth/test-support";
import { isPageError, type OutcomeOf, type ResponseOf } from "../../../client/calls";
import type { SentCall } from "../../../client/test-support";
import { readWebConfig, type WebConfig } from "../../../shell/config";
import type { RouteModule } from "../../../shell/route";
import { createWebShell, type PageLogLine, type WebShell } from "../../../shell/shell";
import {
  TRACE_ID,
  get,
  rethrow,
  testShell,
  testVars,
  type TestEnvironment,
  type TestShell,
} from "../../../shell/test-support";
import { stagingOnlyRoutes } from "../../guard";
import { ROUTES as SEND_ROUTES } from "../send/routes";
import { testPhonePickerRoutes, type PickerDeps } from "./picker";

/** This folder, as web/src/routes.ts names it. */
export const FOLDER = "staging/test-phone/picker";

/** T-523's send side as web/src/routes.ts lists it: its folder, marked staging only, with its own ROUTES. */
export const SEND_MODULE: RouteModule = {
  folder: "staging/test-phone/send",
  stagingOnly: true,
  routes: SEND_ROUTES,
};

/** K-21 v1's fixture of the call the page makes: a tester signed in on staging opens the picker. */
export const ROSTER = exchange("test-roster.json", "testRoster");

function responseOf(outcome: OutcomeOf<"testRoster">): ResponseOf<"testRoster"> {
  if (isPageError(outcome)) throw new Error("test-roster.json's outcome is not a response");
  return outcome;
}

/** The fixture's answer: two seeded test businesses and the roster's five test phones. */
export const LISTED = responseOf(ROSTER.outcome);

/** This folder's route module as web/src/routes.ts lists it: the route behind the guard, with the ids a test gives. */
export function pickerModule(deps: PickerDeps = {}): RouteModule {
  return { folder: FOLDER, stagingOnly: true, routes: stagingOnlyRoutes(testPhonePickerRoutes(deps)) };
}

/** What a test fixes: the trace id of every request it sends (none sent with it), the calls' request ids, the place. */
export interface Moment {
  readonly traceId?: string;
  readonly requestIds?: readonly string[];
  readonly environment?: TestEnvironment;
}

/** The picker and T-523's send side on the shell over the Tool API mock. */
export function mockPickerShell(moment: Moment = {}): TestShell {
  return testShell({
    environment: moment.environment ?? "staging",
    modules: [pickerModule({ newRequestId: ids(moment.requestIds) }), SEND_MODULE],
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
}

/** A shell whose testRoster answers what the test hands in, with the calls sent and the log lines written. */
export interface StubShell {
  readonly shell: WebShell;
  readonly config: WebConfig;
  readonly sent: SentCall[];
  readonly lines: () => PageLogLine[];
}

/** The picker and T-523's send side on the shell over `answer`, a K-21 v1 testRoster outcome. Any other call fails. */
export function stubPickerShell(answer: OutcomeOf<"testRoster">, moment: Moment = {}): StubShell {
  const sent: SentCall[] = [];
  const raw: string[] = [];
  const config = readWebConfig(testVars(moment.environment ?? "staging"));
  const shell = createWebShell({
    config,
    transport: {
      send(call, request, traceId) {
        sent.push({ call, request, traceId });
        if (call !== "testRoster") return Promise.reject(new Error(`the page made ${call}`));
        return Promise.resolve(structuredClone(answer));
      },
    },
    modules: [pickerModule({ newRequestId: ids(moment.requestIds) }), SEND_MODULE],
    log: (line) => raw.push(line),
    onRouteError: rethrow,
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
  return { shell, config, sent, lines: () => raw.map((line) => JSON.parse(line) as PageLogLine) };
}

/** The session cookie of a signed-in tester's browser, holding `token`: K-21's fixture placeholder unless given. */
export function sessionOf(
  config: WebConfig,
  token: string = ROSTER.request.page.sessionToken,
): Record<string, string> {
  return { [cookieNames(config).session]: token };
}

/** A GET of `address` (a path under the site, with its query) from a browser holding `sent` cookies. */
export function open(address: string, sent: Record<string, string> = {}): Request {
  return get(address, Object.keys(sent).length === 0 ? {} : { cookie: cookies(sent) });
}

/** HTML text as a browser reads it: the five characters escapeHtml writes, back as they were. */
export function unescaped(html: string): string {
  return html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * The rows of the list right after the heading `heading` in `html`: each <li>'s HTML, in order. Empty when the heading
 * is followed by no list; throws when the page holds no such heading.
 */
export function rowsAfter(html: string, heading: string): string[] {
  const start = html.indexOf(`<h2>${heading}</h2>\n`);
  if (start === -1) throw new Error(`the page holds no heading ${heading}`);
  const after = html.slice(start + `<h2>${heading}</h2>\n`.length);
  if (!after.startsWith("<ul>\n")) return [];
  const list = after.slice(0, after.indexOf("\n</ul>"));
  return [...list.matchAll(/<li>\n([\s\S]*?)\n<\/li>/g)].map((match) => match[1] ?? "");
}

/** Every link in `html`: its address as a browser reads it, and its words. */
export function linksIn(html: string): { href: string; words: string }[] {
  return [...html.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((match) => ({
    href: unescaped(match[1] ?? ""),
    words: unescaped(match[2] ?? ""),
  }));
}
