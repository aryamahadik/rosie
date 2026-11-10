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

import {
  isLabel,
  type Hop,
  type SpanFacts,
  type SpanFields,
  type TraceContext,
} from "../../../runtime/src/trace";
import type { LimitResult, RowRef } from "../../../runtime/src/trace/types";
import {
  hopOf,
  isCallName,
  isCallerKind,
  type AnswerOf,
  type CallName,
  type CallerKind,
  type RequestOf,
} from "./calls";
import {
  NotBuiltError,
  ToolApiContractError,
  type BaseRefusal,
  type InvalidRequestRefusal,
  type NoBusinessScopeRefusal,
  type NotBuiltRefusal,
} from "./errors";
import type { BusinessScope } from "./scope";
import type { ToolApiValidator } from "./validator";

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

/** What a call answers: its handler's response or error, or the base's own refusal (errors.ts). */
export type CallAnswer = AnswerOf<CallName> | BaseRefusal;

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
  /** Told when the trace refuses a call's span; the answer never changes for it. Default: one JSON line on console.warn. */
  onSpanRefused?: (report: SpanRefusedReport) => void;
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
  readonly answer: AnswerOf<CallName>;
  readonly code: string;

  constructor(answer: AnswerOf<CallName>, code: string) {
    super("the call answered one of its errors: nothing written");
    this.answer = answer;
    this.code = code;
  }
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

  return {
    async call(name, request, trace, options) {
      const call = isCallName(name) ? name : undefined;
      const rawKind = callerOf(request)?.kind;
      const callerKind: CallerKind | undefined = isCallerKind(rawKind) ? rawKind : undefined;
      const hop: Hop = hopOf(call, callerKind);
      // The caller records this hop itself (CallOptions): the call has no span of the base's, so nothing is timed or kept.
      const timing = options?.callerRecordsHop === hop ? null : trace.start(hop);
      const notes: SpanNotes = { limits: [], rows: [] };
      const got: SpanFacts = {
        ...(call === undefined ? {} : { toolCall: call }),
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
            call: call ?? "unknown",
            error: error instanceof Error ? labelOr(error.name, "error") : "unknown",
          });
        }
      };
      const refuse = <R extends BaseRefusal>(refusal: R, problems?: number): R => {
        finish({
          outcome: "refused",
          answered: refusal.error,
          errorCode: refusal.error,
          ...(problems === undefined ? {} : { problems }),
        });
        return refusal;
      };

      if (call === undefined) return refuse({ error: "unknownCall" });

      const problems = validator.check(call, "request", request);
      const caller = callerOf(request);
      if (problems.length === 0 && caller !== undefined && caller.traceId !== trace.traceId) {
        problems.push("/caller/traceId is not the trace the call runs in");
      }
      if (problems.length > 0) {
        const refusal: InvalidRequestRefusal = { error: "invalidRequest", call, problems };
        return refuse(refusal, problems.length);
      }

      const businessId = caller?.businessId;
      if (typeof businessId !== "string") {
        const refusal: NoBusinessScopeRefusal = { error: "noBusinessScope", call };
        return refuse(refusal);
      }
      if (isLabel(businessId)) spanBusinessId = businessId;

      try {
        const answer = await scope.withBusiness(businessId, async (repo) => {
          const answered = await runHandler(call, request as RequestOf<CallName>, {
            repo,
            businessId,
            span: notes,
          });
          const asResponse = validator.check(call, "response", answered);
          if (asResponse.length === 0) return answered;
          const asError = validator.check(call, "errors", answered);
          const code = errorCodeOf(answered);
          if (asError.length === 0) throw new ErrorAnswer(answered, code ?? "error");
          throw new ToolApiContractError(call, code === undefined ? asResponse : asError);
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
        if (error instanceof NotBuiltError && error.call === call) {
          const refusal: NotBuiltRefusal = { error: "notBuilt", call };
          return refuse(refusal);
        }
        if (error instanceof ToolApiContractError) {
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
