// Test support for the test-phone page's send side (T-523). For tests only: it loads the Tool API mock and reads K-21's
// fixture files, so nothing the Worker loads may import this module. Every value here is made up or a K-21 fixture's
// own placeholder (rule 9).
//
// mockSendShell() runs the folder's routes on the shell over the Tool API mock (shell/test-support.ts testShell), with
// the trace id and the forms' request ids a fixture needs, so the page sends exactly the fixture's request.
// stubSendShell() runs them over a transport that answers what a test hands it, typed by K-21 v1 testPhoneSend, for the
// answers no frozen fixture shows.

import { cookieNames } from "../../../auth/cookies";
import { cookies, exchange, ids, post } from "../../../auth/test-support";
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
import { PHONE_FIELD, REPLY_FIELD, REQUEST_FIELD, SEND_PATH, WORDS_FIELD } from "./page";
import { testPhoneSendRoutes, type SendDeps } from "./send";

/** This folder, as web/src/routes.ts names it. */
export const FOLDER = "staging/test-phone/send";

/** K-21 v1's fixture of the call the page makes: a tester sends as tp-04, as a threaded reply. */
export const SEND = exchange("test-phone-send.json", "testPhoneSend");

function responseOf(outcome: OutcomeOf<"testPhoneSend">): ResponseOf<"testPhoneSend"> {
  if (isPageError(outcome)) throw new Error("test-phone-send.json's outcome is not a response");
  return outcome;
}

/** The fixture's answer: sent, with the trace the gateway opened. */
export const SENT = responseOf(SEND.outcome);

/** This folder's route module as web/src/routes.ts lists it: the routes behind the guard, with the ids a test gives. */
export function sendModule(deps: SendDeps = {}): RouteModule {
  return { folder: FOLDER, stagingOnly: true, routes: stagingOnlyRoutes(testPhoneSendRoutes(deps)) };
}

/** What a test fixes: the trace id of every request it sends (none sent with it), the forms' request ids, the place. */
export interface Moment {
  readonly traceId?: string;
  readonly requestIds?: readonly string[];
  readonly environment?: TestEnvironment;
}

/** The folder's routes on the shell over the Tool API mock. */
export function mockSendShell(moment: Moment = {}): TestShell {
  return testShell({
    environment: moment.environment ?? "staging",
    modules: [sendModule({ newRequestId: ids(moment.requestIds) })],
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
}

/** A shell whose testPhoneSend answers what the test hands in, with the calls sent and the log lines written. */
export interface StubShell {
  readonly shell: WebShell;
  readonly config: WebConfig;
  readonly sent: SentCall[];
  readonly lines: () => PageLogLine[];
}

/** The folder's routes on the shell over `answer`, a K-21 v1 testPhoneSend outcome. Any other call fails the test. */
export function stubSendShell(answer: OutcomeOf<"testPhoneSend">, moment: Moment = {}): StubShell {
  const sent: SentCall[] = [];
  const raw: string[] = [];
  const config = readWebConfig(testVars(moment.environment ?? "staging"));
  const shell = createWebShell({
    config,
    transport: {
      send(call, request, traceId) {
        sent.push({ call, request, traceId });
        if (call !== "testPhoneSend") return Promise.reject(new Error(`the page made ${call}`));
        return Promise.resolve(structuredClone(answer));
      },
    },
    modules: [sendModule({ newRequestId: ids(moment.requestIds) })],
    log: (line) => raw.push(line),
    onRouteError: rethrow,
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
  return { shell, config, sent, lines: () => raw.map((line) => JSON.parse(line) as PageLogLine) };
}

/** The session cookie of a signed-in tester's browser, holding `token`: K-21's fixture placeholder unless given. */
export function sessionOf(
  config: WebConfig,
  token: string = SEND.request.page.sessionToken,
): Record<string, string> {
  return { [cookieNames(config).session]: token };
}

/** A GET of `address` (a path under the site, with its query) from a browser holding `sent` cookies. */
export function open(address: string, sent: Record<string, string> = {}): Request {
  return get(address, Object.keys(sent).length === 0 ? {} : { cookie: cookies(sent) });
}

/** What a tester types into the send form, beside the fields the page put in it. */
export interface Typed {
  readonly words?: string;
  readonly replyTo?: string;
}

/** The send form's POST, as a browser sends it from this site: the page's own fields, what was typed, the cookies. */
export function sendPost(
  config: WebConfig,
  fields: Record<string, string>,
  sent: Record<string, string> = sessionOf(config),
): Request {
  return post(`${config.basePath}${SEND_PATH}`, fields, sent);
}

/** The form fields a browser posts: the page's hidden ones (`hidden`) and what was typed. */
export function typedInto(hidden: Record<string, string>, typed: Typed): Record<string, string> {
  return {
    ...hidden,
    [WORDS_FIELD]: typed.words ?? "",
    [REPLY_FIELD]: typed.replyTo ?? "",
  };
}

/** A whole send form's fields, as the page shows them for `phone` with `requestId`, and what was typed. */
export function wholeForm(phone: string, requestId: string, typed: Typed): Record<string, string> {
  return typedInto({ [REQUEST_FIELD]: requestId, [PHONE_FIELD]: phone }, typed);
}

/** The page's send form: its HTML from <form method="post" to its </form>. Throws when the page holds none. */
export function sendFormOf(html: string): string {
  const start = html.indexOf('<form method="post"');
  const end = html.indexOf("</form>", start);
  if (start === -1 || end === -1) throw new Error("the page holds no send form");
  return html.slice(start, end + "</form>".length);
}

/** The value of the text input named `name` in `html`, unescaped as a browser reads it, or null when there is none. */
export function inputValue(html: string, name: string): string | null {
  const input = new RegExp(`<input id="[^"]*" name="${name}" type="text" value="([^"]*)"`).exec(html);
  if (input === null) return null;
  return (input[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
