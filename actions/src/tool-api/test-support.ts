// Doubles and helpers for the Tool API base's tests (T-290). Never imported by the Worker. No database: the scope is a
// recording fake that writes down each transaction, the scope it set and each read made through its repo, in order.
// Values come only from K-09 v1's fixtures (the master's sample cast, the 555-01xx range: rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import { openTrace, type BundleId, type Span, type TraceContext } from "../../../runtime/src/trace";
import type { CallName } from "./calls";
import type { BusinessScope } from "./scope";
import { notBuiltHandlers, type CallContext, type Handlers } from "./tool-api";
import { CONTRACTS_DIR } from "./validator";

/** Bundle v0's id (K-01 bundle-v0-skeleton): the bundle the fixtures' turns pin. */
export const BUNDLE: BundleId = {
  hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
  build: 1,
};

/** The handle every test trace names: a K-04 handles id, never a number. */
export const HANDLE_REF = "handle-test-0001";

// ---------------------------------------------------------------------------------------------------------------
// The recording repo fake

export type ScopeEvent =
  | { what: "begin" }
  | { what: "scope"; businessId: string }
  | { what: "read"; table: string; rowId: string; scope: string | null }
  | { what: "commit" }
  | { what: "rollback" };

/** The repo a handler gets: it reads nothing, and writes down each read with the scope it ran under. */
export interface RecordingRepo {
  read(table: string, rowId: string): Promise<null>;
}

export interface RecordingScope extends BusinessScope<RecordingRepo> {
  /** Every transaction, scope, read, commit and rollback, in order. */
  readonly events: ScopeEvent[];
}

/** A business scope that records instead of touching a database; a read after its transaction ended is unscoped. */
export function recordingScope(): RecordingScope {
  const events: ScopeEvent[] = [];
  return {
    events,
    async withBusiness(businessId, work) {
      let scope: string | null = null;
      const repo: RecordingRepo = {
        read(table, rowId) {
          events.push({ what: "read", table, rowId, scope });
          return Promise.resolve(null);
        },
      };
      events.push({ what: "begin" });
      events.push({ what: "scope", businessId });
      scope = businessId;
      try {
        const result = await work(repo);
        events.push({ what: "commit" });
        return result;
      } catch (error) {
        events.push({ what: "rollback" });
        throw error;
      } finally {
        scope = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Handlers

/** What a recording handler saw. */
export interface HandlerCall {
  call: CallName;
  request: unknown;
  businessId: string;
}

/**
 * Every call's stub, except `call`, whose handler reads one row through the scoped repo (the business row, so the read
 * is the first thing it does) and then answers `answer(request)`.
 */
export function recordingHandlers(
  call: CallName,
  answer: (request: unknown, context: CallContext<RecordingRepo>) => unknown,
  seen: HandlerCall[] = [],
): Handlers<RecordingRepo> {
  const handlers: Record<string, unknown> = { ...notBuiltHandlers() };
  handlers[call] = async (request: unknown, context: CallContext<RecordingRepo>): Promise<unknown> => {
    seen.push({ call, request, businessId: context.businessId });
    await context.repo.read("businesses", context.businessId);
    return answer(request, context);
  };
  return handlers as Handlers<RecordingRepo>;
}

// ---------------------------------------------------------------------------------------------------------------
// Traces

export interface TestTrace {
  trace: TraceContext;
  /** The spans the trace kept, in order. */
  spans: Span[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The request's caller, when it has one. */
export function callerOf(request: unknown): Record<string, unknown> | undefined {
  return isRecord(request) && isRecord(request.caller) ? request.caller : undefined;
}

/**
 * The trace one request runs in: its id the caller's own (the fixtures use readable placeholders, so the id is made, not
 * read from a header), bundle v0, the test handle, and the caller's turn once its batch has closed.
 */
export function traceFor(request: unknown, traceId?: string): TestTrace {
  const caller = callerOf(request);
  const id = traceId ?? (typeof caller?.traceId === "string" ? caller.traceId : "trace-test-0001");
  const spans: Span[] = [];
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: BUNDLE,
    handleRef: HANDLE_REF,
    newId: () => id,
    sink: (span) => {
      spans.push(span);
    },
  });
  if (typeof caller?.turnId === "string") trace.setTurn(caller.turnId);
  return { trace, spans };
}

// ---------------------------------------------------------------------------------------------------------------
// K-09 v1's fixtures

export interface FixtureEntry {
  file: string;
  version: string;
  def: string;
  expect: "accept" | "refuse";
  rule?: string;
}

/** One exchange: a call's request and its outcome (K-09 v1 `<call>.exchange`). */
export interface Exchange {
  call: CallName;
  request: Record<string, unknown>;
  outcome: unknown;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

const FIXTURES_DIR = path.join(CONTRACTS_DIR, "tool-api", "fixtures");

/**
 * K-09 v1's fixtures/index.json entries. The index also lists later minor versions' fixtures (v1.1 for journey 3,
 * T-050); this base implements and checks v1 only, so it reads the entries whose version is v1.
 */
export function fixtureEntries(): FixtureEntry[] {
  return (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] }).fixtures.filter(
    (entry) => entry.version === "v1",
  );
}

/** One fixture, freshly parsed (a test may change its copy). */
export function fixture(file: string): unknown {
  return readJson(path.join(FIXTURES_DIR, ...file.split("/")));
}

/** Every accepted v1 exchange, with its file name. */
export function acceptedExchanges(): { file: string; exchange: Exchange }[] {
  return fixtureEntries()
    .filter((entry) => entry.expect === "accept" && entry.def.endsWith(".exchange"))
    .map((entry) => ({ file: entry.file, exchange: fixture(entry.file) as Exchange }));
}

/** Reads another contract's file (relative to contracts/), such as a K-08 or K-02 fixture. */
export function contractFile(file: string): unknown {
  return readJson(path.join(CONTRACTS_DIR, ...file.split("/")));
}

/** Every string anywhere in a value, keys excluded. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (isRecord(value)) return Object.values(value).flatMap((item) => stringsIn(item));
  return [];
}
