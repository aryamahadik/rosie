// T-1022's proofs (DL-728), on K-09's own frozen schemas and fixtures and the base's recording scope, never a database:
//   - every call K-09 v1.3 adds (its `$defs/callName`, less v1.2's) resolves to the handler J5_LANE registers for it, from
//     the call's own folder, held to K-09 v1.8: frozen, and the newest version frozen at main a218f36 whose root carries
//     the call by $ref;
//   - each unbuilt handler answers notBuilt and writes nothing: its transaction rolled back, nothing read, no row noted;
//   - a lane call with a bad request answers invalidRequest, before its handler runs and before any transaction; one with
//     no business never reaches its handler either: K-09's businessCaller refuses it first (invalidRequest), and step 4
//     itself answers noBusinessScope when the checks let such a request through;
//   - registering a K-09 v1 call's name, or a name a lane registered already, is refused at registration
//     (LaneRegistrationError), as are a lane with no label, a hop K-08 does not name, and a version that is not frozen,
//     is not a K-09 version, or whose root does not carry the call;
//   - the base answers a lane call by steps 1 to 7: one K-08 span on the call's own hop (a page's a pageRequest, an
//     agent's an agentApiRequest) with labels only, its answer held to its version's response and errors, an answer
//     outside them thrown and rolled back; and with J5_LANE registered, every K-09 v1 call answers exactly as without it,
//     and every call another lane would add is still unknownCall.
// Values come only from the contracts' fixtures (the master's sample cast, the 555-01xx range: rule 9).

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Hop, Span } from "../../../../runtime/src/trace";
import { CALL_NAMES, callerHop, isCallName, isCallerKind } from "../calls";
import {
  BUNDLE,
  HANDLE_REF,
  acceptedExchanges,
  callerOf,
  contractFile,
  fixture,
  recordingScope,
  stringsIn,
  traceFor,
  type RecordingRepo,
  type ScopeEvent,
} from "../test-support";
import {
  LaneContractError,
  LaneNotBuiltError,
  LaneRegistrationError,
  createToolApi,
  notBuiltHandlers,
  type CallContext,
  type CallOptions,
  type Lane,
  type LaneCall,
  type LaneHandler,
  type LaneRefused,
} from "../tool-api";
import { createToolApiValidator, type ToolApiValidator } from "../validator";
import { J5_LANE, J5_VERSION } from "./index";
import * as refundAtOnceFolder from "./refundAtOnce";
import * as settleOfferFolder from "./settleOffer";
import * as showMoneyBeforeFolder from "./showMoneyBefore";
import * as signDocumentFolder from "./signDocument";
import * as takeMoneyBeforeFolder from "./takeMoneyBefore";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** This folder, actions/src/tool-api/j5/. */
const J5_DIR = fileURLToPath(new URL(".", import.meta.url));

interface Root {
  $id: string;
  anyOf?: { $ref?: string }[];
  $defs: Record<string, unknown>;
}

/** K-09 `version`'s schema file, as frozen. */
function rootOf(version: string): Root {
  return contractFile(`tool-api/tool-api.${version}.schema.json`) as Root;
}

/** Every call K-09 `version` holds: its `$defs/callName` enum. */
function callNamesOf(version: string): string[] {
  return (rootOf(version).$defs.callName as { enum: string[] }).enum;
}

/** The calls K-09 v1.3 adds: its callName's, less v1.2's (README "v1.3": journey 5's), in v1.3's order. */
const V1_3_CALLS = callNamesOf("v1.3").filter((call) => !callNamesOf("v1.2").includes(call));

/**
 * K-09's frozen versions at main a218f36, when J5_LANE was registered (contracts/tool-api/frozen.json then), oldest
 * first. A frozen version is never removed (contracts/README.md "frozen.json"), so this stays a part of the list.
 */
const FROZEN_AT_A218F36 = ["v1", "v1.1", "v1.2", "v1.3", "v1.4", "v1.5", "v1.6", "v1.8"];

/** Each call's own folder, by the call's name. */
const FOLDERS: Record<string, { CALL: string; handler: LaneHandler<unknown> }> = {
  showMoneyBefore: showMoneyBeforeFolder,
  settleOffer: settleOfferFolder,
  signDocument: signDocumentFolder,
  takeMoneyBefore: takeMoneyBeforeFolder,
  refundAtOnce: refundAtOnceFolder,
};

/** The hop J5_LANE registered for `call`. */
function ownHopOf(call: string): Hop {
  const registered = J5_LANE.calls.find((each) => each.call === call);
  if (registered === undefined) throw new Error(`J5_LANE registers no ${call}`);
  return registered.hop;
}

// ---- K-09 v1.3's journey 5 fixtures ----------------------------------------------------------------------------------

interface IndexEntry {
  file: string;
  version: string;
  def: string;
  expect: "accept" | "refuse";
}

/** One journey 5 exchange: a call's request and its outcome. */
interface LaneExchange {
  call: string;
  request: Json;
  outcome: unknown;
}

/** Every accepted exchange K-09 v1.3 holds for its journey 5 calls, with its file. */
const J5_EXCHANGES = (contractFile("tool-api/fixtures/index.json") as { fixtures: IndexEntry[] }).fixtures
  .filter(
    (entry) =>
      entry.version === "v1.3" &&
      entry.expect === "accept" &&
      V1_3_CALLS.some((call) => entry.def === `${call}.exchange`),
  )
  .map((entry) => ({ file: entry.file, exchange: fixture(entry.file) as LaneExchange }));

/** The first accepted request of each journey 5 call, its caller naming a business. */
const VALID = new Map<string, Json>();
for (const { exchange } of J5_EXCHANGES) {
  if (!VALID.has(exchange.call)) VALID.set(exchange.call, exchange.request);
}

function validOf(call: string): Json {
  const request = VALID.get(call);
  if (request === undefined) throw new Error(`K-09 v1.3 has no accepted ${call} exchange`);
  return structuredClone(request);
}

/** A copy of `request` without one field. */
function without(request: Json, field: string): Json {
  return Object.fromEntries(Object.entries(request).filter(([key]) => key !== field));
}

// ---- bases and handlers ----------------------------------------------------------------------------------------------

/** What a recording lane handler saw. */
interface Seen {
  call: string;
  request: unknown;
  businessId: string;
}

/**
 * J5_LANE's calls, each with its name, hop and version, and a handler that notes what it saw, reads the business row
 * through the scoped repo first, and then answers `answer` (as tool-api.test.ts's recordingHandlers do for v1's calls).
 */
function recordingLane(
  answer: (call: string, request: unknown) => unknown,
  seen: Seen[] = [],
): Lane<RecordingRepo> {
  return {
    lane: J5_LANE.lane,
    calls: J5_LANE.calls.map(({ call, hop, version }) => ({
      call,
      hop,
      version,
      handler: async (request: unknown, context: CallContext<RecordingRepo>): Promise<unknown> => {
        seen.push({ call, request, businessId: context.businessId });
        await context.repo.read("businesses", context.businessId);
        return answer(call, request);
      },
    })),
  };
}

/** A base over a recording scope, every K-09 v1 call a stub, with `lanes` registered (default: J5_LANE). */
function baseWith(lanes: readonly Lane<RecordingRepo>[] = [J5_LANE], checks: ToolApiValidator = validator) {
  const scope = recordingScope();
  const api = createToolApi<RecordingRepo>({
    validator: checks,
    scope,
    handlers: notBuiltHandlers(),
    lanes,
  });
  return { api, scope };
}

/** What one call left: its answer or what it threw, its scope's events and its spans. */
interface Ran {
  answered: unknown;
  thrown: unknown;
  events: ScopeEvent[];
  spans: Span[];
}

async function run(
  call: string,
  request: unknown,
  lanes: readonly Lane<RecordingRepo>[] = [J5_LANE],
  options?: CallOptions,
  traceId?: string,
): Promise<Ran> {
  const { api, scope } = baseWith(lanes);
  const { trace, spans } = traceFor(request, traceId);
  const settled = await api.call(call, structuredClone(request), trace, options).then(
    (answered) => ({ answered, thrown: undefined }),
    (thrown: unknown) => ({ answered: undefined, thrown }),
  );
  return { ...settled, events: scope.events, spans };
}

/** The one span a call left; fails the test when there is not exactly one. */
function onlySpan(spans: readonly Span[]): Span {
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no span");
  return span;
}

/** A span without its timing, which two runs of a call never share. */
function untimed(span: Span): Partial<Span> {
  const copy: Partial<Span> = { ...span };
  delete copy.at;
  delete copy.ms;
  return copy;
}

/** The hop a lane call's span takes for `request`: a page's pageRequest, an agent's agentApiRequest, else its own. */
function hopFor(call: string, request: unknown): Hop {
  const kind = callerOf(request)?.kind;
  return callerHop(ownHopOf(call), isCallerKind(kind) ? kind : undefined);
}

const never = (): unknown => {
  throw new Error("the handler must not run");
};

// ---------------------------------------------------------------------------------------------------------------------

describe("every call K-09 v1.3 adds resolves to the handler J5_LANE registers, in the call's own folder", () => {
  it("K-09 v1.3 adds journey 5's five calls, none of K-09 v1, and J5_LANE registers exactly those, in v1.3's order", () => {
    expect(V1_3_CALLS).toEqual([
      "showMoneyBefore",
      "settleOffer",
      "signDocument",
      "takeMoneyBefore",
      "refundAtOnce",
    ]);
    expect(V1_3_CALLS.filter((call) => isCallName(call))).toEqual([]);
    expect(J5_LANE.lane).toBe("j5");
    expect(J5_LANE.calls.map(({ call }) => call)).toEqual(V1_3_CALLS);
  });

  it("each call has a folder of its own named by the call, whose index.ts gives the handler J5_LANE registers", () => {
    const folders = readdirSync(J5_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual([...V1_3_CALLS].sort());
    for (const { call, handler } of J5_LANE.calls) {
      expect(existsSync(path.join(J5_DIR, call, "index.ts")), call).toBe(true);
      const folder = FOLDERS[call];
      expect(folder?.CALL, call).toBe(call);
      expect(handler, call).toBe(folder?.handler);
    }
  });

  it("each is held to K-09 v1.8: frozen, and the newest version frozen at a218f36 whose root carries it by $ref", () => {
    const frozen = (contractFile("tool-api/frozen.json") as { frozen: string[] }).frozen;
    expect(frozen).toEqual(expect.arrayContaining(FROZEN_AT_A218F36));
    expect(J5_VERSION).toBe("v1.8");
    for (const { call, version } of J5_LANE.calls) {
      expect(version, call).toBe(J5_VERSION);
      const carriers = FROZEN_AT_A218F36.filter((each) =>
        (rootOf(each).anyOf ?? []).some((branch) => branch.$ref === `#/$defs/${call}.exchange`),
      );
      // First carried by v1.3, which adds it, and last by v1.8.
      expect([carriers[0], carriers.at(-1)], call).toEqual(["v1.3", J5_VERSION]);
      const v18 = rootOf(J5_VERSION);
      for (const part of ["request", "response", "errors"]) {
        expect(v18.$defs[`${call}.${part}`], `${call}.${part}`).toBeDefined();
      }
      expect(validator.laneChecks(version, call)).toMatchObject({ version: "v1.8", call });
    }
  });

  it("through the base, each name reaches its own registered handler, inside its business's scope", async () => {
    const seen: Seen[] = [];
    const lane = recordingLane(() => ({ error: "transient", sqlstate: "40001" }), seen);
    for (const call of V1_3_CALLS) {
      const request = validOf(call);
      const businessId = callerOf(request)?.businessId;
      const { answered, events } = await run(call, request, [lane]);
      expect(answered, call).toEqual({ error: "transient", sqlstate: "40001" });
      expect(seen.at(-1), call).toEqual({ call, request, businessId });
      expect(
        events.map((event) => event.what),
        call,
      ).toEqual(["begin", "scope", "read", "rollback"]);
    }
    expect(seen.map(({ call }) => call)).toEqual(V1_3_CALLS);
  });
});

describe("each unbuilt handler answers notBuilt and writes nothing", () => {
  it("K-09 v1.3 holds 24 accepted journey 5 exchanges, every call among them, each caller naming a business", () => {
    expect(J5_EXCHANGES).toHaveLength(24);
    expect(new Set(J5_EXCHANGES.map(({ exchange }) => exchange.call))).toEqual(new Set(V1_3_CALLS));
    for (const { file, exchange } of J5_EXCHANGES) {
      expect(typeof callerOf(exchange.request)?.businessId, file).toBe("string");
    }
  });

  for (const { file, exchange } of J5_EXCHANGES) {
    it(`${file}: ${exchange.call} answers notBuilt inside its scope, rolled back, nothing read and no row noted`, async () => {
      const businessId = callerOf(exchange.request)?.businessId as string;
      const { answered, thrown, events, spans } = await run(exchange.call, exchange.request);
      expect(thrown).toBeUndefined();
      expect(answered).toEqual({ error: "notBuilt", call: exchange.call });
      expect(events).toEqual([{ what: "begin" }, { what: "scope", businessId }, { what: "rollback" }]);
      const span = onlySpan(spans);
      expect(span).toMatchObject({
        hop: hopFor(exchange.call, exchange.request),
        outcome: "refused",
        error_code: "notBuilt",
        decided: { answered: "notBuilt" },
        got: { toolCall: exchange.call, callerKind: callerOf(exchange.request)?.kind },
      });
      expect(span.rows).toBeUndefined();
      expect(validator.checkSpan(span)).toEqual([]);
    });
  }

  it("each handler itself rejects with LaneNotBuiltError naming its call, and touches neither its request nor its context", async () => {
    for (const { call, handler } of J5_LANE.calls) {
      const touched: string[] = [];
      const watched = (what: string) =>
        new Proxy(
          {},
          {
            get(_target, key) {
              touched.push(`${what}.${String(key)}`);
              return undefined;
            },
          },
        );
      const settled = handler(watched("request"), watched("context") as CallContext<unknown>);
      await expect(settled, call).rejects.toBeInstanceOf(LaneNotBuiltError);
      await expect(settled, call).rejects.toMatchObject({ name: "LaneNotBuiltError", call });
      expect(touched, call).toEqual([]);
    }
  });
});

describe("a lane call's request is checked before its handler runs", () => {
  for (const call of V1_3_CALLS) {
    it(`${call}: a bad request answers invalidRequest, before its handler, its scope and any read`, async () => {
      const valid = validOf(call);
      const someField = Object.keys(valid).find((key) => key !== "caller") ?? "caller";
      const invalid: [string, unknown][] = [
        ["no fields", {}],
        ["null", null],
        ["a list", []],
        ["words", "please book Ben T. in at 3"],
        ["only a caller", { caller: callerOf(valid) }],
        ["a field K-09 v1.8 does not have", { ...valid, phone: "+15555550131" }],
        [`no ${someField}`, without(valid, someField)],
        ["a caller kind off the list", { ...valid, caller: { ...callerOf(valid), kind: "robot" } }],
      ];
      for (const [what, request] of invalid) {
        const seen: Seen[] = [];
        const { answered, events, spans } = await run(call, request, [recordingLane(never, seen)]);
        expect(answered, what).toMatchObject({ error: "invalidRequest", call });
        expect(Object.keys(answered as object).sort(), what).toEqual(["call", "error", "problems"]);
        const { problems } = answered as { problems: string[] };
        expect(problems.length, what).toBeGreaterThan(0);
        expect(JSON.stringify(answered), what).not.toContain("+15555550131");
        expect(seen, what).toEqual([]);
        expect(events, what).toEqual([]);
        const span = onlySpan(spans);
        expect(span, what).toMatchObject({
          hop: hopFor(call, request),
          outcome: "refused",
          error_code: "invalidRequest",
        });
        expect(span.decided, what).toEqual({ answered: "invalidRequest", problems: problems.length });
        expect(validator.checkSpan(span), what).toEqual([]);
      }
    });
  }

  it("a request naming another trace than the one the call runs in is refused, before its handler", async () => {
    const seen: Seen[] = [];
    const request = validOf("takeMoneyBefore");
    const { answered, events, spans } = await run(
      "takeMoneyBefore",
      request,
      [recordingLane(never, seen)],
      undefined,
      "trace-page-alex-9999",
    );
    expect(answered).toEqual({
      error: "invalidRequest",
      call: "takeMoneyBefore",
      problems: ["/caller/traceId is not the trace the call runs in"],
    });
    expect(seen).toEqual([]);
    expect(events).toEqual([]);
    expect(onlySpan(spans)).toMatchObject({ trace_id: "trace-page-alex-9999", outcome: "refused" });
  });

  for (const call of V1_3_CALLS) {
    it(`${call}: a request with no business never reaches its handler: K-09's businessCaller refuses it first`, async () => {
      const valid = validOf(call);
      const unscoped: [string, unknown][] = [
        ["caller.businessId null", { ...valid, caller: { ...callerOf(valid), businessId: null } }],
        ["no caller", without(valid, "caller")],
      ];
      for (const [what, request] of unscoped) {
        const seen: Seen[] = [];
        const { answered, events, spans } = await run(call, request, [recordingLane(never, seen)]);
        expect(answered, what).toMatchObject({ error: "invalidRequest", call });
        const { problems } = answered as { problems: string[] };
        expect(
          problems.some((line) => line.startsWith(what === "no caller" ? "(root)" : "/caller/businessId")),
          what,
        ).toBe(true);
        expect(seen, what).toEqual([]);
        expect(events, what).toEqual([]);
        expect(onlySpan(spans).business_id, what).toBeUndefined();
      }
    });
  }

  it("step 4 itself: with checks that let a request with no business through, each call answers noBusinessScope, before its handler and any transaction", async () => {
    // A double of the validator whose lane checks accept anything: no frozen K-09 definition of a lane's call takes a
    // request without a business today (businessCaller), so this shows the base's own step 4 guards every lane call.
    const admitsAll: ToolApiValidator = {
      check: (call, part, value) => validator.check(call, part, value),
      checkSpan: (value) => validator.checkSpan(value),
      laneChecks: (version, call) => ({ version, call, check: () => [] }),
    };
    for (const call of V1_3_CALLS) {
      const valid = validOf(call);
      const seen: Seen[] = [];
      const scope = recordingScope();
      const api = createToolApi<RecordingRepo>({
        validator: admitsAll,
        scope,
        handlers: notBuiltHandlers(),
        lanes: [recordingLane(never, seen)],
      });
      for (const request of [
        { ...valid, caller: { ...callerOf(valid), businessId: null } },
        without(valid, "caller"),
      ]) {
        const { trace, spans } = traceFor(request);
        expect(await api.call(call, request, trace), call).toEqual({ error: "noBusinessScope", call });
        const span = onlySpan(spans);
        expect(span, call).toMatchObject({ outcome: "refused", error_code: "noBusinessScope" });
        expect(span.business_id, call).toBeUndefined();
      }
      expect(seen, call).toEqual([]);
      expect(scope.events, call).toEqual([]);
    }
  });
});

describe("registration refuses a K-09 v1 call's name, a name registered already, and every lane call it cannot hold", () => {
  const stub: LaneHandler<unknown> = () => Promise.reject(new Error("never run"));

  /** One lane call: settleOffer on K-09 v1.8 at the commit hop, with `change` over it. */
  function laneCall(change: Partial<LaneCall<unknown>> = {}): LaneCall<unknown> {
    return { call: "settleOffer", hop: "commit", version: J5_VERSION, handler: stub, ...change };
  }

  /** The error registering `lanes` throws; fails the test when the base is made. */
  function refusal(lanes: readonly Lane<unknown>[]): LaneRegistrationError {
    try {
      createToolApi<RecordingRepo>({
        validator,
        scope: recordingScope(),
        handlers: notBuiltHandlers(),
        lanes,
      });
    } catch (error) {
      if (error instanceof LaneRegistrationError) return error;
      throw error;
    }
    throw new Error("the lanes were registered");
  }

  function expectRefused(
    lanes: readonly Lane<unknown>[],
    expected: { lane: string; call: string; why: LaneRefused },
  ): LaneRegistrationError {
    const error = refusal(lanes);
    expect(error).toMatchObject(expected);
    expect(error.message).toContain(`(${expected.why})`);
    return error;
  }

  it("J5_LANE alone registers, with nothing else: the base is made", () => {
    expect(() => baseWith([J5_LANE])).not.toThrow();
    expect(() => baseWith([])).not.toThrow();
  });

  it("each of K-09 v1's 29 calls is refused by name, though K-09 v1.8's root carries it", () => {
    expect(CALL_NAMES).toHaveLength(29);
    for (const call of CALL_NAMES) {
      expectRefused([{ lane: "j5", calls: [laneCall({ call })] }], { lane: "j5", call, why: "v1Call" });
    }
    expect(rootOf(J5_VERSION).anyOf).toContainEqual({ $ref: "#/$defs/gateAndCommit.exchange" });
  });

  it("a name registered already is refused: J5_LANE twice, one call twice in a lane, another lane's call", () => {
    expectRefused([J5_LANE, J5_LANE], { lane: "j5", call: "showMoneyBefore", why: "registered" });
    expectRefused([{ lane: "j5", calls: [laneCall(), laneCall()] }], {
      lane: "j5",
      call: "settleOffer",
      why: "registered",
    });
    const error = expectRefused([J5_LANE, { lane: "j5b", calls: [laneCall({ call: "takeMoneyBefore" })] }], {
      lane: "j5b",
      call: "takeMoneyBefore",
      why: "registered",
    });
    expect(error.message).toContain("lane j5 registered it already");
  });

  it("a lane named by no label, and a hop K-08 does not name, are refused", () => {
    for (const lane of ["", "j 5", "j5\n"]) {
      expectRefused([{ lane, calls: [laneCall()] }], { lane, call: "settleOffer", why: "lane" });
    }
    const notHops: readonly string[] = ["money", "Commit", ""];
    for (const notAHop of notHops) {
      expectRefused([{ lane: "j5", calls: [laneCall({ hop: notAHop as Hop })] }], {
        lane: "j5",
        call: "settleOffer",
        why: "hop",
      });
    }
  });

  it("a version that is not K-09's, not frozen, or whose root does not carry the call is refused, and so is a name no version carries", () => {
    const frozen = (contractFile("tool-api/frozen.json") as { frozen: string[] }).frozen;
    const newest = Math.max(...frozen.map((version) => Number(version.split(".")[1] ?? "0")));
    const notFrozen = `v1.${String(newest + 1)}`;
    const cases: [Partial<LaneCall<unknown>>, string][] = [
      [{ version: "v1.2" }, "root does not carry settleOffer"],
      [{ version: notFrozen }, `K-09 ${notFrozen} is not frozen`],
      [{ version: "v2" }, "not a K-09 version"],
      [{ version: "../model/model.v1.2" }, "not a K-09 version"],
      [{ version: "" }, "not a K-09 version"],
      [{ call: "bookEverything" }, "root does not carry bookEverything"],
    ];
    for (const [change, found] of cases) {
      const call = change.call ?? "settleOffer";
      const error = expectRefused([{ lane: "j5", calls: [laneCall(change)] }], {
        lane: "j5",
        call,
        why: "version",
      });
      expect(error.message, found).toContain(found);
    }
  });

  it("the validator itself never gives a lane the checks of a K-09 v1 call", () => {
    expect(() => validator.laneChecks(J5_VERSION, "gateAndCommit")).toThrow("a call of K-09 v1");
    expect(() => validator.check("takeMoneyBefore" as never, "request", {})).toThrow("not a call of K-09 v1");
  });
});

describe("the base answers a lane call by steps 1 to 7, as a K-09 v1 call", () => {
  for (const { file, exchange } of J5_EXCHANGES) {
    it(`${file}: ${exchange.call}'s handler gets the request in its scope; its answer comes back, held to K-09 v1.8; one span of labels`, async () => {
      const caller = callerOf(exchange.request) ?? {};
      const businessId = caller.businessId as string;
      const seen: Seen[] = [];
      const { answered, events, spans } = await run(exchange.call, exchange.request, [
        recordingLane(() => structuredClone(exchange.outcome), seen),
      ]);
      expect(seen).toEqual([{ call: exchange.call, request: exchange.request, businessId }]);
      expect(answered).toEqual(exchange.outcome);
      // Each error is an object with its own "error" (02-contracts 2 item 2), "Refused, nothing written": rolled back.
      const code = (exchange.outcome as { error?: unknown }).error;
      const isError = typeof code === "string";
      expect(events).toEqual([
        { what: "begin" },
        { what: "scope", businessId },
        { what: "read", table: "businesses", rowId: businessId, scope: businessId },
        { what: isError ? "rollback" : "commit" },
      ]);

      const span = onlySpan(spans);
      expect(span.trace_id).toBe(caller.traceId);
      expect(span.bundle_id).toEqual(BUNDLE);
      expect(span.handle_ref).toBe(HANDLE_REF);
      expect(span.hop).toBe(hopFor(exchange.call, exchange.request));
      expect(span.got).toEqual({ toolCall: exchange.call, callerKind: caller.kind });
      expect(span.decided).toEqual({ answered: isError ? code : "response" });
      expect(span.business_id).toBe(businessId);
      expect(validator.checkSpan(span)).toEqual([]);
      // Nothing of the request reaches the span but its caller's trace, turn, business and kind (and the pinned bundle).
      const allowed = new Set([caller.traceId, caller.turnId, caller.businessId, caller.kind, BUNDLE.hash]);
      const inSpan = new Set(stringsIn(span));
      expect(stringsIn(exchange.request).filter((value) => !allowed.has(value) && inSpan.has(value))).toEqual(
        [],
      );
      expect(stringsIn(span).filter((value) => /[\s+@]/u.test(value))).toEqual([]);
    });
  }

  it("one of the call's errors comes back as it is, rolled back; a transient one is a failed span", async () => {
    for (const call of V1_3_CALLS) {
      const transient = { error: "transient", sqlstate: "40001" };
      const { answered, events, spans } = await run(call, validOf(call), [recordingLane(() => transient)]);
      expect(answered, call).toEqual(transient);
      expect(events.at(-1), call).toEqual({ what: "rollback" });
      expect(onlySpan(spans), call).toMatchObject({ outcome: "failed", error_code: "transient" });
    }
  });

  it("an answer outside K-09 v1.8 is never passed on: rolled back and thrown as LaneContractError, the span naming no value", async () => {
    for (const call of V1_3_CALLS) {
      const { answered, thrown, events, spans } = await run(call, validOf(call), [
        recordingLane(() => ({ rowId: 7, phone: "+15555550131" })),
      ]);
      expect(answered, call).toBeUndefined();
      expect(thrown, call).toBeInstanceOf(LaneContractError);
      expect(thrown, call).toMatchObject({ call, version: "v1.8" });
      expect((thrown as LaneContractError).problems.length, call).toBeGreaterThan(0);
      expect(events.at(-1), call).toEqual({ what: "rollback" });
      const span = onlySpan(spans);
      expect(span, call).toMatchObject({ outcome: "failed", error_code: "invalidResponse" });
      expect(JSON.stringify(span), call).not.toContain("+15555550131");
      // An error code no journey 5 call has is outside its errors too.
      const other = await run(call, validOf(call), [
        recordingLane(() => ({ error: "searchedAlready", turnId: "turn-x" })),
      ]);
      expect(other.thrown, call).toBeInstanceOf(LaneContractError);
    }
  });

  it("a handler that throws: rolled back, the error passed on, and a failed span naming only its kind", async () => {
    const { thrown, events, spans } = await run("refundAtOnce", validOf("refundAtOnce"), [
      recordingLane(() => {
        throw new TypeError("Dee W. at +15555550104 broke it");
      }),
    ]);
    expect(thrown).toBeInstanceOf(TypeError);
    expect(events.at(-1)).toEqual({ what: "rollback" });
    const span = onlySpan(spans);
    expect(span).toMatchObject({
      outcome: "failed",
      error_code: "TypeError",
      decided: { answered: "thrown" },
    });
    expect(JSON.stringify(span)).not.toContain("Dee");
  });

  it("the hop: a page's call is a pageRequest, an agent's an agentApiRequest, any other caller's the hop its lane registered", async () => {
    const cases: [string, Hop][] = [
      ["j5-money-before-page.json", "pageRequest"],
      ["j5-pay-link-agent.json", "agentApiRequest"],
      ["j5-nothing-yes-turn.json", "commit"],
      ["j5-plan-agree-turn.json", "commit"],
      ["j5-refund-second-charge-job.json", "commit"],
    ];
    for (const [file, hop] of cases) {
      const exchange = fixture(file) as LaneExchange;
      expect(onlySpan((await run(exchange.call, exchange.request)).spans).hop, file).toBe(hop);
    }
    // showMoneyBefore's own hop, frontier, is a read's: K-09 lets only a page or an agent make it, so a turn's request is
    // refused, on that hop.
    const valid = validOf("showMoneyBefore");
    const turn = { ...valid, caller: { ...callerOf(valid), kind: "turn" } };
    const refused = await run("showMoneyBefore", turn);
    expect(refused.answered).toMatchObject({ error: "invalidRequest", call: "showMoneyBefore" });
    expect(onlySpan(refused.spans).hop).toBe("frontier");
    expect(J5_LANE.calls.map(({ call, hop }) => [call, hop])).toEqual([
      ["showMoneyBefore", "frontier"],
      ["settleOffer", "commit"],
      ["signDocument", "commit"],
      ["takeMoneyBefore", "commit"],
      ["refundAtOnce", "commit"],
    ]);
  });

  it("a caller that records the lane call's own hop itself leaves no span of the base's, and nothing else changes; any other hop changes nothing", async () => {
    const turn = fixture("j5-nothing-yes-turn.json") as LaneExchange;
    const page = fixture("j5-money-before-page.json") as LaneExchange;
    const plain = await run(turn.call, turn.request);
    const opted = await run(turn.call, turn.request, [J5_LANE], { callerRecordsHop: "commit" });
    expect(opted.answered).toEqual(plain.answered);
    expect(opted.events).toEqual(plain.events);
    expect(plain.spans.map((span) => span.hop)).toEqual(["commit"]);
    expect(opted.spans).toEqual([]);
    // A page's call is a pageRequest, whatever the option names.
    const pagePlain = await run(page.call, page.request);
    const pageOpted = await run(page.call, page.request, [J5_LANE], { callerRecordsHop: "frontier" });
    expect(untimed(onlySpan(pageOpted.spans))).toEqual(untimed(onlySpan(pagePlain.spans)));
  });
});

describe("with J5_LANE registered, everything else answers exactly as before", () => {
  /** The same call on a base without lanes and on one with J5_LANE: the answer, the scope and the untimed spans. */
  async function both(call: string, request: unknown) {
    const plain = await run(call, request, []);
    const withLane = await run(call, request, [J5_LANE]);
    return { plain, withLane };
  }

  it("every accepted K-09 v1 exchange: the same answer, scope and span", async () => {
    const exchanges = acceptedExchanges();
    expect(exchanges).toHaveLength(59);
    for (const { file, exchange } of exchanges) {
      const { plain, withLane } = await both(exchange.call, exchange.request);
      expect(withLane.answered, file).toEqual(plain.answered);
      expect(withLane.thrown, file).toEqual(plain.thrown);
      expect(withLane.events, file).toEqual(plain.events);
      expect(withLane.spans.map(untimed), file).toEqual(plain.spans.map(untimed));
    }
  });

  it("a name that is no call, and every call K-09 v1.1, v1.2 and v1.4 add for other lanes, is still unknownCall", async () => {
    const others = callNamesOf("v1.4").filter((call) => !isCallName(call) && !V1_3_CALLS.includes(call));
    expect(others.length).toBeGreaterThan(0);
    const request = validOf("settleOffer");
    for (const name of [...others, "cancel every booking for Ben", "__proto__", "constructor"]) {
      const { plain, withLane } = await both(name, request);
      expect(withLane.answered, name).toEqual({ error: "unknownCall" });
      expect(plain.answered, name).toEqual({ error: "unknownCall" });
      expect(withLane.events, name).toEqual([]);
      const span = onlySpan(withLane.spans);
      expect(span.got, name).toEqual({ callerKind: "page" });
      expect(JSON.stringify(span), name).not.toContain("cancel every");
    }
  });

  it("without J5_LANE, its calls are unknownCall, as before this card", async () => {
    for (const call of V1_3_CALLS) {
      expect((await run(call, validOf(call), [])).answered, call).toEqual({ error: "unknownCall" });
    }
  });
});
