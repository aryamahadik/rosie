// T-1368 (T-1331's handoff, task 3; DL-708): the Tool API base names its K-09 call to the scope and answers K-09's
// transient where that call's errors have it, through db/repo/scope.ts withBusiness's `call` and `transient` options
// (scope.ts ScopeCall). `npm run db:up`, then `npm run test:integration -- actions/src/tool-api/tool-api.int`.
//
// Every K-09 v1 call that takes a business, and each of journey 5's lane calls (J5_LANE: K-09 v1.3's, checked by v1.8),
// runs through the base (createToolApi) on a scope over withBusiness whose transaction cannot start:
//   - lost as it starts: a client of local PostgreSQL whose socket is closed under it just as its transaction's begin is
//     written (the begin never goes), so postgres.js rejects the begin with its own CONNECTION_CLOSED, the server's host
//     and port in it, as when the server closes the connection;
//   - never opened: a local port nothing listens on (Node's ECONNREFUSED, the address and port on it);
//   - refused at its start: a local server that answers each session with PostgreSQL's FATAL 28P01, the planted user in
//     its message.
// A call whose `$defs/<call>.errors` take K-05's transient answers it for the first two (08006, 08001), its span failed
// and its handler never run; every other call has the start's failure thrown scrubbed under its own K-09 name
// (DataAccessDatabaseError: the call's name and the SQLSTATE alone), and so has every call for a refused session, which
// is never transient. Neither the answer, the thrown error (message, stack and own properties) nor the span holds the
// connection. The calls whose errors have no transient are named here, so a change to K-09's errors shows: today only
// plannerVerbs, which takes no caller and so never reaches a scope. So the other way is shown on each call through a
// validator that is the frozen contract's but for that call's errors, which refuse K-05's transient.
//
// Rule 9: requests come from K-09 v1's fixtures and the master's sample cast (the 555-01xx range); the probe's user,
// password and database are made up here. A check names what leaked, never its value, so a failing run prints no secret.
//
// T-1551 (T-1529's ruling, its card 5; K-09 v1.13 README defaults 216 and 217): on local PostgreSQL, through
// db/repo/scope.ts withBusiness, a gateAndCommit whose handler writes a row in the call's transaction and then meets a
// final fault of the six fault lists answers turnRefused, labels only, and the row is not there afterwards: nothing of
// the refused part is written. A transient fault is thrown as before and writes nothing either; the same handler
// answering a committed turn keeps its row, so the probe table shows a write when there is one.

import { once } from "node:events";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { resolvePrimaryUrl } from "../../../db/repo/client";
import { DataAccessDatabaseError } from "../../../db/repo/clocks";
import { type Sql, type Tx, withBusiness } from "../../../db/repo/scope";
import type { Span } from "../../../runtime/src/trace";
import { CommitRefusedError } from "../commit/errors";
import { WalkRefusedError } from "../commit/walk/errors";
import { CALL_NAMES, type CallName } from "./calls";
import { ToolApiContractError } from "./errors";
import { J5_LANE } from "./j5";
import { CompaniesRefusedError } from "./journey-1/companies/errors";
import { KindsReadError } from "./journey-1/kinds/errors";
import type { BusinessScope, ScopeCall } from "./scope";
import { acceptedExchanges, callerOf, contractFile, fixture, traceFor, type Exchange } from "./test-support";
import {
  createToolApi,
  LaneContractError,
  type CallAnswer,
  type CallContext,
  type Handlers,
  type Lane,
} from "./tool-api";
import { createToolApiValidator, type ToolApiValidator } from "./validator";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

const PROBE_USER = "t1368_probe_user";
const PROBE_PASSWORD = "t1368-probe-password";
const PROBE_DATABASE = "t1368_probe_db";

/** K-05's transient as the base probes a call's errors with it (tool-api.ts TRANSIENT_ERROR). */
const LOST = { error: "transient", sqlstate: "08006" } as const;
const NEVER_OPENED = { error: "transient", sqlstate: "08001" } as const;

/**
 * The K-09 v1 calls whose errors (K-09 v1.5's, v1.6's for composeInput) have no K-05 transient: plannerVerbs alone, the
 * planner's verbs check, which takes no caller and rides inside gateAndCommit, so the base refuses it before any scope
 * (noBusinessScope). Every call that reaches a scope answers transient.
 */
const NO_TRANSIENT: readonly CallName[] = ["plannerVerbs"];

// ---- every call's request ---------------------------------------------------------------------------------------------

/** One accepted request for each call that has one, from a fixture whose caller names a business (tool-api.test.ts's). */
const VALID: Partial<Record<CallName, Json>> = {};
for (const { exchange } of acceptedExchanges()) {
  if (VALID[exchange.call] === undefined && typeof callerOf(exchange.request)?.businessId === "string") {
    VALID[exchange.call] = exchange.request;
  }
}

/** The team console, acting for Lee's Barbershop (tool-api.test.ts's CONSOLE_CALLER). */
const CONSOLE_CALLER = {
  kind: "console",
  turnId: null,
  requestId: "req-console-team-0003",
  businessId: "biz-lees-barbershop",
  personId: "person-rosie-team-1",
  traceId: "trace-console-0003",
};
const AT = "2026-10-21T19:40:00Z";

/** A request for each call that takes a caller and has no accepted fixture (tool-api.test.ts's BUILT, from the cast). */
const BUILT: [CallName, Json][] = [
  [
    "releaseSafetyHold",
    {
      caller: CONSOLE_CALLER,
      holdId: "hold-alex-1",
      expectVersion: 1,
      why: "outcome_message_sent",
      releasedByOutcomeId: null,
    },
  ],
  [
    "handOff",
    {
      caller: CONSOLE_CALLER,
      kind: "other",
      about: "other",
      safetyOutcomeId: null,
      bookingId: null,
      aboutPersonId: null,
      summary: "Alex M. asked to talk to Sam.",
    },
  ],
  [
    "answerHandOff",
    { caller: CONSOLE_CALLER, handOffId: "hand-off-alex-1", expectVersion: 1, via: "console_tap" },
  ],
  [
    "acknowledgePage",
    { caller: CONSOLE_CALLER, pageId: "page-alex-1", expectVersion: 1, via: "console_tap" },
  ],
  ["enterDoor", { caller: CONSOLE_CALLER, door: "S11-12", by: "decide" }],
  [
    "sendFixedLine",
    {
      caller: CONSOLE_CALLER,
      fixedLineId: "optOutLine",
      recipientHandleId: "handle-ben",
      sendClass: "quick_reply",
      sentByActor: null,
    },
  ],
  ["sendsFailing", { caller: CONSOLE_CALLER, outboxRowId: "outbox-ben-1", failingSince: AT }],
  ["textingBack", { caller: CONSOLE_CALLER, recipientHandleId: "handle-ben", outageStartedAt: AT }],
  [
    "calendarLinkDropped",
    {
      caller: CONSOLE_CALLER,
      calendarLinkId: "calendar-link-sam-1",
      personId: "person-sam",
      why: "tokenRevoked",
      droppedAt: AT,
    },
  ],
  ["calendarLinkBack", { caller: CONSOLE_CALLER, calendarLinkId: "calendar-link-sam-1", backAt: AT }],
  ["readSetup", { caller: CONSOLE_CALLER, businessId: "biz-lees-barbershop" }],
];

/** Every call that takes a business, with its request: all of K-09 v1's but plannerVerbs, which has no caller. */
const REQUESTS: [CallName, Json][] = [...(Object.entries(VALID) as [CallName, Json][]), ...BUILT];

/** The first accepted request of each journey 5 lane call (K-09 v1.3's fixtures: J5_LANE's calls), as j5.test.ts reads them. */
const LANE_REQUESTS: [string, Json][] = (() => {
  const index = contractFile("tool-api/fixtures/index.json") as {
    fixtures: { file: string; version: string; def: string; expect: string }[];
  };
  const requests = new Map<string, Json>();
  for (const entry of index.fixtures) {
    const call = J5_LANE.calls.find((each) => entry.def === `${each.call}.exchange`)?.call;
    if (call === undefined || entry.version !== "v1.3" || entry.expect !== "accept" || requests.has(call))
      continue;
    requests.set(call, (fixture(entry.file) as { request: Json }).request);
  }
  return [...requests];
})();

/** Whether the call's errors take K-05's transient, by the frozen definitions the base checks against. */
const errorsHaveTransient = (call: CallName): boolean => validator.check(call, "errors", LOST).length === 0;

/**
 * The frozen contract's checks but for `call`'s errors, which refuse K-05's transient: as K-09 would check a call whose
 * errors had none (no call that reaches a scope is one today: NO_TRANSIENT).
 */
function noTransientFor(call: CallName): ToolApiValidator {
  return {
    check: (name, part, value) =>
      name === call && part === "errors" && (value as { error?: unknown } | null)?.error === "transient"
        ? ["(root) this call's errors have no transient"]
        : validator.check(name, part, value),
    checkSpan: (value) => validator.checkSpan(value),
    laneChecks: (version, name) => validator.laneChecks(version, name),
  };
}

/** The business a request's caller names. */
function businessOf(request: Json): string {
  const businessId = callerOf(request)?.businessId;
  if (typeof businessId !== "string") throw new Error("the request names no business");
  return businessId;
}

// ---- what an outcome must never hold ----------------------------------------------------------------------------------

type Secrets = Readonly<Record<string, RegExp>>;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
  const secrets: Record<string, RegExp> = {};
  for (const [name, value] of Object.entries(values)) {
    secrets[name] =
      typeof value === "number"
        ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
        : new RegExp(escaped(value));
  }
  return secrets;
}

/** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
function textsOf(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return [String(value)];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const texts: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    texts.push(key, ...textsOf((value as Record<string, unknown>)[key], seen));
  }
  return texts;
}

/** The names of the secrets `value` holds anywhere, never their values. */
function leaksOf(value: unknown, secrets: Secrets): string[] {
  const texts = textsOf(value);
  return Object.entries(secrets)
    .filter(([, secret]) => texts.some((text) => secret.test(text)))
    .map(([name]) => name);
}

// ---- the scope and the clients ----------------------------------------------------------------------------------------

/** A scope over db/repo/scope.ts withBusiness on `sql`, handing on what the base tells it (scope.ts ScopeCall). */
function withBusinessScope(sql: Sql): BusinessScope<Tx> {
  return {
    withBusiness: (businessId, work, call) => withBusiness(sql, businessId, work, call),
  };
}

/** Handlers for every call that write down each one that runs and refuse: no call's handler may run here. */
function watchedHandlers(ran: string[]): Handlers<Tx> {
  const handlers: Record<string, unknown> = {};
  for (const call of CALL_NAMES) {
    handlers[call] = (): Promise<never> => {
      ran.push(call);
      return Promise.reject(new Error("the handler must not run"));
    };
  }
  return handlers as Handlers<Tx>;
}

/** The local server (DATABASE_URL, else the local default): its connection string, host and port, never printed. */
function localServer(): { url: string; host: string; port: number } {
  const url = resolvePrimaryUrl();
  const { hostname, port } = new URL(url);
  return { url, host: hostname, port: port === "" ? 5432 : Number(port) };
}

/**
 * A client of the local server, one connection, whose socket is closed under it just as its transaction's begin is to be
 * written (postgres.js's `debug` hook sees each statement as it is built; its `socket` option gives the socket): the
 * begin never goes, and postgres.js rejects it with its own CONNECTION_CLOSED.
 */
function lostAtBegin(): { sql: Sql; sent: string[] } {
  const { url, host, port } = localServer();
  const sent: string[] = [];
  let cutNext = false;
  const options = {
    max: 1,
    onnotice: () => undefined,
    connection: { application_name: "rosie-t1368-tool-api" },
    debug: (_connection: number, text: string) => {
      sent.push(text);
      if (text.trim() === "begin") cutNext = true;
    },
    socket: () => {
      const socket = createConnection(port, host);
      const write = socket.write.bind(socket);
      socket.write = ((...args: Parameters<typeof write>) => {
        if (!cutNext) return write(...args);
        cutNext = false;
        socket.destroy();
        return true;
      }) as typeof socket.write;
      return socket;
    },
  };
  return { sql: postgres(url, options), sent };
}

/** A local port nothing listens on: one the system just handed out and took back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

/** PostgreSQL's ErrorResponse message ('E', its length, then each field's type byte and text, then a zero). */
function errorResponse(fields: Readonly<Record<string, string>>): Uint8Array {
  const texts = Object.entries(fields).map(([type, text]) => `${type}${text}\u0000`);
  const body = new TextEncoder().encode(`${texts.join("")}\u0000`);
  const message = new Uint8Array(body.length + 5);
  const view = new DataView(message.buffer);
  view.setUint8(0, "E".charCodeAt(0));
  view.setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
}

/** A local server that refuses each session at its start, as PostgreSQL does, with `code` and `message`, then closes. */
async function refusingServer(
  code: string,
  message: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.end(errorResponse({ S: "FATAL", V: "FATAL", C: code, M: message }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

/** The probe's connection string: the made-up user, password and database on a local port. */
function probeUrl(port: number): string {
  return `postgres://${PROBE_USER}:${PROBE_PASSWORD}@127.0.0.1:${String(port)}/${PROBE_DATABASE}`;
}

// ---- one call, and what it must leave ---------------------------------------------------------------------------------

/** How one call ended, its span, and which handlers ran. */
interface Ran {
  settled: { answer: CallAnswer } | { thrown: unknown };
  spans: Span[];
  ran: string[];
}

/** One call through the base on `scope`, as a caller would make it, the base checking by `checks`. */
async function callOn(
  scope: BusinessScope<Tx>,
  call: CallName,
  request: Json,
  checks: ToolApiValidator = validator,
): Promise<Ran> {
  const ran: string[] = [];
  const api = createToolApi({ validator: checks, scope, handlers: watchedHandlers(ran) });
  const { trace, spans } = traceFor(request);
  const settled = await api.call(call, structuredClone(request), trace).then(
    (answer) => ({ answer }),
    (thrown: unknown) => ({ thrown }),
  );
  return { settled, spans, ran };
}

/** The one span a call left: failed, with `code`, under the request's business. */
function expectFailedSpan(spans: readonly Span[], code: string, request: Json, what: string): void {
  expect(spans, what).toHaveLength(1);
  expect(spans[0], what).toMatchObject({
    outcome: "failed",
    error_code: code,
    business_id: businessOf(request),
  });
  expect(validator.checkSpan(spans[0]), what).toEqual([]);
}

/** The start's failure thrown scrubbed: the K-09 call's own name and the SQLSTATE alone. */
function expectScrubbedUnder(thrown: unknown, call: CallName, code: string, what: string): void {
  expect(thrown, what).toBeInstanceOf(DataAccessDatabaseError);
  expect(Object.getOwnPropertyNames(thrown).sort(), what).toEqual([
    "call",
    "code",
    "constraint",
    "message",
    "name",
    "stack",
    "table",
  ]);
  expect(thrown, what).toMatchObject({ call, code, table: null, constraint: null });
  expect((thrown as Error).message, what).toBe(`${call}: the database refused the call (SQLSTATE ${code})`);
}

/**
 * What a start the database could not make leaves for `call`: K-09's transient where its errors have it (`answers`),
 * else the failure thrown scrubbed under its name with the same SQLSTATE; its span failed; its handler never ran; and
 * nothing of the connection anywhere.
 */
function expectStartOutcome(
  outcome: Ran,
  [call, request]: [CallName, Json],
  transient: typeof LOST | typeof NEVER_OPENED,
  answers: boolean,
  secrets: Secrets,
): void {
  const what = `${call} (${answers ? "its errors have transient" : "its errors with none"})`;
  expect(outcome.ran, what).toEqual([]);
  for (const seen of [outcome.settled, outcome.spans]) expect(leaksOf(seen, secrets), what).toEqual([]);
  if (answers) {
    expect(outcome.settled, what).toEqual({ answer: transient });
    expect(validator.check(call, "errors", transient), what).toEqual([]);
    expectFailedSpan(outcome.spans, "transient", request, what);
    expect(outcome.spans[0]?.decided, what).toEqual({ answered: "transient" });
    return;
  }
  expect("thrown" in outcome.settled, what).toBe(true);
  expectScrubbedUnder((outcome.settled as { thrown: unknown }).thrown, call, transient.sqlstate, what);
  expectFailedSpan(outcome.spans, "DataAccessDatabaseError", request, what);
}

// ---- the tests --------------------------------------------------------------------------------------------------------

describe("the base names its K-09 call to the scope and answers K-09's transient where the call's errors have it (T-1368)", () => {
  it("covers all 28 calls that take a business; the calls whose errors have no transient are named", () => {
    expect(REQUESTS.map(([call]) => call).sort()).toEqual(
      CALL_NAMES.filter((call) => call !== "plannerVerbs").sort(),
    );
    for (const [call, request] of REQUESTS)
      expect(validator.check(call, "request", request), call).toEqual([]);
    expect(CALL_NAMES.filter((call) => !errorsHaveTransient(call))).toEqual(NO_TRANSIENT);
  });

  it("the scope is told each call's name, and its transient answer exactly where its errors have it", async () => {
    for (const [call, request] of REQUESTS) {
      for (const checks of [validator, noTransientFor(call)]) {
        const told: ScopeCall<unknown>[] = [];
        const scope: BusinessScope<Tx> = {
          withBusiness: (_businessId, _work, scopeCall) => {
            if (scopeCall !== undefined) told.push(scopeCall);
            return Promise.reject(new Error("no transaction here"));
          },
        };
        await callOn(scope, call, request, checks);
        const answers = checks.check(call, "errors", LOST).length === 0;
        expect(answers, call).toBe(checks === validator);
        expect(told, call).toHaveLength(1);
        expect(told[0]?.call, call).toBe(call);
        expect(typeof told[0]?.transient, call).toBe(answers ? "function" : "undefined");
      }
    }
  });

  it("a transaction lost as it starts: K-09's transient 08006 where the errors have it, else thrown scrubbed under the call's name", async () => {
    const { host, port } = localServer();
    const secrets = secretsOf({ "server host": host, "server port": port });
    // What postgres.js rejects the begin with on such a client: its own CONNECTION_CLOSED, the host and port in it.
    const probe = lostAtBegin();
    try {
      const raw = await probe.sql
        .begin(() => Promise.resolve("never"))
        .then(
          () => {
            throw new Error("the begin went");
          },
          (error: unknown) => error,
        );
      expect(raw).toMatchObject({ code: "CONNECTION_CLOSED" });
      expect(leaksOf(raw, secrets)).toEqual(expect.arrayContaining(["server host", "server port"]));
      expect(probe.sent.at(-1)?.trim()).toBe("begin");
    } finally {
      await probe.sql.end({ timeout: 0 });
    }

    for (const entry of REQUESTS) {
      const [call, request] = entry;
      for (const answers of [true, false]) {
        const checks = answers ? validator : noTransientFor(call);
        const client = lostAtBegin();
        try {
          const outcome = await callOn(withBusinessScope(client.sql), call, request, checks);
          expectStartOutcome(outcome, entry, LOST, answers, secrets);
          // The begin was the last statement built: nothing went on the connection after it.
          expect(client.sent.at(-1)?.trim(), call).toBe("begin");
        } finally {
          await client.sql.end({ timeout: 0 });
        }
      }
    }
  });

  it("journey 5's lane calls (J5_LANE, K-09 v1.3 by v1.8): a transaction lost as it starts answers each its transient 08006, its handler never run", async () => {
    const { host, port } = localServer();
    const secrets = secretsOf({ "server host": host, "server port": port });
    expect(LANE_REQUESTS.map(([call]) => call).sort()).toEqual(J5_LANE.calls.map(({ call }) => call).sort());
    for (const [call, request] of LANE_REQUESTS) {
      const ran: string[] = [];
      // J5_LANE's own calls, hops and version, each handler writing down that it ran.
      const lane: Lane<Tx> = {
        lane: J5_LANE.lane,
        calls: J5_LANE.calls.map((each) => ({
          ...each,
          handler: (): Promise<never> => {
            ran.push(each.call);
            return Promise.reject(new Error("the handler must not run"));
          },
        })),
      };
      const client = lostAtBegin();
      try {
        const scope = withBusinessScope(client.sql);
        const api = createToolApi({ validator, scope, handlers: watchedHandlers(ran), lanes: [lane] });
        const { trace, spans } = traceFor(request);
        const settled = await api.call(call, structuredClone(request), trace).then(
          (answer) => ({ answer }),
          (thrown: unknown) => ({ thrown }),
        );
        expect(ran, call).toEqual([]);
        for (const seen of [settled, spans]) expect(leaksOf(seen, secrets), call).toEqual([]);
        expect(settled, call).toEqual({ answer: LOST });
        expectFailedSpan(spans, "transient", request, call);
        expect(client.sent.at(-1)?.trim(), call).toBe("begin");
      } finally {
        await client.sql.end({ timeout: 0 });
      }
    }
  });

  it("a connection that never opens (a closed port): K-09's transient 08001 where the errors have it, else thrown scrubbed", async () => {
    const port = await closedPort();
    const secrets = secretsOf({
      host: "127.0.0.1",
      port,
      user: PROBE_USER,
      password: PROBE_PASSWORD,
      database: PROBE_DATABASE,
    });
    for (const entry of REQUESTS) {
      const [call, request] = entry;
      for (const answers of [true, false]) {
        const checks = answers ? validator : noTransientFor(call);
        const sql = postgres(probeUrl(port), { max: 1, onnotice: () => undefined });
        try {
          const outcome = await callOn(withBusinessScope(sql), call, request, checks);
          expectStartOutcome(outcome, entry, NEVER_OPENED, answers, secrets);
        } finally {
          await sql.end({ timeout: 0 });
        }
      }
    }
  });

  it("a session PostgreSQL refuses at its start (28P01, the planted user in it) is never transient: thrown scrubbed under each call's name", async () => {
    const server = await refusingServer("28P01", `password authentication failed for user "${PROBE_USER}"`);
    const secrets = secretsOf({
      port: server.port,
      user: PROBE_USER,
      password: PROBE_PASSWORD,
      database: PROBE_DATABASE,
    });
    try {
      for (const [call, request] of REQUESTS) {
        const sql = postgres(probeUrl(server.port), { max: 1, onnotice: () => undefined });
        try {
          const outcome = await callOn(withBusinessScope(sql), call, request);
          expect(outcome.ran, call).toEqual([]);
          for (const seen of [outcome.settled, outcome.spans])
            expect(leaksOf(seen, secrets), call).toEqual([]);
          expect("thrown" in outcome.settled, call).toBe(true);
          expectScrubbedUnder((outcome.settled as { thrown: unknown }).thrown, call, "28P01", call);
          expectFailedSpan(outcome.spans, "DataAccessDatabaseError", request, call);
        } finally {
          await sql.end({ timeout: 0 });
        }
      }
    } finally {
      await server.close();
    }
  });

  it("a transient answer outside the call's errors is never passed on: thrown as the contract's error, its span failed", async () => {
    const [call, request] = REQUESTS.find(([name]) => errorsHaveTransient(name)) ?? [];
    if (call === undefined || request === undefined) throw new Error("no call answers transient");
    const scope: BusinessScope<Tx> = {
      withBusiness: <T>(_businessId: string, _work: unknown, scopeCall?: ScopeCall<T>): Promise<T> => {
        const transient = scopeCall?.transient;
        if (transient === undefined) return Promise.reject(new Error("no transient answer was given"));
        return Promise.resolve(transient({ error: "transient", sqlstate: "not a sqlstate" }));
      },
    };
    const outcome = await callOn(scope, call, request);
    expect(outcome.ran).toEqual([]);
    expect("thrown" in outcome.settled).toBe(true);
    const thrown = (outcome.settled as { thrown: unknown }).thrown;
    expect(thrown instanceof ToolApiContractError || thrown instanceof LaneContractError).toBe(true);
    expectFailedSpan(outcome.spans, "invalidResponse", request, call);
  });
});

// ---- T-1551: nothing of a refused part is written ----------------------------------------------------------------------

describe("a final fault answers turnRefused and nothing of the refused part is written, on local PostgreSQL (T-1551)", () => {
  /** A person's row id made up here, which a read's K-05 answer carries: no answer, span or row may hold it. */
  const MADE_UP_ROW = "person-t1551-made-up-int-5e0a";
  const ROW_ID = "row-t1551-refused-part-1";

  /**
   * Handlers for every call that must not run, but gateAndCommit's: it writes one row of the probe table (a temporary
   * table on the call's own connection) in the call's transaction, then ends as `end` says.
   */
  function writingHandlers(end: () => unknown, ran: string[]): Handlers<Tx> {
    const handlers: Record<string, unknown> = { ...watchedHandlers(ran) };
    handlers.gateAndCommit = async (_request: unknown, context: CallContext<Tx>): Promise<unknown> => {
      ran.push("gateAndCommit");
      await context.repo`insert into t1551_refused_part (id) values (${ROW_ID})`;
      return end();
    };
    return handlers as Handlers<Tx>;
  }

  /** One gateAndCommit through the base on a one-connection client of the local server: what it settled and left. */
  async function refusedOn(file: string, end: () => unknown) {
    const { url } = localServer();
    const sql = postgres(url, {
      max: 1,
      onnotice: () => undefined,
      connection: { application_name: "rosie-t1551-tool-api" },
    });
    try {
      await sql`create temporary table t1551_refused_part (id text primary key)`;
      const { request } = fixture(file) as Exchange;
      const ran: string[] = [];
      const api = createToolApi({
        validator,
        scope: withBusinessScope(sql),
        handlers: writingHandlers(end, ran),
      });
      const { trace, spans } = traceFor(request);
      const settled = await api.call("gateAndCommit", structuredClone(request), trace).then(
        (answer) => ({ answer }),
        (thrown: unknown) => ({ thrown }),
      );
      const rows = await sql<{ id: string }[]>`select id from t1551_refused_part`;
      return { settled, spans, ran, kept: rows.map((row) => row.id) };
    } finally {
      await sql.end({ timeout: 0 });
    }
  }

  const finals: { what: string; file: string; thrown: () => Error; answer: CallAnswer }[] = [
    {
      what: "a second company with the party flag off (companies' secondCompany, naming S1-04)",
      file: "commit-s1-04-refused-second-company.json",
      thrown: () => new CompaniesRefusedError("secondCompany", ["S1-04"]),
      answer: (fixture("commit-s1-04-refused-second-company.json") as Exchange).outcome as CallAnswer,
    },
    {
      what: "a step the pinned bundle does not hold (the walk's stepNotInBundle, naming S1-04)",
      file: "commit-s1-02-refused-step-not-in-bundle.json",
      thrown: () => new WalkRefusedError("stepNotInBundle", ["S1-04"]),
      answer: (fixture("commit-s1-02-refused-step-not-in-bundle.json") as Exchange).outcome as CallAnswer,
    },
    {
      what: "a read that found no row (kindsRead's notFound), its K-05 answer holding the row id",
      file: "commit-s1-04-refused-second-company.json",
      thrown: () =>
        new KindsReadError("readPickedKinds", "notFound", {
          error: "notFound",
          table: "persons",
          rowId: MADE_UP_ROW,
        }),
      answer: { error: "turnRefused", from: "kindsRead", fault: "notFound", ids: ["readPickedKinds"] },
    },
  ];

  for (const { what, file, thrown, answer } of finals) {
    it(`${what}: answered turnRefused, labels only; the row the handler wrote is rolled back`, async () => {
      const outcome = await refusedOn(file, () => {
        throw thrown();
      });
      expect(outcome.ran).toEqual(["gateAndCommit"]);
      expect(outcome.settled).toEqual({ answer });
      expect(outcome.kept).toEqual([]);
      expect(outcome.spans).toHaveLength(1);
      expect(outcome.spans[0]).toMatchObject({ hop: "gate", outcome: "refused", error_code: "turnRefused" });
      expect(validator.checkSpan(outcome.spans[0])).toEqual([]);
      for (const seen of [outcome.settled, outcome.spans]) {
        expect(JSON.stringify(seen)).not.toContain(MADE_UP_ROW);
        expect(JSON.stringify(seen)).not.toContain(ROW_ID);
      }
    });
  }

  it("a transient fault (the commit's stillChanged) is thrown as before, and writes nothing either", async () => {
    const stillChanged = new CommitRefusedError("stillChanged", ["oq-s1-04-sam-1"]);
    const outcome = await refusedOn("commit-s1-04-refused-second-company.json", () => {
      throw stillChanged;
    });
    expect(outcome.settled).toEqual({ thrown: stillChanged });
    expect(outcome.kept).toEqual([]);
    expect(outcome.spans[0]).toMatchObject({ outcome: "failed", error_code: "CommitRefusedError" });
  });

  it("the probe shows a write when there is one: the same handler answering a committed turn keeps its row", async () => {
    const committed = fixture("commit-s1-02.json") as Exchange;
    const outcome = await refusedOn("commit-s1-04-refused-second-company.json", () => committed.outcome);
    expect(outcome.settled).toEqual({ answer: committed.outcome });
    expect(outcome.kept).toEqual([ROW_ID]);
  });
});
