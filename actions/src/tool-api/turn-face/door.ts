// The keyword door (T-1413; the CQ-335 ruling's NEW-1, DL-864; the architect's ruling 2, DL-877): the guard's keyword
// turn that covers every business, a core-only gateAndCommit whose caller names no business, committed on the runtime
// side. A bare STOP, START or HELP commits core-only under the guard's replies' caller, which names no business (RULES
// 7.2: one number stops every business; runtime/src/guard/replies/replies.ts lines 391 to 398; K-09 v1
// caller.businessId: "Null only ... for a call that covers every business (a STOP)"; stop-recorded.json). The Tool API base
// never runs such a call (noBusinessScope, unchanged: actions/README.md default 2), and rosie_app could not run it (no
// grant on phones; a consent row with no business is seen by no business scope: K-29 v1 rule 4). The door runs it where
// K-04 v1 rule 4 runs the actor's guard, unscoped on the runtime side, on runtimeStopCall's pattern
// (domain/flags/handlers.ts lines 267 to 299). For one call, in this order:
//
//   1. its span opens on the caller's trace: the gate hop's (actions/README.md default 3), unless the caller records that
//      hop itself (CallOptions: the turn face's TURN_RECORDS_GATE), when the door records no span (default 5);
//   2. the request is held to K-09's gateAndCommit.request and must name the trace the call runs in, as the base holds
//      it, else invalidRequest (paths, never values);
//   3. the request must be the door's one shape (Gives b; DL-877 C3): caller.kind turn with businessId null and its turn
//      row, input coreOnly (so no decided part and no planner), and core actions only recordSafetyOutcome,
//      recordStopOrStart and sendFixedLine, each under that same caller (default 2). Any other shape is answered
//      noBusinessScope (default 1).
//      Steps 2 and 3 answer before a transaction opens, so nothing is read for a refused call;
//   4. the turn face's commit (gateAndCommit, with keywordCommitDeps: commit.ts) runs inside one transaction of the
//      runtime side (DoorRuntime; on PostgreSQL pg/calls.ts pgDoorRuntime: rosie_job, rosie.business_id set empty,
//      rosie.person_id unset, assertRuntimeSide and the role checked before the first read), with no business
//      (default 3): the safety reads in their no-business forms, the owner and the zone notBuilt, runCore's flags port
//      over that one transaction (DL-877 C1, C2), and commitTurn in its own transaction, as today;
//   5. the answer is held to K-09's gateAndCommit.response or .errors; an error answer rolls the door's transaction back,
//      and an answer that passes neither is thrown (ToolApiContractError), never passed on. A commit not built yet
//      (notBuilt: a core action with no service, sendFixedLine until T-1414, a danger outcome: commit.ts default 5)
//      answers the base's notBuilt;
//   6. the span records the outcome: labels and counts only, and no business label (Gives e).
//
// Nothing here logs but a span the trace refuses twice (one JSON line naming the call and the trace, as the base's);
// what the door answers or throws carries ids, flags and labels, never a number, an address or anyone's words (DL-877
// C4): a row id the commit throws that is no K-08 label (K-05 v1 names a phones row by its number until v1.17: DL-875,
// DL-876) is dropped from the error before it leaves (default 6).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The door's refusals are the base's (actions/README.md default 1): invalidRequest for a request K-09 refuses or a
//      trace that is not the caller's, and noBusinessScope for every request K-09 takes that is not the door's one shape:
//      the base's answer for a call it will not run without a business. A request whose caller names a business is the
//      base's to run, and the door refuses it the same way: it never runs a business's call, scoped or not.
//   2. "Each under that same caller" (Gives b): every core action's caller is the request's caller field for field (kind
//      turn, turn id, request id, no business, person, trace), as the guard's replies and the turn's records make it
//      (runtime/src/guard/replies/replies.ts replyToKeywords; runtime/src/turn/turn.ts keywordCaller and safetyRecords).
//   3. The commit runs with no business. CallContext and CommitTurnContext name the business as a string, since the base
//      never runs a call without one; the door hands the commit K-09's null there, through `unknown`, once (NO_BUSINESS),
//      and everything after it reads that null as K-09 and K-05 do, the runtime side: the safety record's rows and
//      entries name no business (domain/safety/record.ts RecordCall.businessId), runCore lets an action caller with none
//      through (commit/core/core.ts default 6), the commit's entries fall back to none (commit/build.ts), and openHolds
//      and the safety reads are bound to null by name (commit.ts keywordCommitDeps). Widening the two types to
//      `string | null` is a card of its own, outside this card's May touch.
//   4. A start of the door's transaction that the database could not make (a connection that never opened or was lost)
//      answers K-09's transient, nothing read or written, as the base's does since T-1410; the runtime side throws every
//      other failure scrubbed (pg/calls.ts).
//   5. The span is the base's gate span for gateAndCommit, labels only, with no business label; a caller that records
//      the gate hop itself gets none from the door, as the turn face's gateAndCommit gets none from the base (T-1193). A
//      span whose rows the trace refuses (a phones row named by its number, until K-05 v1.17's cards) is kept without its
//      notes (decided.notesRefused), as the base keeps it: it loses its rows and leaks nothing (DL-877 note 10).
//   6. A CommitRefusedError the commit throws (a second version conflict, stillChanged, names the rows that changed)
//      leaves the door with its fault and only the row ids that are K-08 labels, so a phones row named by its number
//      never reaches a thrown message.

import { isLabel, type Hop, type SpanFacts, type SpanFields } from "../../../../runtime/src/trace";
import type { LimitResult } from "../../../../runtime/src/trace/types";
import type { TransientError } from "../../../../db/repo/targets";
import { CommitRefusedError, gateAndCommit, type CommitDeps, type GateAndCommitRequest } from "../../commit";
import { callerHop, isCallerKind, type AnswerOf, type CallerKind } from "../calls";
import {
  NotBuiltError,
  ToolApiContractError,
  type InvalidRequestRefusal,
  type NoBusinessScopeRefusal,
  type NotBuiltRefusal,
} from "../errors";
import type { ScopeCall } from "../scope";
import type { CallContext, CallOptions, CallTrace, SpanNotes, SpanRefusedReport } from "../tool-api";
import { createToolApiValidator, type ToolApiValidator } from "../validator";
import type { CommitAt } from "./commit";

/** The one call the door answers. */
const CALL = "gateAndCommit";

/** What the door answers: K-09's gateAndCommit response or one of its errors, or one of the base's own refusals. */
export type KeywordDoorAnswer =
  AnswerOf<"gateAndCommit"> | InvalidRequestRefusal | NoBusinessScopeRefusal | NotBuiltRefusal;

/** The core actions a keyword turn carries (Gives b): each text's record, its STOP or START, its HELP's fixed line. */
export const KEYWORD_CORE_CALLS = ["recordSafetyOutcome", "recordStopOrStart", "sendFixedLine"] as const;

/**
 * The runtime side's one transaction for a call of the door (pg/calls.ts pgDoorRuntime on PostgreSQL): rosie_job, no
 * business scope, no person, checked before `work` gets its repo, committed when `work` resolves and rolled back when it
 * throws. `call` names the call it is opened for and, where the call's errors have K-05's transient, its answer to a start
 * the database could not make (the base's ScopeCall: T-1368, T-1410); `work` then never runs.
 */
export interface DoorRuntime<Repo> {
  withRuntime<T>(work: (repo: Repo) => Promise<T>, call: ScopeCall<T>): Promise<T>;
}

export interface KeywordDoorOptions<Repo> {
  /** The runtime side's transaction the commit runs in (pg/calls.ts pgDoorRuntime). */
  readonly runtime: DoorRuntime<Repo>;
  /** The commit's deps for one call, given the runtime's commit-time context (commit.ts keywordCommitDeps). */
  readonly commit: (at: CommitAt) => CommitDeps<Repo>;
  /** K-09's checks. Default: the validator over the frozen schemas read from contracts/ (the Worker passes its own). */
  readonly validator?: ToolApiValidator;
  /** Told when the trace refuses the call's span twice. Default: one JSON line on console.warn, as the base's. */
  readonly onSpanRefused?: (report: SpanRefusedReport) => void;
}

export interface KeywordDoor {
  /**
   * K-09 gateAndCommit for a keyword turn that names no business (the top of this file): `at` is the lease's
   * CommitContext, handed on unchanged, as the turn face's gateAndCommit takes it; `options` says whether the caller
   * records the gate hop itself (CallOptions), and changes nothing else.
   */
  gateAndCommit(
    request: unknown,
    at: CommitAt,
    trace: CallTrace,
    options?: CallOptions,
  ): Promise<KeywordDoorAnswer>;
}

/**
 * The business the door's commit runs under: none (default 3). K-09 v1's caller.businessId is null for a call that
 * covers every business; CallContext types it as a string, which the base always has.
 */
const NO_BUSINESS = null as unknown as string;

/** Limits 1 to 6, not checked: what a gate span logs when its call never reached the gate (the base's). */
const LIMITS_NOT_CHECKED: readonly LimitResult[] = [1, 2, 3, 4, 5, 6].map((limit) => ({
  limit,
  result: "notChecked",
  outcome: null,
}));

/** Errors that say the database could not run the call, rather than that the call was refused (the base's). */
const FAILED_ERRORS: ReadonlySet<string> = new Set(["transient", "bookingPaused"]);

/** K-05 v1's transient as a call's error, which the door holds gateAndCommit's errors to once (the base's). */
const TRANSIENT_ERROR = { error: "transient", sqlstate: "08006" } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields of K-09 v1's caller, in its order. */
const CALLER_FIELDS = ["kind", "turnId", "requestId", "businessId", "personId", "traceId"] as const;

/** Whether two callers are one caller, field for field (default 2). */
function sameCaller(a: unknown, b: Record<string, unknown>): boolean {
  return isRecord(a) && CALLER_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Whether a request K-09 has taken is the door's one shape (Gives b; default 2): a turn's own call naming no business,
 * with its turn row, core-only, carrying only the keyword turn's core actions, each under that same caller.
 */
export function isKeywordTurn(request: GateAndCommitRequest): boolean {
  const caller: Record<string, unknown> = { ...request.caller };
  if (request.caller.kind !== "turn" || request.caller.businessId !== null) return false;
  if (request.turn === null || request.input.kind !== "coreOnly") return false;
  return request.core.every(
    (action) =>
      (KEYWORD_CORE_CALLS as readonly string[]).includes(action.call) &&
      sameCaller((action.request as { caller?: unknown }).caller, caller),
  );
}

/** A label for the span: the value itself when it is one, else the fallback (a thrown error's name may be anything). */
function labelOr(value: string, fallback: string): string {
  return isLabel(value) ? value : fallback;
}

/** The error code of an answer that is one of the call's errors. */
function errorCodeOf(answer: unknown): string | undefined {
  return isRecord(answer) && typeof answer.error === "string" ? answer.error : undefined;
}

/** What leaves the door when the commit throws: a CommitRefusedError with only its label ids (default 6). */
function labelsOnly(error: unknown): unknown {
  if (!(error instanceof CommitRefusedError) || error.ids.every((id) => isLabel(id))) return error;
  return new CommitRefusedError(
    error.fault,
    error.ids.filter((id) => isLabel(id)),
  );
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

/** Thrown inside the door's transaction to roll it back for an answer that is one of the call's errors. */
class ErrorAnswer extends Error {
  override name = "ErrorAnswer";
  readonly answer: KeywordDoorAnswer;
  readonly code: string;

  constructor(answer: KeywordDoorAnswer, code: string) {
    super("the call answered one of its errors: nothing written");
    this.answer = answer;
    this.code = code;
  }
}

/** How one call ended, for its span. */
interface Ending {
  outcome: "ok" | "refused" | "failed";
  /** What was answered: "response", an error code, or "thrown". */
  answered: string;
  errorCode: string | null;
  problems?: number;
}

/** The keyword door (see the top of this file). */
export function createKeywordDoor<Repo>(options: KeywordDoorOptions<Repo>): KeywordDoor {
  const validator = options.validator ?? createToolApiValidator();
  const onSpanRefused = options.onSpanRefused ?? reportToConsole;
  const { runtime, commit } = options;
  let answersTransient: boolean | undefined;

  /** Whether gateAndCommit's errors take K-05's transient (found once), and so its start's answer to one. */
  const startOf = (start: { transient: boolean }): ScopeCall<KeywordDoorAnswer> => {
    answersTransient ??= validator.check(CALL, "errors", TRANSIENT_ERROR).length === 0;
    if (!answersTransient) return { call: CALL };
    return {
      call: CALL,
      transient: (answer: TransientError) => {
        const problems = validator.check(CALL, "errors", answer);
        if (problems.length > 0) throw new ToolApiContractError(CALL, problems);
        start.transient = true;
        return answer;
      },
    };
  };

  return {
    async gateAndCommit(request, at, trace, callOptions) {
      const rawKind = isRecord(request) && isRecord(request.caller) ? request.caller.kind : undefined;
      const callerKind: CallerKind | undefined = isCallerKind(rawKind) ? rawKind : undefined;
      const hop: Hop = callerHop("gate", callerKind);
      // The caller records this hop itself (CallOptions): the call has no span of the door's.
      const timing = callOptions?.callerRecordsHop === hop ? null : trace.start(hop);
      const notes: SpanNotes = { limits: [], rows: [] };
      const got: SpanFacts = { toolCall: CALL, ...(callerKind === undefined ? {} : { callerKind }) };

      const finish = (ending: Ending): void => {
        if (timing === null) return;
        const decided: SpanFacts = {
          answered: ending.answered,
          ...(ending.problems === undefined ? {} : { problems: ending.problems }),
        };
        const gateLimits = hop === "gate" ? LIMITS_NOT_CHECKED : undefined;
        const limits = notes.limits.length > 0 ? notes.limits : gateLimits;
        // No business label: the door's call names none (Gives e).
        const base: Omit<SpanFields, "hop" | "ms" | "at"> = {
          outcome: ending.outcome,
          got,
          decided,
          errorCode: ending.errorCode,
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
          // A note broke K-08 (a row id that is not a label: default 5): the span goes without the notes.
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
            call: CALL,
            error: error instanceof Error ? labelOr(error.name, "error") : "unknown",
          });
        }
      };
      const refuse = <R extends InvalidRequestRefusal | NoBusinessScopeRefusal | NotBuiltRefusal>(
        refusal: R,
        problems?: number,
      ): R => {
        finish({
          outcome: "refused",
          answered: refusal.error,
          errorCode: refusal.error,
          ...(problems === undefined ? {} : { problems }),
        });
        return refusal;
      };

      // Steps 2 and 3: before a transaction opens, so nothing is read for a refused call.
      const problems = validator.check(CALL, "request", request);
      const traceId = isRecord(request) && isRecord(request.caller) ? request.caller.traceId : undefined;
      if (problems.length === 0 && traceId !== trace.traceId) {
        problems.push("/caller/traceId is not the trace the call runs in");
      }
      if (problems.length > 0)
        return refuse({ error: "invalidRequest", call: CALL, problems }, problems.length);
      const asked = request as GateAndCommitRequest;
      if (!isKeywordTurn(asked)) return refuse({ error: "noBusinessScope", call: CALL });

      // Steps 4 and 5: the commit in the runtime side's one transaction, its answer held to K-09 there.
      const work = async (repo: Repo): Promise<KeywordDoorAnswer> => {
        const context: CallContext<Repo> = { repo, businessId: NO_BUSINESS, span: notes };
        const answer: unknown = await gateAndCommit(asked, context, commit(at));
        const asResponse = validator.check(CALL, "response", answer);
        if (asResponse.length === 0) return answer as KeywordDoorAnswer;
        const asError = validator.check(CALL, "errors", answer);
        const code = errorCodeOf(answer);
        if (asError.length === 0) throw new ErrorAnswer(answer as KeywordDoorAnswer, code ?? "error");
        throw new ToolApiContractError(CALL, code === undefined ? asResponse : asError);
      };
      try {
        const start = { transient: false };
        const answer = await runtime.withRuntime(work, startOf(start));
        if (start.transient) {
          finish({ outcome: "failed", answered: "transient", errorCode: "transient" });
          return answer;
        }
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
        if (error instanceof NotBuiltError && error.call === CALL) {
          return refuse({ error: "notBuilt", call: CALL });
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
        throw labelsOnly(error);
      }
    },
  };
}
