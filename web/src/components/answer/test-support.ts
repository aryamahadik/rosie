// Test support for the page answer kit (T-514). For tests only: it loads the Tool API mock and reads K-21's and K-09's
// fixture files, so nothing the Worker loads may import this module. Every value here is a fixture's own placeholder or
// made up (rule 9).
//
// answerModule() mounts the kit on a route module the way a page shell would (T-515): the question's page at
// /<link code>/answer (GET the form, POST the answer) and the yes at /<link code>/answer/yes, leaving back to the
// question's page. answerShell() runs it on the shell over a transport that sends each call to the Tool API mock
// (C-186), which answers a frozen fixture's request with its outcome and fails loudly on any other, unless the test
// hands that call a stub of its own, for the answers no frozen fixture shows.

import { readFileSync } from "node:fs";
import { exchange, hiddenFields, post } from "../../auth/test-support";
import { cookieNames } from "../../auth/cookies";
import type { OutcomeOf, PageCall, RequestOf } from "../../client/calls";
import { mockTransport, type SentCall } from "../../client/test-support";
import { readWebConfig, type WebConfig } from "../../shell/config";
import type { RouteContext, RouteModule } from "../../shell/route";
import { createWebShell, type WebShell } from "../../shell/shell";
import { TRACE_ID, TEST_LINK_HOST, rethrow, testVars } from "../../shell/test-support";
import { isLinkCode } from "../../link/open";
import { answerKit, readPostedForm, type AnswerPage } from "./kit";
import type { PageQuestion } from "./question-form";

const K09_FIXTURES = new URL("../../../../contracts/tool-api/fixtures/", import.meta.url);

/** K-21 v1 answer-from-page.json: Sam answers S2-22 on the page, and its read-back comes back. */
export const ANSWER_FROM_PAGE = exchange("answer-from-page.json", "answerOnPage");
/** K-21 v1 fee-consent-ok.json: Sam's yes to S1-25's read-back, with no typed name. */
export const FEE_CONSENT_OK = exchange("fee-consent-ok.json", "confirmOnPage");
/** K-21 v1 go-live.json: Sam's yes to S1-29's read-back, with his typed name as his signature. */
export const GO_LIVE = exchange("go-live.json", "confirmOnPage");
/** K-21 v1 staff-page.json: Riley's staff page, whose profile is S2-06's page step with two fields. */
export const STAFF_PAGE = exchange("staff-page.json", "readStaffPage");

/** One card's question and its choices, as K-09 v1's decided context holds them. */
interface DecidedCard {
  readonly question: string;
  readonly choices: readonly { readonly choiceId: string; readonly label: string }[];
}

/** The card of `step` and the choices of `questionId` in a K-09 v1 fixture whose input is a decided turn. */
export function decidedCard(file: string, step: string, questionId: string): DecidedCard {
  const read = JSON.parse(readFileSync(new URL(file, K09_FIXTURES), "utf8")) as {
    request: {
      input: {
        decided: {
          context: {
            cards: { step: string; card: { question: string } }[];
            choices: { question: string; choiceId: string; label: string }[];
          };
        };
      };
    };
  };
  const { context } = read.request.input.decided;
  const card = context.cards.find((one) => one.step === step);
  if (card === undefined) throw new Error(`${file} holds no card of ${step}`);
  return {
    question: card.card.question,
    choices: context.choices
      .filter((choice) => choice.question === questionId)
      .map((choice) => ({ choiceId: choice.choiceId, label: choice.label })),
  };
}

/**
 * S2-22's open question to Sam as the page shows it (K-21 v1 PageQuestion), the one answer-from-page.json answers: the
 * card's question and its options' labels word for word, as K-09 v1 commit-limit-3-no-exact-yes.json's decided turn
 * holds them (answer-from-page.json's note: MASTER-FLOW-A lines 1433 to 1440), and no fields or uploads.
 */
export const S2_22_QUESTION: PageQuestion = {
  questionId: "oq-s2-22-sam",
  stepId: "S2-22",
  words: "Let them take bookings now?",
  options: [
    { choiceId: "c-01", label: "1 Yes, all of them" },
    { choiceId: "c-02", label: "2 Not yet, or no reply" },
  ],
  fields: [],
  uploads: [],
};

/** S2-06's page step as Riley's staff page shows it (staff-page.json's profile question): two fields, no options. */
export function s206Question(): PageQuestion {
  const { outcome } = STAFF_PAGE;
  if ("error" in outcome || outcome.profile.question === null)
    throw new Error("staff-page.json's profile has no question");
  return outcome.profile.question;
}

/** A made-up question with one field of every kind and two options, typed by K-21 v1. */
export const EVERY_KIND_QUESTION: PageQuestion = {
  questionId: "oq-dummy-0001",
  stepId: "S1-12",
  words: "Made-up question with every kind of field?",
  options: [
    { choiceId: "c-01", label: "1 Made-up first option" },
    { choiceId: "c-02", label: "2 Made-up second option" },
  ],
  fields: [
    { field: { name: "name", type: "text" }, prefill: null },
    { field: { name: "visits", type: "integer" }, prefill: null },
    { field: { name: "kept", type: "boolean" }, prefill: null },
    { field: { name: "price", type: "money" }, prefill: "45" },
    { field: { name: "time_saved", type: "time" }, prefill: null },
    { field: { name: "zone", type: "zone" }, prefill: null },
    { field: { name: "place.id", type: "id" }, prefill: null },
    { field: { name: "which", type: "choice" }, prefill: null },
  ],
  uploads: [],
};

/** The fixtures' link code: the registration link of Lee's Barbershop (a placeholder). */
export const LINK = ANSWER_FROM_PAGE.request.page.linkCode ?? "";

/** The page the test module mounts for `code`: the question's page, its yes, and the way back to it. */
export function pageFor(code: string): AnswerPage {
  return {
    title: "Your team",
    answerPath: `/${code}/answer`,
    yesPath: `/${code}/answer/yes`,
    backPath: `/${code}/answer`,
    linkCode: code,
  };
}

/** What the test module takes: the kit's request ids, the question the page shows, and the uploads it binds. */
export interface AnswerModuleOptions {
  readonly requestIds?: readonly string[];
  readonly question?: PageQuestion;
  readonly uploadIds?: readonly string[];
}

/** Gives `first`'s ids in order, then made-up ones, never one twice. */
export function ids(first: readonly string[] = []): () => string {
  let made = 0;
  return () => {
    made += 1;
    return first[made - 1] ?? `req-made-in-test-${String(made)}`;
  };
}

/** The kit on a route module, as a page shell mounts it (see the top of this file). */
export function answerModule(options: AnswerModuleOptions = {}): RouteModule {
  const kit = answerKit({ newRequestId: ids(options.requestIds) });
  const question = options.question ?? S2_22_QUESTION;
  const pageOf = (context: RouteContext): AnswerPage | null => {
    const code = context.params.code ?? "";
    return isLinkCode(code) ? pageFor(code) : null;
  };
  return {
    folder: "components/answer",
    stagingOnly: false,
    routes: [
      {
        label: "answer.question",
        path: "/:code/answer",
        methods: ["GET", "POST"],
        handle: async (context) => {
          const page = pageOf(context);
          if (page === null) return context.notFound();
          if (context.request.method !== "POST") return kit.questionPage(context, page, question);
          const form = await readPostedForm(context.request);
          return kit.answer(context, page, question, form, options.uploadIds);
        },
      },
      {
        label: "answer.yes",
        path: "/:code/answer/yes",
        methods: ["POST"],
        handle: async (context) => {
          const page = pageOf(context);
          if (page === null) return context.notFound();
          return kit.yes(context, page, await readPostedForm(context.request));
        },
      },
    ],
  };
}

/** A stub's answer to one call's request, typed by K-21 v1. */
export type Stub<C extends PageCall> = (request: RequestOf<C>) => OutcomeOf<C>;

/** The stubs a test hands in, by call; every other call goes to the Tool API mock. */
export interface Stubs {
  answerOnPage?: Stub<"answerOnPage">;
  confirmOnPage?: Stub<"confirmOnPage">;
}

/** The test module on the shell, with what it sent and logged. */
export interface AnswerShell {
  readonly shell: WebShell;
  readonly config: WebConfig;
  readonly sent: SentCall[];
  readonly rawLines: () => string[];
}

/** What answerShell takes: the module's options, the trace id every call carries, and the stubs. */
export interface AnswerShellOptions extends AnswerModuleOptions {
  readonly traceId?: string;
  readonly stubs?: Stubs;
}

/** The test module on the shell over the mock, or a test's stubs for the calls it names (see the top of this file). */
export function answerShell(options: AnswerShellOptions = {}): AnswerShell {
  const config = readWebConfig(testVars("staging"));
  const mock = mockTransport("staging");
  const stubs = options.stubs ?? {};
  const sent: SentCall[] = [];
  const raw: string[] = [];
  const shell = createWebShell({
    config,
    transport: {
      send(call, request, traceId) {
        sent.push({ call, request, traceId });
        if (call === "answerOnPage" && stubs.answerOnPage !== undefined)
          return Promise.resolve(stubs.answerOnPage(request as RequestOf<"answerOnPage">));
        if (call === "confirmOnPage" && stubs.confirmOnPage !== undefined)
          return Promise.resolve(stubs.confirmOnPage(request as RequestOf<"confirmOnPage">));
        return mock.send(call, request, traceId);
      },
    },
    modules: [answerModule(options)],
    log: (line) => raw.push(line),
    onRouteError: rethrow,
    newTraceId: () => options.traceId ?? TRACE_ID,
  });
  return { shell, config, sent, rawLines: () => [...raw] };
}

/** The session cookie as a signed-in browser sends it on staging, holding `token`. */
export function sessionCookie(config: WebConfig, token: string): Record<string, string> {
  return { [cookieNames(config).session]: token };
}

/** A GET of `path` on the test site with the cookies given. */
export function getWith(path: string, sentCookies: Record<string, string> = {}): Request {
  const cookie = Object.entries(sentCookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new Request(`https://${TEST_LINK_HOST}${path}`, cookie === "" ? {} : { headers: { cookie } });
}

export { hiddenFields, post };

/** Text or an attribute's value as a browser reads it back from escapeHtml's output. */
export function unescapeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** The text a reader sees in `html`: its tags taken out, each entity read back, its spaces folded. */
export function visibleText(html: string): string {
  return unescapeHtml(
    html
      .replace(/<title>[\s\S]*?<\/title>/g, "")
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<br>/g, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** One tag of a page: its name and its attributes, each value as a browser reads it. */
export interface Tag {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Where the tag starts in the page. */
  readonly at: number;
}

/** Every opening tag named `name` in `html` (one of a, button, fieldset, form, input, label, legend, ...). */
export function tagsOf(html: string, name: string): Tag[] {
  return [...html.matchAll(new RegExp(`<${name}(\\s[^>]*)?>`, "g"))].map((match) => {
    const attributes: Record<string, string> = {};
    for (const one of (match[1] ?? "").matchAll(/([a-z-]+)(?:="([^"]*)")?/g))
      attributes[one[1] ?? ""] = unescapeHtml(one[2] ?? "");
    return { name, attributes, at: match.index };
  });
}

/** The page's <title>, as a browser reads it. */
export function titleOf(html: string): string {
  return unescapeHtml(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "");
}

/** The text inside the element with `id`, as a reader sees it, or null when no element has it. */
export function textOfId(html: string, id: string): string | null {
  const match = new RegExp(
    `<([a-z0-9]+)[^>]*\\sid="${id.replaceAll(".", "\\.")}"[^>]*>([\\s\\S]*?)</\\1>`,
  ).exec(html);
  return match === null ? null : visibleText(match[2] ?? "");
}

/** The fields a browser posts for the page's one form: its hidden fields, with `values` typed in, picked or pressed. */
export function formPost(html: string, values: Record<string, string>): Record<string, string> {
  return { ...hiddenFields(html), ...values };
}
