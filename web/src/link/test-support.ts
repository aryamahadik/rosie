// Test support for the signed-link opener (T-512). For tests only: it loads the Tool API mock and reads K-21's fixture
// files, so nothing the Worker loads may import this module. Every value here is made up or a K-21 fixture's own
// placeholder (rule 9).
//
// mockLinkShell() runs the link route on the shell over the Tool API mock, with the request id and trace id a fixture's
// request holds, so the opener sends exactly that request and gets exactly that fixture's outcome. stubLinkShell() runs
// it over a transport that answers what a test hands it, for the answers no accepted fixture shows (a refused fixture's
// outcome, transient, bookingPaused, another code's linkExpired).

import { readFileSync } from "node:fs";
import type { OutcomeOf, RequestOf } from "../client/calls";
import type { SentCall } from "../client/test-support";
import { readWebConfig, type WebConfig } from "../shell/config";
import type { RouteModule } from "../shell/route";
import { createWebShell, type WebShell } from "../shell/shell";
import {
  TRACE_ID,
  rethrow,
  testShell,
  testVars,
  type TestEnvironment,
  type TestShell,
} from "../shell/test-support";
import { linkRoutes, type LinkDeps } from "./open";

const FIXTURES = new URL("../../../contracts/page-api/fixtures/", import.meta.url);

/** One K-21 openLink fixture: its request paired with its outcome, in the environment its given names. */
export interface OpenLinkExchange {
  call: "openLink";
  given: { now: string; environment: TestEnvironment; after: string[]; note: string };
  request: RequestOf<"openLink">;
  outcome: OutcomeOf<"openLink">;
}

/** The K-21 fixture `file` (under contracts/page-api/fixtures/), which must be an openLink exchange. */
export function openLinkFixture(file: string): OpenLinkExchange {
  const read = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as { call: unknown };
  if (read.call !== "openLink") throw new Error(`${file} is not an exchange of openLink`);
  return read as OpenLinkExchange;
}

/** The link folder's route module, with the request ids a test hands in. */
export function linkModule(deps: LinkDeps = {}): RouteModule {
  return { folder: "link", stagingOnly: false, routes: linkRoutes(deps) };
}

/** The address of a fixture's link on the test site: BASE_PATH plus its code. */
export function linkPath(config: WebConfig, fixture: OpenLinkExchange): string {
  return `${config.basePath}/${fixture.request.page.linkCode}`;
}

/**
 * The link route on the shell over the Tool API mock, with the fixture's request id and trace id, in the fixture's
 * environment. `before` lists route modules served beside it, ahead of it as web/src/routes.ts lists the link last.
 */
export function mockLinkShell(fixture: OpenLinkExchange, before: readonly RouteModule[] = []): TestShell {
  return testShell({
    environment: fixture.given.environment,
    modules: [...before, linkModule({ newRequestId: () => fixture.request.page.requestId })],
    newTraceId: () => fixture.request.page.traceId,
  });
}

/** A shell over a transport that answers what a test hands in, with the calls sent and the log lines written. */
export interface StubLinkShell {
  readonly shell: WebShell;
  readonly config: WebConfig;
  readonly sent: SentCall[];
  readonly rawLines: () => string[];
}

/** The link route on the shell over answers `answer` gives (see the top of this file). */
export function stubLinkShell(
  answer: (request: RequestOf<"openLink">) => OutcomeOf<"openLink">,
  environment: TestEnvironment = "staging",
): StubLinkShell {
  const sent: SentCall[] = [];
  const raw: string[] = [];
  const config = readWebConfig(testVars(environment));
  const shell = createWebShell({
    config,
    transport: {
      send(call, request, traceId) {
        sent.push({ call, request, traceId });
        return Promise.resolve(answer(request as RequestOf<"openLink">));
      },
    },
    modules: [linkModule({ newRequestId: () => "req-link-made-in-test-1" })],
    log: (line) => raw.push(line),
    onRouteError: rethrow,
    newTraceId: () => TRACE_ID,
  });
  return { shell, config, sent, rawLines: () => [...raw] };
}
