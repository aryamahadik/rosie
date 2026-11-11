// The web app's Worker entry (T-511; C-185): fetch(request, env) answers every page request under BASE_PATH through
// the shell (shell.ts), with the config read from the Worker's vars (config.ts: ENVIRONMENT, BASE_PATH, LINK_HOST).
// Whoever hosts the entry hands in how a page's K-21 calls reach the page entry (client/client.ts
// pageEntryTransport); the routes and bindings in wrangler.jsonc are the release engineer's, not this module's.
//
// Vars the web app cannot run on (config.ts WebConfigError) fail closed: every request gets a plain 500 with its trace
// id in x-trace-id and one log line, and no page is rendered, since the frame itself needs BASE_PATH.

import type { PageApiTransport } from "../client/client";
import { WebConfigError, readWebConfig, type WebConfig, type WebVars } from "./config";
import { createWebShell, type PageLogLine, type ShellDeps, type WebShell } from "./shell";
import { traceIdOf } from "./trace";

/** The label the log line gives a request refused for the Worker's vars. */
export const CONFIG_LABEL = "config";

/** What the entry is made from: the shell's own parts, with the transport made for the config the vars gave. */
export interface WebWorkerDeps extends Omit<ShellDeps, "config" | "transport"> {
  /** How a page's K-21 calls reach the page entry, for this config. */
  transport: (config: WebConfig) => PageApiTransport;
}

/** The Worker entry: a fetch handler over the Worker's vars. */
export interface WebWorker {
  readonly fetch: (request: Request, env: WebVars) => Promise<Response>;
}

/** The web app's Worker entry (see the top of this file). */
export function createWebWorker(deps: WebWorkerDeps): WebWorker {
  // One shell for each env the runtime hands in (an isolate keeps one), made on its first request.
  const shells = new WeakMap<WebVars, WebShell>();
  const { transport, ...shellDeps } = deps;

  const shellOf = (env: WebVars): WebShell => {
    const made = shells.get(env);
    if (made !== undefined) return made;
    const config = readWebConfig(env);
    const shell = createWebShell({ ...shellDeps, config, transport: transport(config) });
    shells.set(env, shell);
    return shell;
  };

  return {
    fetch(request, env) {
      let shell: WebShell;
      try {
        shell = shellOf(env);
      } catch (error) {
        if (!(error instanceof WebConfigError)) throw error;
        const traceId = traceIdOf(request, deps.newTraceId);
        const line: PageLogLine = {
          level: "error",
          msg: "page",
          trace_id: traceId,
          route: CONFIG_LABEL,
          status: 500,
        };
        (
          deps.log ??
          ((text: string) => {
            console.log(text);
          })
        )(JSON.stringify(line));
        return Promise.resolve(
          new Response("The page could not be shown.\n", {
            status: 500,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "x-trace-id": traceId,
            },
          }),
        );
      }
      return shell.fetch(request);
    },
  };
}
