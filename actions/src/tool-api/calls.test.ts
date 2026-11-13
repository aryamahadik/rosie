// T-1150 round 4 (DL-350): each call's request, response and errors in CallTypes are K-09 v1.5's, pinned here to the
// exchange v1.5's root holds for that call, so `npm run typecheck` fails on any drift. The type generator names the first
// copy of a title plainly and numbers the later ones, so where v1.1 changed a definition (recordSafetyOutcome's and
// releaseSafetyHold's requests, recordSafetyOutcome's and recordStopOrStart's responses) the plain name is v1's copy and
// v1.5's own is numbered, a number that shifts between generations. The exchanges have no numbered duplicate, and the pins
// name none: each exchange is read off v1.5's root by its call. plannerVerbs has no exchange (it rides inside
// gateAndCommit), so its request and response are pinned where v1.5's gateAndCommit exchange holds them; its errors have no
// generated type (calls.ts PlannerVerbsErrors), and the validator holds them to the schema.
//
// At run time: v1.5's root holds one exchange for every call but plannerVerbs; the v1.1 exchanges v1's definitions left
// out of these types (j3-safety-arrival-emergency.json, j3-safety-arrival-release.json, j3-stop-tells-businesses.json)
// type as their call's and pass the validator; and a record or release on arrival, which no handler builds yet, answers
// notBuilt through the Tool API before any port is made (fail closed: nothing read or written). Values come only from the
// contracts' fixtures (rule 9).
//
// T-1174 (DL-355): composeInput alone is K-09 v1.6's, so its pin is v1.6's exchange (read off v1.6's root by its call),
// and its types are no longer v1.5's; v1.6's three composeInput exchanges type as its own and pass the validator.

import { describe, expect, it } from "vitest";

import type * as K09 from "../../../contracts/generated/tool-api/tool-api.v1.5";
import type * as K09V16 from "../../../contracts/generated/tool-api/tool-api.v1.6";
import { recordSafetyOutcomeHandler, releaseSafetyHoldHandler, type SafetyDeps } from "../domain/safety";
import {
  CALL_NAMES,
  type CallName,
  type CallTypes,
  type ErrorsOf,
  type RequestOf,
  type ResponseOf,
} from "./calls";
import { contractFile, fixture, recordingScope, traceFor, type RecordingRepo } from "./test-support";
import { createToolApi, notBuiltHandlers, type Handlers } from "./tool-api";
import { createToolApiValidator } from "./validator";

const validator = createToolApiValidator();

// ---- the pins (npm run typecheck) -----------------------------------------------------------------------------------

/** true when A and B are one type: assignable both ways is not enough, since a field only v1.1 adds may be optional. */
type Same<A, B> =
  (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false;

/** The exchange K-09 v1.5's root holds for a call; never for plannerVerbs. */
type ExchangeOf<C extends CallName> = Extract<K09.ToolApiV1Dot5, { call: C }>;

/** The calls K-09 v1.5's root holds no exchange for: plannerVerbs alone. */
type WithoutExchange = { [C in CallName]: [ExchangeOf<C>] extends [never] ? C : never }[CallName];
type ExchangeCall = Exclude<CallName, WithoutExchange>;

/**
 * Where K-09 v1.5 holds a call's three parts: its exchange's request, and its outcome split as the contract splits it
 * (each error is an object with its own "error" code; no response has one).
 */
interface ExchangeHome<C extends CallName> {
  request: ExchangeOf<C>["request"];
  response: Exclude<ExchangeOf<C>["outcome"], { error: string }>;
  errors: Extract<ExchangeOf<C>["outcome"], { error: string }>;
}

/** plannerVerbs has no exchange: v1.5's gateAndCommit exchange holds its request and response (its errors, no type). */
type DecidedInput = Extract<ExchangeHome<"gateAndCommit">["request"]["input"], { kind: "decided" }>;
type Committed = Extract<ExchangeHome<"gateAndCommit">["response"], { result: "committed" }>;
interface PlannerVerbsHome {
  request: NonNullable<DecidedInput["planner"]>;
  response: NonNullable<Committed["planner"]>;
}

/** Each part of call C whose CallTypes type is not the one its home holds, as "<call>.<part>"; never when none. */
type DriftOf<C extends CallName, Home> = {
  [Part in keyof Home & keyof CallTypes[C]]: Same<CallTypes[C][Part], Home[Part]> extends true
    ? never
    : `${C}.${Part & string}`;
}[keyof Home & keyof CallTypes[C]];

/** true when each part is its v1.5 definition; otherwise the drifted "<call>.<part>"s, which typecheck's message names. */
type Pin<Drift> = [Drift] extends [never] ? true : Drift;

/** composeInput's exchange in K-09 v1.6 (T-1174), read off v1.6's root by its call, its outcome split as above. */
type ComposeInputV16 = Extract<K09V16.ToolApiV1Dot6, { call: "composeInput" }>;
interface ComposeInputHome {
  request: ComposeInputV16["request"];
  response: Exclude<ComposeInputV16["outcome"], { error: string }>;
  errors: Extract<ComposeInputV16["outcome"], { error: string }>;
}

/**
 * One pin per call of K-09 v1, in CALL_NAMES' order: a line compiles only while its call's parts are v1.5's, and
 * composeInput's while they are v1.6's.
 */
const PINS: { readonly [C in Exclude<ExchangeCall, "composeInput">]: Pin<DriftOf<C, ExchangeHome<C>>> } & {
  readonly composeInput: Pin<DriftOf<"composeInput", ComposeInputHome>>;
  readonly plannerVerbs: Pin<DriftOf<"plannerVerbs", PlannerVerbsHome>>;
} = {
  buildFrontier: true,
  closestEntries: true,
  gateAndCommit: true,
  composeInput: true,
  finalizeMessage: true,
  recordSafetyOutcome: true,
  releaseSafetyHold: true,
  recordStopOrStart: true,
  setRecordFlag: true,
  handOff: true,
  answerHandOff: true,
  pageTeam: true,
  acknowledgePage: true,
  openReviewItem: true,
  decideReviewItem: true,
  enterDoor: true,
  sendFixedLine: true,
  sendsFailing: true,
  textingBack: true,
  calendarLinkDropped: true,
  calendarLinkBack: true,
  sendProofCode: true,
  proveCode: true,
  issueChatLink: true,
  plannerVerbs: true,
  matchKinds: true,
  lookupListing: true,
  saveSetupStep: true,
  readSetup: true,
};

/** Compiles only while plannerVerbs is the one call v1.5's root holds no exchange for. */
const ONLY_PLANNER_VERBS: Same<WithoutExchange, "plannerVerbs"> = true;

/** Compiles only while composeInput's response and errors are not v1.5's (T-1174 moved them to v1.6). */
const COMPOSE_INPUT_LEFT_V15: [
  Same<CallTypes["composeInput"]["response"], ExchangeHome<"composeInput">["response"]>,
  Same<CallTypes["composeInput"]["errors"], ExchangeHome<"composeInput">["errors"]>,
] = [false, false];

describe("each call's request, response and errors are K-09 v1.5's, composeInput's v1.6's, pinned to its exchange (npm run typecheck)", () => {
  it("every one of the 29 calls is pinned, and plannerVerbs alone has no exchange", () => {
    expect(Object.keys(PINS)).toEqual([...CALL_NAMES]);
    expect(Object.values(PINS)).toEqual(CALL_NAMES.map(() => true));
    expect(ONLY_PLANNER_VERBS).toBe(true);
    expect(COMPOSE_INPUT_LEFT_V15).toEqual([false, false]);

    // The same at run time, from the frozen schema: v1.5's root names an exchange for every call of v1 but plannerVerbs.
    const root = contractFile("tool-api/tool-api.v1.5.schema.json") as { anyOf: { $ref: string }[] };
    const exchanges = new Set(root.anyOf.map(({ $ref }) => /^#\/\$defs\/(\w+)\.exchange$/u.exec($ref)?.[1]));
    expect(CALL_NAMES.filter((call) => !exchanges.has(call))).toEqual(["plannerVerbs"]);
  });
});

// ---- the v1.1 exchanges v1's definitions left out ------------------------------------------------------------------

describe("the v1.1 exchanges K-09 v1's definitions left out of these types are typed as their call's", () => {
  it("j3-safety-arrival-emergency.json: the record on arrival is a recordSafetyOutcome request, gives and hold.version its response's", () => {
    const exchange = fixture("j3-safety-arrival-emergency.json") as K09.RecordSafetyOutcomeExchange;
    const request: RequestOf<"recordSafetyOutcome"> = exchange.request;
    if ("error" in exchange.outcome) throw new Error("the fixture's outcome is a response");
    const response: ResponseOf<"recordSafetyOutcome"> = exchange.outcome;

    expect(validator.check("recordSafetyOutcome", "request", request)).toEqual([]);
    expect(validator.check("recordSafetyOutcome", "response", response)).toEqual([]);
    expect(request.caller.kind).toBe("actorOnArrival");
    expect([response.gives, response.hold?.version]).toEqual([["safe"], 1]);
  });

  it("j3-safety-arrival-release.json: the at-once release on arrival is a releaseSafetyHold request", () => {
    const exchange = fixture("j3-safety-arrival-release.json") as K09.ReleaseSafetyHoldExchange;
    const request: RequestOf<"releaseSafetyHold"> = exchange.request;

    expect(validator.check("releaseSafetyHold", "request", request)).toEqual([]);
    expect(validator.check("releaseSafetyHold", "response", exchange.outcome)).toEqual([]);
    expect(request.caller.kind).toBe("actorOnArrival");
  });

  it("j3-stop-tells-businesses.json: businessesTold is a recordStopOrStart response's", () => {
    const exchange = fixture("j3-stop-tells-businesses.json") as K09.RecordStopOrStartExchange;
    if ("error" in exchange.outcome) throw new Error("the fixture's outcome is a response");
    const response: ResponseOf<"recordStopOrStart"> = exchange.outcome;

    expect(validator.check("recordStopOrStart", "request", exchange.request)).toEqual([]);
    expect(validator.check("recordStopOrStart", "response", response)).toEqual([]);
    expect(response.businessesTold?.map((told) => told.businessId)).toEqual(["biz-lees-barbershop"]);
  });
});

// ---- composeInput on K-09 v1.6 (T-1174) ------------------------------------------------------------------------------

describe("composeInput's v1.6 exchanges type as its own and pass the validator (T-1174)", () => {
  it("compose-input-s1-02-v1.6.json: the request is composeInput's, the input with its term facts its response's", () => {
    const exchange = fixture("compose-input-s1-02-v1.6.json") as ComposeInputV16;
    const request: RequestOf<"composeInput"> = exchange.request;
    if ("error" in exchange.outcome) throw new Error("the fixture's outcome is a response");
    const response: ResponseOf<"composeInput"> = exchange.outcome;

    expect(validator.check("composeInput", "request", request)).toEqual([]);
    expect(validator.check("composeInput", "response", response)).toEqual([]);
    if (response.result !== "compose") throw new Error("the fixture's response is a composer input");
    expect(response.input.facts.map((fact) => ("source" in fact ? "term" : "slot"))).toEqual([
      "term",
      "term",
      "term",
      "term",
    ]);
  });

  it.each(["compose-input-fixed-line-row.json", "compose-input-master-line-missing.json"])(
    "%s: its error is one of composeInput's errors",
    (file) => {
      const exchange = fixture(file) as ComposeInputV16;
      if (!("error" in exchange.outcome)) throw new Error("the fixture's outcome is an error");
      const error: ErrorsOf<"composeInput"> = exchange.outcome;
      expect(validator.check("composeInput", "errors", error)).toEqual([]);
      expect(validator.check("composeInput", "response", error)).not.toEqual([]);
    },
  );
});

// ---- a request on arrival answers notBuilt --------------------------------------------------------------------------

describe("a record or release on arrival, which no handler builds yet, answers notBuilt (fail closed)", () => {
  /** Safety ports that each throw when made: a request on arrival must answer before any is. */
  function portsNeverMade(made: string[]): SafetyDeps<RecordingRepo> {
    const never = (port: string) => (): never => {
      made.push(port);
      throw new Error(`${port} made for a request on arrival`);
    };
    return {
      reader: never("reader"),
      flagsReader: never("flagsReader"),
      messagesReader: never("messagesReader"),
      sealer: never("sealer"),
      now: never("now"),
    };
  }

  it.each([
    ["recordSafetyOutcome", "j3-safety-arrival-emergency.json"],
    ["releaseSafetyHold", "j3-safety-arrival-release.json"],
  ] as const)("%s on arrival (%s): notBuilt, nothing read or written", async (call, file) => {
    const made: string[] = [];
    const deps = portsNeverMade(made);
    const handlers: Handlers<RecordingRepo> = {
      ...notBuiltHandlers(),
      recordSafetyOutcome: recordSafetyOutcomeHandler(deps),
      releaseSafetyHold: releaseSafetyHoldHandler(deps),
    };
    const scope = recordingScope();
    const api = createToolApi({ validator, scope, handlers });
    const { request } = fixture(file) as { request: Record<string, unknown> };
    expect(validator.check(call, "request", request)).toEqual([]);

    const answer = await api.call(call, request, traceFor(request).trace);

    expect(answer).toEqual({ error: "notBuilt", call });
    expect(made).toEqual([]);
    expect(scope.events).toEqual([
      { what: "begin" },
      { what: "scope", businessId: "biz-lees-barbershop" },
      { what: "rollback" },
    ]);
  });
});
