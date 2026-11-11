// Test support for the sign-in pages (T-520). For tests only: it loads the Tool API mock and reads K-21's fixture
// files, so nothing the Worker loads may import this module. Every value here is made up or a K-21 fixture's own
// placeholder (rule 9).
//
// mockShell() runs the sign-in routes on the shell over the Tool API mock, with the clock, the trace id and the form's
// request id a fixture needs, so the page sends exactly the fixture's request. stubShell() runs them over a transport
// that answers what a test hands it, each answer typed by K-21 v1, for the answers no frozen fixture shows.

import { readFileSync } from "node:fs";
import type { OutcomeOf, PageCall, RequestOf, ResponseOf } from "../client/calls";
import type { SentCall } from "../client/test-support";
import { readWebConfig, type WebConfig } from "../shell/config";
import type { RouteModule } from "../shell/route";
import { createWebShell, type WebShell } from "../shell/shell";
import {
  TEST_LINK_HOST,
  TRACE_ID,
  rethrow,
  testShell,
  testVars,
  type TestEnvironment,
  type TestShell,
} from "../shell/test-support";
import type { SignedInPerson } from "./consoles";
import { signInRoutes, type SignInDeps } from "./sign-in";

const FIXTURES = new URL("../../../contracts/page-api/fixtures/", import.meta.url);

/** One K-21 fixture of a call: its request paired with its outcome, at the moment its given names. */
export interface Exchange<C extends PageCall> {
  call: C;
  given: { now: string; environment: TestEnvironment };
  request: RequestOf<C>;
  outcome: OutcomeOf<C>;
}

/** The K-21 fixture `file`, which must be an exchange of `call`. */
export function exchange<C extends PageCall>(file: string, call: C): Exchange<C> {
  const read = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as Exchange<C>;
  if (read.call !== call) throw new Error(`${file} is not an exchange of ${call}`);
  return read;
}

/** This site's origin in the tests, as a same-origin form's POST names it. */
export const ORIGIN = `https://${TEST_LINK_HOST}`;

/** The auth folder's route module, with the clock and ids a test hands in. */
export function authModule(deps: SignInDeps = {}): RouteModule {
  return { folder: "auth", stagingOnly: false, routes: signInRoutes(deps) };
}

/** Gives `first`'s ids in order, then made-up ones, never one twice. */
export function ids(first: readonly string[] = []): () => string {
  let made = 0;
  return () => {
    made += 1;
    return first[made - 1] ?? `req-made-in-test-${String(made)}`;
  };
}

/** What a fixture's flow fixes: the moment, the trace id every call carries and the request ids its forms get. */
export interface Moment {
  now: string | (() => Date);
  traceId?: string;
  requestIds?: readonly string[];
  environment?: TestEnvironment;
}

function depsAt(moment: Moment): SignInDeps {
  const { now } = moment;
  return {
    now: typeof now === "string" ? () => new Date(now) : now,
    newRequestId: ids(moment.requestIds),
    newDeviceToken: () => "dummy-device-token-made-in-test",
  };
}

/** The sign-in routes on the shell over the Tool API mock, at a fixture's moment. */
export function mockShell(moment: Moment): TestShell {
  return testShell({
    environment: moment.environment ?? "staging",
    modules: [authModule(depsAt(moment))],
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
}

/** A shell over a transport that answers what `answer` gives, with the calls sent and the log lines written. */
export interface StubShell {
  readonly shell: WebShell;
  readonly config: WebConfig;
  readonly sent: SentCall[];
  readonly rawLines: () => string[];
}

/** The sign-in routes on the shell over answers a test hands in (see the top of this file). */
export function stubShell(answer: (call: PageCall, request: unknown) => unknown, moment: Moment): StubShell {
  const sent: SentCall[] = [];
  const raw: string[] = [];
  const config = readWebConfig(testVars(moment.environment ?? "staging"));
  const shell = createWebShell({
    config,
    transport: {
      send(call, request, traceId) {
        sent.push({ call, request, traceId });
        return Promise.resolve(answer(call, request));
      },
    },
    modules: [authModule(depsAt(moment))],
    log: (line) => raw.push(line),
    onRouteError: rethrow,
    newTraceId: () => moment.traceId ?? TRACE_ID,
  });
  return { shell, config, sent, rawLines: () => [...raw] };
}

/** A Cookie header from names and values. */
export function cookies(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** A form's POST from this site's own origin, as a browser sends one, with the cookies given. */
export function post(
  path: string,
  fields: Record<string, string>,
  sentCookies: Record<string, string> = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      ...(Object.keys(sentCookies).length === 0 ? {} : { cookie: cookies(sentCookies) }),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const unescaped = (text: string): string =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

/** The hidden fields of a page's forms, as a browser would post them back. */
export function hiddenFields(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map((match) => [
      match[1] ?? "",
      unescaped(match[2] ?? ""),
    ]),
  );
}

/** A Set-Cookie value's name and value. */
export function cookiePair(setCookie: string): Record<string, string> {
  const first = setCookie.split(";")[0] ?? "";
  const at = first.indexOf("=");
  return { [first.slice(0, at)]: first.slice(at + 1) };
}

/** A signedIn answer for `person`, with a made-up token and end. */
export function signedIn(person: SignedInPerson): ResponseOf<"signInCheck"> {
  return {
    result: "signedIn",
    sessionToken: "dummy-session-token-0001",
    sessionExpiresAt: "2026-12-01T00:00:00Z",
    person,
  };
}

/** A made-up person with the roles given, in one made-up business. */
export function person(
  roles: readonly SignedInPerson["roles"][number]["role"][],
  flags: { team?: boolean; tester?: boolean } = {},
): SignedInPerson {
  return {
    personId: "person-dummy-0001",
    roles: roles.map((role) => ({ role, businessId: "biz-dummy-0001" })),
    team: flags.team ?? false,
    tester: flags.tester ?? false,
  };
}

/** Every answer signInStart may give, one of each kind, typed by K-21 v1. */
export const START_OUTCOMES: readonly OutcomeOf<"signInStart">[] = [
  {
    result: "started",
    attemptId: "attempt-dummy-0001",
    way: "email",
    expiresAt: "2026-10-26T13:10:00Z",
    readyText: null,
    textLink: null,
  },
  {
    result: "started",
    attemptId: "attempt-dummy-0002",
    way: "text",
    expiresAt: "2026-10-26T13:10:00Z",
    readyText: "My Rosie sign-in code is 000000",
    textLink: "sms:+15555550188&body=My%20Rosie%20sign-in%20code%20is%20000000",
  },
  { error: "paused", until: "2026-10-26T13:15:00Z" },
];

/** Every answer signInCheck may give, one of each kind, typed by K-21 v1. */
export const CHECK_OUTCOMES: readonly OutcomeOf<"signInCheck">[] = [
  signedIn(person(["owner"], { team: true, tester: true })),
  { result: "wrong", triesLeft: 4 },
  { result: "paused", until: "2026-10-26T13:15:00Z" },
  { result: "expired" },
  { result: "waitingForText", expiresAt: "2026-10-26T13:10:00Z" },
  { result: "alreadySignedIn" },
  { result: "secondProofNeeded", ways: ["emailCode", "idReCheck"] },
  { error: "attemptNotFound" },
];
