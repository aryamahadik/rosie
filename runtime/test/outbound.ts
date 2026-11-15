// The Workers test pool's outbound tripwire (T-1411, DL-832; T-1408's handoff and both its reviewers): no request a
// Workers test's code sends with the global fetch leaves the Mac, and a test stands in for an outside host behind it.
//
// Why. Before it, the pool's global outbound was the network: a Workers test's fetch() went wherever its url said, and
// the no-network guarantee rested on each test's own stub of the global fetch (T-1408's QA and security notes).
//
// How. vitest.config.ts makes this file the Workers pool's main (both Workers projects): runtime/src/index.ts's exports,
// unchanged, plus OutboundTripwire, an entrypoint of the pool's own Worker, which the Worker reaches through its own
// service binding (ROSIE_TEST_OUTBOUND). The pool's miniflare.outboundService is a relay in vitest.config.ts that hands
// each request the Worker's global fetch sends straight back to that binding (miniflare 5 takes no entrypoint of the
// Worker itself as its outbound: "Cannot convert v4 Miniflare option "outboundService""). So every request the pool's
// Worker sends with the global fetch is built and sent by workerd's own fetch, as on the edge, and lands here, in the
// test's own isolate, never on the network:
//   - a host a test claimed (claimHost): its stand-in gets the request as workerd's fetch built it (the url, the method,
//     the headers, the body) and answers it, and workerd applies the request's redirect mode to that answer: under
//     "manual" a 3xx comes back as it is; under "follow" workerd asks for its Location, through the tripwire again.
//     Options workerd refuses (redirect "error") are refused before anything reaches the stand-in;
//   - any other host: the tripwire answers with a failure (TRIPWIRE_STATUS) whose words name the host alone, never the
//     path, a query, a header or the body, and keeps the host. This file is also the Workers projects' setup file, so
//     after each test (and after the file's last hook) checkUnclaimed fails that test when the tripwire answered
//     anything, naming the hosts alone: a test that reaches for the network fails loudly, even when the code under test
//     swallowed the failure.
//
// The one way for a test to stand in for an outside host (for example api.anthropic.com):
//
//   beforeEach(() => {
//     claimHost("api.anthropic.com", (request) => new Response(...));
//   });
//
// The code under test then calls the global fetch as the Worker does, with no stub. A claim lasts until the test ends
// (the setup's afterEach drops every claim), so each test claims what it uses, in beforeEach or in its own body. A test
// that means to send to a host no test claimed reads what the tripwire answered with takeUnclaimed.
//
// What it does not cover: a raw socket. miniflare 5 sends a Worker's cloudflare:sockets connect() around a function
// outbound, straight to the address (measured on T-1411's branch: a test's connect() to the rig's PostgreSQL server,
// 127.0.0.1:54329, opened), and the sockets of the Workers tests' database calls (Hyperdrive's bindings) do not pass
// through it either. So the tripwire holds every fetch(), not a raw socket: tripping connect() is a later task.
//
// Not the Worker's: a deployed Worker never imports this file (wrangler.jsonc's main is runtime/src/index.ts), so nothing
// here changes what a Worker sends in production.
import { WorkerEntrypoint } from "cloudflare:workers";
import { afterAll, afterEach } from "vitest";

export * from "../src/index";
export { default } from "../src/index";

/** The status of the tripwire's answer to a request no test claimed (a gateway that refused to pass it on). */
export const TRIPWIRE_STATUS = 502;

/** How the tripwire's words begin, in its answers and in the check's failures. */
const TRIPWIRE = "The Workers test pool's outbound tripwire (runtime/test/outbound.ts)";

/** A bare host as URL.host spells it: a name or an address, with a port when it is not the scheme's own. */
const BARE_HOST = /^[^\s/?#@\\]+$/u;

/** A stand-in for one outside host: it answers each request the code under test sent there. */
export type StandIn = (request: Request) => Response | Promise<Response>;

/** The hosts claimed in the test that runs, by URL.host. */
const claims = new Map<string, StandIn>();

/** The hosts the tripwire answered since the last take, in the order it first answered each. */
const unclaimed = new Set<string>();

/**
 * Claims an outside host for the test that runs: each request the code under test sends there (by the url's host) goes
 * to `standIn`, and what it returns is the answer. The claim ends when the test ends.
 */
export function claimHost(host: string, standIn: StandIn): void {
  if (!BARE_HOST.test(host)) {
    throw new TypeError(`${TRIPWIRE}: claimHost takes a bare host, such as api.anthropic.com, never a url`);
  }
  const key = host.toLowerCase();
  if (claims.has(key)) throw new Error(`${TRIPWIRE}: ${key} is already claimed in this test`);
  claims.set(key, standIn);
}

/** The hosts the tripwire answered since the last take, in order, each once; the record is then empty. */
export function takeUnclaimed(): string[] {
  const hosts = [...unclaimed];
  unclaimed.clear();
  return hosts;
}

/** Throws when the tripwire answered a request since the last take, naming the hosts alone; empties the record. */
export function checkUnclaimed(): void {
  const hosts = takeUnclaimed();
  if (hosts.length === 0) return;
  throw new Error(
    `${TRIPWIRE}: a request went to ${hosts.join(", ")}, which no test claimed. The tripwire answered it with a ` +
      `failure and nothing was sent. A test stands in for an outside host with claimHost.`,
  );
}

/**
 * The pool's Worker's global outbound (vitest.config.ts): each request its global fetch sends, as workerd built it. A
 * claimed host's stand-in answers it; any other host gets the tripwire's failure, naming the host alone.
 */
export class OutboundTripwire extends WorkerEntrypoint {
  override fetch(request: Request): Response | Promise<Response> {
    const host = new URL(request.url).host;
    const standIn = claims.get(host);
    if (standIn !== undefined) return standIn(request);
    unclaimed.add(host);
    return new Response(`${TRIPWIRE}: no test claimed ${host}, so nothing was sent there.`, {
      status: TRIPWIRE_STATUS,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

// The setup's part (vitest.config.ts setupFiles): after each test, its claims end and anything the tripwire answered
// fails it; after the file's last hook, the same check covers what the file's own afterAll hooks sent.
afterEach(() => {
  claims.clear();
  checkUnclaimed();
});
afterAll(() => {
  claims.clear();
  checkUnclaimed();
});
