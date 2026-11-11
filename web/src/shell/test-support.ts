// Test support for the web shell and the pages built on it (T-511). For tests only: it loads the Tool API mock
// (client/test-support.ts) and reads wrangler.jsonc, so nothing the Worker loads may import this module.
//
// testShell() is the shell a page test runs its routes on: the vars of the environment asked for (BASE_PATH as
// wrangler.jsonc sets it), the transport over the Tool API mock for that environment, the log lines kept instead of
// written, and whatever a handler throws thrown again, so a request no fixture holds fails the test with the mock's own
// error instead of a 500 page. Every value here is made up (rule 9).

import { readBasePath } from "../../../compiler/src/fixed-lines";
import { mockTransport, type MockTransport } from "../client/test-support";
import { readWebConfig, type WebConfig, type WebVars } from "./config";
import { createWebShell, type PageLogLine, type ShellDeps, type WebShell } from "./shell";

/** The environments wrangler.jsonc names. */
export type TestEnvironment = "staging" | "production";

/**
 * The link host the tests run on. wrangler.jsonc sets no LINK_HOST yet (the release engineer's file), so this is the
 * tests' own value: rosfield.com, the host DL-014 and DL-023 name.
 */
export const TEST_LINK_HOST = "rosfield.com";

/** A valid trace id, made up. */
export const TRACE_ID = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";

/** What a new trace id looks like: a UUID in lower case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Worker's vars for an environment: ENVIRONMENT, BASE_PATH as wrangler.jsonc sets it, and the tests' link host. */
export function testVars(environment: TestEnvironment): Required<WebVars> {
  return { ENVIRONMENT: environment, BASE_PATH: readBasePath(environment), LINK_HOST: TEST_LINK_HOST };
}

/** A shell under test, with what it was made from and what it has logged. */
export interface TestShell {
  readonly shell: WebShell;
  readonly config: WebConfig;
  readonly transport: MockTransport;
  /** The log lines written so far, each parsed. */
  readonly lines: () => PageLogLine[];
  /** The raw log lines written so far. */
  readonly rawLines: () => string[];
}

/** What testShell takes: the environment (staging when left out), and any of the shell's own parts to replace. */
export interface TestShellOptions extends Partial<Omit<ShellDeps, "config" | "transport" | "log">> {
  environment?: TestEnvironment;
  /** Vars that replace the environment's own. */
  vars?: WebVars;
}

/** Throws what a handler threw, so the test fails on it. */
export function rethrow(error: unknown): never {
  throw error;
}

/** A shell on the Tool API mock (see the top of this file). */
export function testShell(options: TestShellOptions = {}): TestShell {
  const { environment = "staging", vars, ...deps } = options;
  const config = readWebConfig({ ...testVars(environment), ...vars });
  const transport = mockTransport(environment);
  const raw: string[] = [];
  const shell = createWebShell({
    onRouteError: rethrow,
    ...deps,
    config,
    transport,
    log: (line) => raw.push(line),
  });
  return {
    shell,
    config,
    transport,
    lines: () => raw.map((line) => JSON.parse(line) as PageLogLine),
    rawLines: () => [...raw],
  };
}

/** A GET of `path` on the site the tests run on, with the headers given. */
export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://${TEST_LINK_HOST}${path}`, { headers });
}

/** Every value of `attribute` in `html`. */
export function attributeValues(html: string, attribute: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, "g"))].map((match) => match[1] ?? "");
}
