// The Tool API base (T-290; C-074, C-038): the action layer owns every read and write (arch 02 line 139), and each read
// or write goes through one of K-09 v1's calls, made here. For one call, in this order:
//
//   1. its span opens on the caller's trace (K-08 v1.1): a page's call is a pageRequest, an outside AI's an
//      agentApiRequest, any other the call's own hop (calls.ts); unless the caller records that hop itself (CallOptions:
//      the turn face's gateAndCommit, composeInput and finalizeMessage, whose hops the handle actor's turn records:
//      T-1193), when no span of the base's opens for the call, and steps 2 to 6 run as they always do;
//   2. the name must be a call of K-09 v1 (unknownCall otherwise);
//   3. the request must pass `$defs/<call>.request` and name the trace the call runs in (invalidRequest otherwise);
//   4. the request must name a business (noBusinessScope otherwise): row-level security scopes every call by it (arch 10
//      line 546; K-04 v1 rule 4), so no call runs unscoped;
//   5. the call's handler runs inside one transaction scoped to that business (scope.ts), which is set before the handler
//      gets its repo, so nothing is read before the scope;
//   6. the handler's answer must pass `$defs/<call>.response`, or `$defs/<call>.errors`, which the contract says are
//      "Refused, nothing written", so an error answer rolls the transaction back; an answer that passes neither is the
//      handler's fault, rolled back and thrown (ToolApiContractError), never passed on;
//   7. the span, when step 1 opened one, records the outcome: the trace id and bundle id are the trace's, the handle is
//      the trace's handle id, and what the span got and decided are labels and counts only (the call, the caller's kind,
//      what was answered), so no phone number and no person's words can reach it (K-08 v1 "Never the raw number or
//      words").
//
// Steps 2 to 4 answer before anything is read or written. Each call's own logic is T-291 onward: until then every
// handler is a stub that answers notBuilt (notBuiltHandlers).
//
// The lane door (T-1022; DL-728). The calls a later K-09 minor version adds are its journey lane's: a folder of the
// lane's own (j5/ holds journey 5's, which K-09 v1.3 adds) whose index.ts gives the base, for each call, its name, its
// K-08 hop, the frozen K-09 version whose definitions validate it and its handler (Lane). The base answers a lane's call
// by the same steps 1 to 7, none skipped: step 1's own hop is the one its lane registered; step 2 finds the name among
// the registered calls; steps 3 and 6 hold the call to its version's `$defs/<call>.request`, `.response` and `.errors`,
// read by the call's own name from a version whose root carries it (validator.ts laneChecks; DL-350); steps 4, 5 and 7
// are a v1 call's. A lane's handler not built yet throws LaneNotBuiltError, answered notBuilt with its transaction rolled
// back, and an answer outside its version's definitions is rolled back and thrown (LaneContractError). Registration is
// refused (LaneRegistrationError), so no base is made, for a K-09 v1 call's name, a name a lane registered already, a hop
// K-08 does not name, and a version that is not frozen, does not carry the call by $ref from its root, or whose checks
// are not held (inside workerd, none is yet). With no lane the base is exactly as before: every name outside K-09 v1
// answers unknownCall.

import {
  HOPS,
  isLabel,
  type Hop,
  type SpanFacts,
  type SpanFields,
  type TraceContext,
} from "../../../runtime/src/trace";
import type { LimitResult, RowRef } from "../../../runtime/src/trace/types";
import {
  CALL_HOPS,
  callerHop,
  isCallName,
  isCallerKind,
  type AnswerOf,
  type CallName,
  type CallerKind,
  type RequestOf,
} from "./calls";
import { NotBuiltError, ToolApiContractError, type BaseRefusal } from "./errors";
import type { BusinessScope } from "./scope";
import type { CallPart, LaneChecks, ToolApiValidator } from "./validator";

/** The trace a call joins: the caller's own trace context (runtime/src/trace), whose id the request must name. */
export type CallTrace = Pick<TraceContext, "traceId" | "start">;

/** What a handler adds to its call's span. */
export interface SpanNotes {
  /** Each limit's result as the gate logs it (K-08 v1 limitResult). A gate span without any logs 1 to 6 as notChecked. */
  limits: LimitResult[];
  /** The rows the call wrote (K-08 v1 rowRef: a table and a row id, never a value); kept only when the call commits. */
  rows: RowRef[];
}

export interface CallContext<Repo> {
  /** The repo inside the call's transaction, scoped to `businessId`. */
  readonly repo: Repo;
  /** The business the transaction is scoped to: the request's `caller.businessId`. */
  readonly businessId: string;
  readonly span: SpanNotes;
}

/** One call's logic: its validated request in, its response or one of its errors out. */
export type Handler<C extends CallName, Repo> = (
  request: RequestOf<C>,
  context: CallContext<Repo>,
) => Promise<AnswerOf<C>>;

/** One handler for every call of K-09 v1. */
export type Handlers<Repo> = { readonly [C in CallName]: Handler<C, Repo> };

/**
 * One lane call's logic (T-1022, DL-728): its request, which the base held to its K-09 version's `$defs/<call>.request`
 * first, in; its response or one of its errors out, which the base holds to `.response` or `.errors`. Its lane types
 * both: the request comes as `unknown`, as K-09's generated types reach no lane's call by name.
 */
export type LaneHandler<Repo> = (request: unknown, context: CallContext<Repo>) => Promise<unknown>;

/** One call a journey lane registers with the base (DL-728). */
export interface LaneCall<Repo> {
  /** The call's name in K-09: never a call of v1 (CALL_NAMES), never one another lane registered. */
  readonly call: string;
  /**
   * The K-08 hop of the call's span when a turn, the console, a job, a clock's firing or the actor on return makes it; a
   * page's call is a pageRequest and an agent's an agentApiRequest, as any call's (callerHop).
   */
  readonly hop: Hop;
  /**
   * The frozen K-09 version whose `$defs/<call>.request`, `.response` and `.errors` validate the call, as "v1.8": one
   * whose root carries the call by $ref (validator.ts laneChecks).
   */
  readonly version: string;
  readonly handler: LaneHandler<Repo>;
}

/** A journey lane: its name (a label, as its folder's: j5) and the calls it registers. */
export interface Lane<Repo> {
  readonly lane: string;
  readonly calls: readonly LaneCall<Repo>[];
}

/** The base's own refusals of a lane's call: errors.ts's invalidRequest, noBusinessScope and notBuilt, naming that call. */
export type LaneRefusal =
  | { error: "invalidRequest"; call: string; problems: string[] }
  | { error: "noBusinessScope"; call: string }
  | { error: "notBuilt"; call: string };

/**
 * A lane's call's response or one of its errors: a JSON object the base held to its K-09 version's definitions. The base
 * leaves it untyped (K-09's generated types reach no lane's call by name), so its lane types it. As `object`, it never
 * passes an `in` check for a field, so a v1 answer narrows as it always has.
 */
export type LaneResponse = object;

/** What a lane's call answers: its handler's response or one of its errors, or the base's own refusal of it. */
export type LaneAnswer = LaneRefusal | LaneResponse;

/** What a call answers: its handler's response or error, or the base's own refusal (errors.ts); a lane's call, LaneAnswer. */
export type CallAnswer = AnswerOf<CallName> | BaseRefusal | LaneAnswer;

/** How one call runs (T-1193; DL-376). Left out or empty, the base records the call's span, as it always has. */
export interface CallOptions {
  /**
   * The hop the caller records itself (K-08 v1.1: the hop check fails a hop recorded twice). The handle actor's turn
   * records the gate (one span per part, with its limits) and the commit around gateAndCommit, and one fillAndChecks span
   * per row, the hop composeInput and finalizeMessage take (runtime/src/turn), so the turn face names those hops for
   * them. When it is the hop this call's span takes (hopOf), the base records no span for the call. Nothing else changes:
   * the checks, the scope, the handler (whose span notes then go nowhere), the answer and every error are as without it.
   * Any other hop changes nothing at all: a page's call keeps its pageRequest span, an agent's its agentApiRequest.
   */
  readonly callerRecordsHop?: Hop;
}

export interface ToolApi {
  /**
   * Runs one call; `call` and `request` come as given (a page's or an agent's text included) and are checked first.
   * `options` changes only whether the base records the call's span (CallOptions).
   */
  call(call: string, request: unknown, trace: CallTrace, options?: CallOptions): Promise<CallAnswer>;
}

/** What the span of a refused span reports, labels only. */
export interface SpanRefusedReport {
  traceId: string;
  call: string;
  error: string;
}

export interface ToolApiOptions<Repo> {
  validator: ToolApiValidator;
  scope: BusinessScope<Repo>;
  handlers: Handlers<Repo>;
  /**
   * The journey lanes whose calls the base also answers, each by steps 1 to 7 (T-1022, DL-728), registered when the base
   * is made: a refused one throws LaneRegistrationError. Default: none, so every name outside K-09 v1 is unknownCall.
   */
  lanes?: readonly Lane<Repo>[];
  /** Told when the trace refuses a call's span; the answer never changes for it. Default: one JSON line on console.warn. */
  onSpanRefused?: (report: SpanRefusedReport) => void;
}

/** Why a lane's call is refused at registration (LaneRegistrationError). */
export type LaneRefused = "lane" | "v1Call" | "registered" | "hop" | "version";

/**
 * A lane's call refused at registration (T-1022, DL-728): createToolApi throws it, so no base is made with that lane. It
 * names the lane, the call and why (`why`), with what the check found.
 */
export class LaneRegistrationError extends Error {
  override name = "LaneRegistrationError";
  readonly lane: string;
  readonly call: string;
  readonly why: LaneRefused;

  constructor(lane: string, call: string, why: LaneRefused, found: string) {
    super(`lane ${lane} cannot register ${call} (${why}): ${found}`);
    this.lane = lane;
    this.call = call;
    this.why = why;
  }
}

/**
 * What a lane's handler not built yet throws (T-1022, DL-728), as NotBuiltError is a v1 call's: the base answers notBuilt
 * with the call's transaction rolled back, so nothing is written.
 */
export class LaneNotBuiltError extends Error {
  override name = "LaneNotBuiltError";
  readonly call: string;

  constructor(call: string) {
    super(`${call} has no handler yet (its journey lane's task)`);
    this.call = call;
  }
}

/**
 * A lane's handler answered something its K-09 version's response and errors both refuse, as ToolApiContractError is a v1
 * call's: never passed on, but rolled back and thrown. The problem lines name paths, never values.
 */
export class LaneContractError extends Error {
  override name = "LaneContractError";
  readonly call: string;
  readonly version: string;
  readonly problems: readonly string[];

  constructor(call: string, version: string, problems: readonly string[]) {
    super(`${call}'s handler answered outside K-09 ${version} (${String(problems.length)} problems)`);
    this.call = call;
    this.version = version;
    this.problems = problems;
  }
}

/** Limits 1 to 6, not checked: what a gate span logs when its call never reached the gate (K-08 v1: the gate lists its limits). */
const LIMITS_NOT_CHECKED: readonly LimitResult[] = [1, 2, 3, 4, 5, 6].map((limit) => ({
  limit,
  result: "notChecked",
  outcome: null,
}));

/** Errors that say the database could not run the call, rather than that the call was refused (K-05 v1; arch 11 line 566). */
const FAILED_ERRORS: ReadonlySet<string> = new Set(["transient", "bookingPaused"]);

/** Thrown inside the scoped transaction to roll it back for an answer that is one of the call's errors. */
class ErrorAnswer extends Error {
  override name = "ErrorAnswer";
  readonly answer: CallAnswer;
  readonly code: string;

  constructor(answer: CallAnswer, code: string) {
    super("the call answered one of its errors: nothing written");
    this.answer = answer;
    this.code = code;
  }
}

/**
 * One call the base answers, a K-09 v1 call or a lane's: its name, the hop its span takes when no page or agent makes it,
 * its checks, its handler, and the errors that say its handler is not built or answered outside its definitions.
 */
interface Entry<Repo> {
  readonly call: string;
  readonly hop: Hop;
  /** K-09 v1.5's definitions (v1.6's for composeInput) for a v1 call, its version's for a lane's (validator.ts). */
  check(part: CallPart, value: unknown): string[];
  run(request: unknown, context: CallContext<Repo>): Promise<unknown>;
  /** NotBuiltError naming a v1 call; LaneNotBuiltError naming a lane's. */
  isNotBuilt(error: unknown): boolean;
  /** ToolApiContractError for a v1 call; LaneContractError for a lane's. */
  outsideContract(problems: readonly string[]): ToolApiContractError | LaneContractError;
}

/** A lane's call as registered: its lane, what the lane gave, and the checks of its version's definitions. */
interface RegisteredLaneCall<Repo> {
  readonly lane: string;
  readonly laneCall: LaneCall<Repo>;
  readonly checks: LaneChecks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The caller of a request, when it has one that is an object. */
function callerOf(request: unknown): Record<string, unknown> | undefined {
  return isRecord(request) && isRecord(request.caller) ? request.caller : undefined;
}

/** The error code of an answer that is one of a call's errors: an object with its own "error" (02-contracts 2 item 2). */
function errorCodeOf(answer: unknown): string | undefined {
  return isRecord(answer) && typeof answer.error === "string" ? answer.error : undefined;
}

/** A label for the span: the value itself when it is one, else the fallback (a thrown error's name may be anything). */
function labelOr(value: string, fallback: string): string {
  return isLabel(value) ? value : fallback;
}

function reportToConsole(report: SpanRefusedReport): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "tool_api_span_refused",
      trace_id: report.traceId,
      call: report.call,
      error: report.error,
    }),
  );
}

/**
 * Registers each lane's calls by name (T-1022, DL-728), each once, with the checks of its version's definitions. A call
 * refused throws LaneRegistrationError, so no base is made with its lane.
 */
function registerLanes<Repo>(
  lanes: readonly Lane<Repo>[],
  validator: ToolApiValidator,
): ReadonlyMap<string, RegisteredLaneCall<Repo>> {
  const registered = new Map<string, RegisteredLaneCall<Repo>>();
  for (const { lane, calls } of lanes) {
    for (const laneCall of calls) {
      const { call, hop, version } = laneCall;
      const refused = (why: LaneRefused, found: string): LaneRegistrationError =>
        new LaneRegistrationError(lane, call, why, found);
      if (!isLabel(lane)) throw refused("lane", "a lane is named by a label, as j5");
      if (isCallName(call))
        throw refused("v1Call", "a call of K-09 v1, which the base's own handlers answer");
      const first = registered.get(call);
      if (first !== undefined) throw refused("registered", `lane ${first.lane} registered it already`);
      if (!(HOPS as readonly string[]).includes(hop)) throw refused("hop", "not a hop K-08 names");
      let checks: LaneChecks;
      try {
        checks = validator.laneChecks(version, call);
      } catch (error) {
        throw refused("version", error instanceof Error ? error.message : "its checks are not held");
      }
      registered.set(call, { lane, laneCall, checks });
    }
  }
  return registered;
}

/**
 * Stubs for every call: each answers notBuilt until its task (T-291 onward) gives it its logic. They never touch the repo,
 * so they serve a scope over any repo.
 */
export function notBuiltHandlers(): Handlers<unknown> {
  const stub =
    <C extends CallName>(call: C): Handler<C, unknown> =>
    () =>
      Promise.reject(new NotBuiltError(call));
  return {
    buildFrontier: stub("buildFrontier"),
    closestEntries: stub("closestEntries"),
    gateAndCommit: stub("gateAndCommit"),
    composeInput: stub("composeInput"),
    finalizeMessage: stub("finalizeMessage"),
    recordSafetyOutcome: stub("recordSafetyOutcome"),
    releaseSafetyHold: stub("releaseSafetyHold"),
    recordStopOrStart: stub("recordStopOrStart"),
    setRecordFlag: stub("setRecordFlag"),
    handOff: stub("handOff"),
    answerHandOff: stub("answerHandOff"),
    pageTeam: stub("pageTeam"),
    acknowledgePage: stub("acknowledgePage"),
    openReviewItem: stub("openReviewItem"),
    decideReviewItem: stub("decideReviewItem"),
    enterDoor: stub("enterDoor"),
    sendFixedLine: stub("sendFixedLine"),
    sendsFailing: stub("sendsFailing"),
    textingBack: stub("textingBack"),
    calendarLinkDropped: stub("calendarLinkDropped"),
    calendarLinkBack: stub("calendarLinkBack"),
    sendProofCode: stub("sendProofCode"),
    proveCode: stub("proveCode"),
    issueChatLink: stub("issueChatLink"),
    plannerVerbs: stub("plannerVerbs"),
    matchKinds: stub("matchKinds"),
    lookupListing: stub("lookupListing"),
    saveSetupStep: stub("saveSetupStep"),
    readSetup: stub("readSetup"),
  };
}

/** How one call ended, for its span. */
interface Ending {
  outcome: "ok" | "refused" | "failed";
  /** What was answered: "response", an error code, or "thrown". */
  answered: string;
  errorCode: string | null;
  problems?: number;
}

export function createToolApi<Repo>(options: ToolApiOptions<Repo>): ToolApi {
  const { validator, scope, handlers } = options;
  const onSpanRefused = options.onSpanRefused ?? reportToConsole;

  // Generic in the call, so the handler and its request are the same call's.
  const runHandler = <C extends CallName>(
    call: C,
    request: RequestOf<C>,
    context: CallContext<Repo>,
  ): Promise<AnswerOf<C>> => {
    const handler: Handler<C, Repo> = handlers[call];
    return handler(request, context);
  };

  /** A K-09 v1 call: its CALL_HOPS hop, the validator's v1 checks, its handler in `handlers`. */
  const v1Entry = (call: CallName): Entry<Repo> => ({
    call,
    hop: CALL_HOPS[call],
    check: (part, value) => validator.check(call, part, value),
    run: (request, context) => runHandler(call, request as RequestOf<CallName>, context),
    isNotBuilt: (error) => error instanceof NotBuiltError && error.call === call,
    outsideContract: (problems) => new ToolApiContractError(call, problems),
  });

  /** Every lane's call, registered when the base is made (DL-728). */
  const laneEntries = new Map<string, Entry<Repo>>();
  for (const [call, { laneCall, checks }] of registerLanes(options.lanes ?? [], validator)) {
    laneEntries.set(call, {
      call,
      hop: laneCall.hop,
      check: (part, value) => checks.check(part, value),
      run: (request, context) => laneCall.handler(request, context),
      isNotBuilt: (error) => error instanceof LaneNotBuiltError && error.call === call,
      outsideContract: (problems) => new LaneContractError(call, checks.version, problems),
    });
  }

  /** The call a name names: a call of K-09 v1, else a lane's registered call, else none (unknownCall). */
  const entryOf = (name: unknown): Entry<Repo> | undefined => {
    if (isCallName(name)) return v1Entry(name);
    return typeof name === "string" ? laneEntries.get(name) : undefined;
  };

  return {
    async call(name, request, trace, options) {
      const entry = entryOf(name);
      const rawKind = callerOf(request)?.kind;
      const callerKind: CallerKind | undefined = isCallerKind(rawKind) ? rawKind : undefined;
      // A name that is no call takes the commit hop, refused, as hopOf gives it.
      const hop: Hop = callerHop(entry?.hop ?? "commit", callerKind);
      // The caller records this hop itself (CallOptions): the call has no span of the base's, so nothing is timed or kept.
      const timing = options?.callerRecordsHop === hop ? null : trace.start(hop);
      const notes: SpanNotes = { limits: [], rows: [] };
      const got: SpanFacts = {
        ...(entry === undefined ? {} : { toolCall: entry.call }),
        ...(callerKind === undefined ? {} : { callerKind }),
      };
      let spanBusinessId: string | undefined;

      const finish = (ending: Ending): void => {
        if (timing === null) return;
        const decided: SpanFacts = {
          answered: ending.answered,
          ...(ending.problems === undefined ? {} : { problems: ending.problems }),
        };
        const gateLimits = hop === "gate" ? LIMITS_NOT_CHECKED : undefined;
        const limits = notes.limits.length > 0 ? notes.limits : gateLimits;
        const base: Omit<SpanFields, "hop" | "ms" | "at"> = {
          outcome: ending.outcome,
          got,
          decided,
          errorCode: ending.errorCode,
          ...(spanBusinessId === undefined ? {} : { businessId: spanBusinessId }),
        };
        const rows = ending.outcome === "ok" && notes.rows.length > 0 ? notes.rows : undefined;
        try {
          timing.finish({
            ...base,
            ...(limits === undefined ? {} : { limits: [...limits] }),
            ...(rows === undefined ? {} : { rows }),
          });
          return;
        } catch {
          // A handler's note broke K-08 (a row id that is not a label, say): the span goes without the notes.
        }
        try {
          timing.finish({
            ...base,
            decided: { ...decided, notesRefused: true },
            ...(gateLimits === undefined ? {} : { limits: [...gateLimits] }),
          });
        } catch (error) {
          onSpanRefused({
            traceId: trace.traceId,
            call: entry?.call ?? "unknown",
            error: error instanceof Error ? labelOr(error.name, "error") : "unknown",
          });
        }
      };
      const refuse = <R extends BaseRefusal | LaneRefusal>(refusal: R, problems?: number): R => {
        finish({
          outcome: "refused",
          answered: refusal.error,
          errorCode: refusal.error,
          ...(problems === undefined ? {} : { problems }),
        });
        return refusal;
      };

      if (entry === undefined) return refuse({ error: "unknownCall" });
      // The base's refusals below are errors.ts's, each naming the call: a K-09 v1 call's name, or a lane's (LaneRefusal).
      const { call } = entry;

      const problems = entry.check("request", request);
      const caller = callerOf(request);
      if (problems.length === 0 && caller !== undefined && caller.traceId !== trace.traceId) {
        problems.push("/caller/traceId is not the trace the call runs in");
      }
      if (problems.length > 0) {
        const refusal: LaneRefusal = { error: "invalidRequest", call, problems };
        return refuse(refusal, problems.length);
      }

      const businessId = caller?.businessId;
      if (typeof businessId !== "string") {
        const refusal: LaneRefusal = { error: "noBusinessScope", call };
        return refuse(refusal);
      }
      if (isLabel(businessId)) spanBusinessId = businessId;

      try {
        const answer = await scope.withBusiness(businessId, async (repo) => {
          const answered = await entry.run(request, { repo, businessId, span: notes });
          const asResponse = entry.check("response", answered);
          // Held to the call's response or errors, an answer is one of the call's own (CallAnswer).
          if (asResponse.length === 0) return answered as CallAnswer;
          const asError = entry.check("errors", answered);
          const code = errorCodeOf(answered);
          if (asError.length === 0) throw new ErrorAnswer(answered as CallAnswer, code ?? "error");
          throw entry.outsideContract(code === undefined ? asResponse : asError);
        });
        finish({ outcome: "ok", answered: "response", errorCode: null });
        return answer;
      } catch (error) {
        if (error instanceof ErrorAnswer) {
          const code = labelOr(error.code, "error");
          finish({
            outcome: FAILED_ERRORS.has(error.code) ? "failed" : "refused",
            answered: code,
            errorCode: code,
          });
          return error.answer;
        }
        if (entry.isNotBuilt(error)) {
          const refusal: LaneRefusal = { error: "notBuilt", call };
          return refuse(refusal);
        }
        if (error instanceof ToolApiContractError || error instanceof LaneContractError) {
          finish({
            outcome: "failed",
            answered: "invalidResponse",
            errorCode: "invalidResponse",
            problems: error.problems.length,
          });
          throw error;
        }
        finish({
          outcome: "failed",
          answered: "thrown",
          errorCode: error instanceof Error ? labelOr(error.name, "thrown") : "thrown",
        });
        throw error;
      }
    },
  };
}
