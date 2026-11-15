// Test support for the test-phone page's thread view (T-524). For tests only: it loads the Tool API mock and reads K-21's
// and K-11's fixture files, so nothing the Worker loads may import this module. Every value here is made up or a
// fixture's own placeholder (rule 9).
//
// mockPartsShell() runs the folder's route on the shell over the Tool API mock, with the trace id and the request id a
// fixture needs, so the view sends exactly test-phone-parts.json's request. stubPartsShell() runs it over a transport
// that answers what a test hands it, each answer typed by K-21 v1, for the answers no frozen fixture shows. Both shells
// also serve T-523's send side and T-525's picker (their own ROUTES, the very lists web/src/routes.ts lists), so a test
// can follow the view's links and the send page's link to the view.

import { readFileSync } from "node:fs";
import { cookieNames } from "../../../auth/cookies";
import { cookies, exchange, ids } from "../../../auth/test-support";
import { isPageError, type OutcomeOf, type PageCall, type ResponseOf } from "../../../client/calls";
import type { SentCall } from "../../../client/test-support";
import { readWebConfig, type WebConfig } from "../../../shell/config";
import { escapeHtml } from "../../../shell/frame";
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
import { ROUTES as PICKER_ROUTES } from "../picker/routes";
import { ROUTES as SEND_ROUTES } from "../send/routes";
import type { PartKind, RecordedPart } from "./page";
import { testPhonePartsRoutes, type PartsDeps } from "./parts";

/** This folder, as web/src/routes.ts names it. */
export const FOLDER = "staging/test-phone/parts";

/** T-523's send side as web/src/routes.ts lists it: its folder, marked staging only, with its own ROUTES. */
export const SEND_MODULE: RouteModule = {
  folder: "staging/test-phone/send",
  stagingOnly: true,
  routes: SEND_ROUTES,
};

/** T-525's picker as web/src/routes.ts lists it: its folder, marked staging only, with its own ROUTES. */
export const PICKER_MODULE: RouteModule = {
  folder: "staging/test-phone/picker",
  stagingOnly: true,
  routes: PICKER_ROUTES,
};

/** K-21 v1's fixture of the call the view makes: a signed-in tester views the first customer's test phone, tp-03. */
export const PARTS = exchange("test-phone-parts.json", "testPhoneParts");

function responseOf(outcome: OutcomeOf<"testPhoneParts">): ResponseOf<"testPhoneParts"> {
  if (isPageError(outcome)) throw new Error("test-phone-parts.json's outcome is not a response");
  return outcome;
}

/** The fixture's answer: tp-03's two parts, its person's one email, its state and its chat link. */
export const RECORDED = responseOf(PARTS.outcome);

const K11_FIXTURES = new URL("../../../../../contracts/port-linq/fixtures/", import.meta.url);

/**
 * K-11 v1's sendPart fixture `file` as the Linq double records it (K-21 v1 RecordedPart): the moment it was sent (the
 * fixture's own, as test-phone-parts.json's parts carry send-text.json's and send-poll.json's), the request and the
 * outcome.
 */
export function recordedOf(file: string): RecordedPart {
  const read = JSON.parse(readFileSync(new URL(file, K11_FIXTURES), "utf8")) as {
    readonly call?: unknown;
    readonly given: { readonly now: string };
    readonly request: RecordedPart["sent"];
    readonly outcome: RecordedPart["outcome"];
  };
  if (read.call !== "sendPart") throw new Error(`${file} is not an exchange of sendPart`);
  return { at: read.given.now, sent: read.request, outcome: read.outcome };
}

/**
 * K-11 v1's frozen send fixtures, one of each kind the view names, in the order T-524's card lists them: a text, a
 * poll with its options, a link card, a calendar file, a photo, typing dots, a tapback and a threaded reply.
 */
export const EVERY_KIND: readonly { readonly file: string; readonly kind: PartKind }[] = [
  { file: "send-text.json", kind: "text" },
  { file: "send-poll.json", kind: "poll" },
  { file: "send-link-card.json", kind: "linkCard" },
  { file: "send-calendar-file.json", kind: "calendarFile" },
  { file: "send-photo.json", kind: "photo" },
  { file: "send-typing.json", kind: "typing" },
  { file: "send-tapback.json", kind: "tapback" },
  { file: "send-threaded-reply.json", kind: "threadedReply" },
];

/** This folder's route module as web/src/routes.ts lists it: the route behind the guard, with the ids a test gives. */
export function partsModule(deps: PartsDeps = {}): RouteModule {
  return { folder: FOLDER, stagingOnly: true, routes: stagingOnlyRoutes(testPhonePartsRoutes(deps)) };
}

/** What a test fixes: the trace id of every request it sends (none sent with it), the calls' request ids, the place. */
export interface Moment {
  readonly traceId?: string;
  readonly requestIds?: readonly string[];
  readonly environment?: TestEnvironment;
}

/** The view, T-523's send side and T-525's picker on the shell over the Tool API mock. */
export function mockPartsShell(moment: Moment = {}): TestShell {
  return testShell({
    environment: moment.environment ?? "staging",
    modules: [partsModule({ newRequestId: ids(moment.requestIds) }), SEND_MODULE, PICKER_MODULE],
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
}

/** What a stub shell answers, each call's answer typed by K-21 v1. A call it is not given fails the test. */
export type Answers = { readonly [C in PageCall]?: OutcomeOf<C> };

/** A shell that answers what the test hands in, with the calls sent and the log lines written. */
export interface StubShell {
  readonly shell: WebShell;
  readonly config: WebConfig;
  readonly sent: SentCall[];
  readonly lines: () => PageLogLine[];
}

/** The view, T-523's send side and T-525's picker on the shell over `answers` (Answers). */
export function stubPartsShell(answers: Answers, moment: Moment = {}): StubShell {
  const sent: SentCall[] = [];
  const raw: string[] = [];
  const config = readWebConfig(testVars(moment.environment ?? "staging"));
  const shell = createWebShell({
    config,
    transport: {
      send(call, request, traceId) {
        sent.push({ call, request, traceId });
        const answer = answers[call];
        if (answer === undefined) return Promise.reject(new Error(`the page made ${call}`));
        return Promise.resolve(structuredClone(answer));
      },
    },
    modules: [partsModule({ newRequestId: ids(moment.requestIds) }), SEND_MODULE, PICKER_MODULE],
    log: (line) => raw.push(line),
    onRouteError: rethrow,
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
  return { shell, config, sent, lines: () => raw.map((line) => JSON.parse(line) as PageLogLine) };
}

/** The session cookie of a signed-in tester's browser, holding `token`: K-21's fixture placeholder unless given. */
export function sessionOf(
  config: WebConfig,
  token: string = PARTS.request.page.sessionToken,
): Record<string, string> {
  return { [cookieNames(config).session]: token };
}

/** A GET of `address` (a path under the site, with its query) from a browser holding `sent` cookies. */
export function open(address: string, sent: Record<string, string> = {}): Request {
  return get(address, Object.keys(sent).length === 0 ? {} : { cookie: cookies(sent) });
}

/**
 * The HTML of the section under the heading `heading` in `html`: from after its <h2> to the next <h2> or the end of the
 * main content. Throws when the page holds no such heading.
 */
export function sectionAfter(html: string, heading: string): string {
  const opened = `<h2>${escapeHtml(heading)}</h2>\n`;
  const start = html.indexOf(opened);
  if (start === -1) throw new Error(`the page holds no heading ${heading}`);
  const rest = html.slice(start + opened.length);
  const ends = [rest.indexOf("\n<h2>"), rest.indexOf("\n</main>")].filter((at) => at !== -1);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

/**
 * The rows of the ordered list that opens the section under `heading`: each row's HTML, in order. A row is an <li> on
 * a line of its own, so the one-line items of a list inside a row (a poll's options) stay in their row. Empty when the
 * section opens with no list.
 */
export function rowsAfter(html: string, heading: string): string[] {
  const section = sectionAfter(html, heading);
  if (!section.startsWith("<ol>\n")) return [];
  return [...section.matchAll(/<li>\n([\s\S]*?)\n<\/li>/g)].map((match) => match[1] ?? "");
}
