// The calls the Tool API registers (T-290, T-1150; C-074): every call K-09 v1 holds (contracts/tool-api, v1's
// `$defs/callName`; the calls v1.1 to v1.4 add are their journey lanes'), the types K-09 v1.5's generated module gives
// each call's request, response and errors under the same names (`npm run contracts:types`; ADR-005: generated into
// contracts/generated/, never committed), and the K-08 hop each call's span takes. v1.5 holds every v1 definition under
// its own name and accepts every v1 exchange (README "v1.5"; DL-340), so gateAndCommit's turn may carry the service and
// the chat id of the turn's last text (default 135) and buildFrontier's context may offer the sign-up door (K-02 v1.1).
//
// The types are imported as types only, so nothing here loads the generated module at run time; the validator
// (validator.ts) holds every value to the frozen schema itself, by the same v1.5 definitions.

import type * as K09 from "../../../contracts/generated/tool-api/tool-api.v1.5";
import type { Hop } from "../../../runtime/src/trace";

/** Every call K-09 v1 holds, in the order of v1's `$defs/callName` (a test holds this list to the schema's enum). */
export const CALL_NAMES = [
  "buildFrontier",
  "closestEntries",
  "gateAndCommit",
  "composeInput",
  "finalizeMessage",
  "recordSafetyOutcome",
  "releaseSafetyHold",
  "recordStopOrStart",
  "setRecordFlag",
  "handOff",
  "answerHandOff",
  "pageTeam",
  "acknowledgePage",
  "openReviewItem",
  "decideReviewItem",
  "enterDoor",
  "sendFixedLine",
  "sendsFailing",
  "textingBack",
  "calendarLinkDropped",
  "calendarLinkBack",
  "sendProofCode",
  "proveCode",
  "issueChatLink",
  "plannerVerbs",
  "matchKinds",
  "lookupListing",
  "saveSetupStep",
  "readSetup",
] as const;

export type CallName = (typeof CALL_NAMES)[number];

/**
 * K-09 v1.5 `$defs/caller` (v1's, by reference): who calls, under which business, for whom, and the trace the call
 * joins.
 */
export type Caller = K09.Caller;
export type CallerKind = Caller["kind"];

/** The caller kinds of `$defs/caller.kind`, in its order. */
export const CALLER_KINDS: readonly CallerKind[] = [
  "turn",
  "page",
  "agent",
  "console",
  "job",
  "clockFiring",
  "actorOnReturn",
];

/**
 * plannerVerbs' errors (K-09 v1.5 `$defs/plannerVerbs.errors`, v1's by reference). The generator writes no type for them,
 * in v1 or v1.5: plannerVerbs has no exchange, since it rides inside gateAndCommit, so the root never reaches its errors.
 * The validator still holds them to the schema.
 */
export interface PlannerVerbsErrors {
  error: "plannerRefused";
  why: "factNotInContext" | "moreThanOneQuestion";
}

interface Shapes<Request, Response, Errors> {
  request: Request;
  response: Response;
  errors: Errors;
}

/** Each call's request, response and errors, as K-09 v1.5's generated module names them. */
export interface CallTypes {
  buildFrontier: Shapes<K09.BuildFrontierRequest, K09.BuildFrontierResponse, K09.BuildFrontierErrors>;
  closestEntries: Shapes<K09.ClosestEntriesRequest, K09.ClosestEntriesResponse, K09.ClosestEntriesErrors>;
  gateAndCommit: Shapes<K09.GateAndCommitRequest, K09.GateAndCommitResponse, K09.GateAndCommitErrors>;
  composeInput: Shapes<K09.ComposeInputRequest, K09.ComposeInputResponse, K09.ComposeInputErrors>;
  finalizeMessage: Shapes<K09.FinalizeMessageRequest, K09.FinalizeMessageResponse, K09.FinalizeMessageErrors>;
  recordSafetyOutcome: Shapes<
    K09.RecordSafetyOutcomeRequest,
    K09.RecordSafetyOutcomeResponse,
    K09.RecordSafetyOutcomeErrors
  >;
  releaseSafetyHold: Shapes<
    K09.ReleaseSafetyHoldRequest,
    K09.ReleaseSafetyHoldResponse,
    K09.ReleaseSafetyHoldErrors
  >;
  recordStopOrStart: Shapes<
    K09.RecordStopOrStartRequest,
    K09.RecordStopOrStartResponse,
    K09.RecordStopOrStartErrors
  >;
  setRecordFlag: Shapes<K09.SetRecordFlagRequest, K09.SetRecordFlagResponse, K09.SetRecordFlagErrors>;
  handOff: Shapes<K09.HandOffRequest, K09.HandOffResponse, K09.HandOffErrors>;
  answerHandOff: Shapes<K09.AnswerHandOffRequest, K09.AnswerHandOffResponse, K09.AnswerHandOffErrors>;
  pageTeam: Shapes<K09.PageTeamRequest, K09.PageTeamResponse, K09.PageTeamErrors>;
  acknowledgePage: Shapes<K09.AcknowledgePageRequest, K09.AcknowledgePageResponse, K09.AcknowledgePageErrors>;
  openReviewItem: Shapes<K09.OpenReviewItemRequest, K09.OpenReviewItemResponse, K09.OpenReviewItemErrors>;
  decideReviewItem: Shapes<
    K09.DecideReviewItemRequest,
    K09.DecideReviewItemResponse,
    K09.DecideReviewItemErrors
  >;
  enterDoor: Shapes<K09.EnterDoorRequest, K09.EnterDoorResponse, K09.EnterDoorErrors>;
  sendFixedLine: Shapes<K09.SendFixedLineRequest, K09.SendFixedLineResponse, K09.SendFixedLineErrors>;
  sendsFailing: Shapes<K09.SendsFailingRequest, K09.SendsFailingResponse, K09.SendsFailingErrors>;
  textingBack: Shapes<K09.TextingBackRequest, K09.TextingBackResponse, K09.TextingBackErrors>;
  calendarLinkDropped: Shapes<
    K09.CalendarLinkDroppedRequest,
    K09.CalendarLinkDroppedResponse,
    K09.CalendarLinkDroppedErrors
  >;
  calendarLinkBack: Shapes<
    K09.CalendarLinkBackRequest,
    K09.CalendarLinkBackResponse,
    K09.CalendarLinkBackErrors
  >;
  sendProofCode: Shapes<K09.SendProofCodeRequest, K09.SendProofCodeResponse, K09.SendProofCodeErrors>;
  proveCode: Shapes<K09.ProveCodeRequest, K09.ProveCodeResponse, K09.ProveCodeErrors>;
  issueChatLink: Shapes<K09.IssueChatLinkRequest, K09.IssueChatLinkResponse, K09.IssueChatLinkErrors>;
  plannerVerbs: Shapes<K09.PlannerVerbsRequest, K09.PlannerVerbsResponse, PlannerVerbsErrors>;
  matchKinds: Shapes<K09.MatchKindsRequest, K09.MatchKindsResponse, K09.MatchKindsErrors>;
  lookupListing: Shapes<K09.LookupListingRequest, K09.LookupListingResponse, K09.LookupListingErrors>;
  saveSetupStep: Shapes<K09.SaveSetupStepRequest, K09.SaveSetupStepResponse, K09.SaveSetupStepErrors>;
  readSetup: Shapes<K09.ReadSetupRequest, K09.ReadSetupResponse, K09.ReadSetupErrors>;
}

export type RequestOf<C extends CallName> = CallTypes[C]["request"];
export type ResponseOf<C extends CallName> = CallTypes[C]["response"];
export type ErrorsOf<C extends CallName> = CallTypes[C]["errors"];
/** What a call's handler answers: its response, or one of its errors (each "Refused, nothing written"). */
export type AnswerOf<C extends CallName> = ResponseOf<C> | ErrorsOf<C>;

export function isCallName(value: unknown): value is CallName {
  return typeof value === "string" && (CALL_NAMES as readonly string[]).includes(value);
}

export function isCallerKind(value: unknown): value is CallerKind {
  return typeof value === "string" && (CALLER_KINDS as readonly string[]).includes(value);
}

/**
 * The hop of each call's span when a turn, the console, a job, a clock's firing or the actor on return makes it (K-08 v1
 * hop table; K-09 v1 `caller.traceId` names the hops). A read of the turn face takes its own hop, gateAndCommit (with the
 * planner's verbs inside it) the gate, composeInput and finalizeMessage the code side of the reply (arch 02 line 123), and
 * every call that writes alone or rides in a turn's commit the commit (README defaults).
 */
export const CALL_HOPS: Readonly<Record<CallName, Hop>> = {
  buildFrontier: "frontier",
  closestEntries: "search",
  gateAndCommit: "gate",
  composeInput: "fillAndChecks",
  finalizeMessage: "fillAndChecks",
  recordSafetyOutcome: "commit",
  releaseSafetyHold: "commit",
  recordStopOrStart: "commit",
  setRecordFlag: "commit",
  handOff: "commit",
  answerHandOff: "commit",
  pageTeam: "commit",
  acknowledgePage: "commit",
  openReviewItem: "commit",
  decideReviewItem: "commit",
  enterDoor: "commit",
  sendFixedLine: "commit",
  sendsFailing: "commit",
  textingBack: "commit",
  calendarLinkDropped: "commit",
  calendarLinkBack: "commit",
  sendProofCode: "commit",
  proveCode: "commit",
  issueChatLink: "commit",
  plannerVerbs: "gate",
  matchKinds: "frontier",
  lookupListing: "frontier",
  saveSetupStep: "commit",
  readSetup: "frontier",
};

/**
 * The hop of one call's span: a secure page's call is a pageRequest and an outside AI's an agentApiRequest, whatever the
 * call (K-08 v1 hop table, arch 02 line 129); any other caller's takes the call's own hop. A name that is no call of v1
 * takes the commit hop, refused.
 */
export function hopOf(call: CallName | undefined, callerKind: CallerKind | undefined): Hop {
  if (callerKind === "page") return "pageRequest";
  if (callerKind === "agent") return "agentApiRequest";
  return call === undefined ? "commit" : CALL_HOPS[call];
}
