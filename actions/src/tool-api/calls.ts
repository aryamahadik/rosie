// The calls the Tool API registers (T-290, T-1150; C-074): every call K-09 v1 holds (contracts/tool-api, v1's
// `$defs/callName`; the calls v1.1 to v1.4 add are their journey lanes'), each call's request, response and errors as
// K-09 v1.5 defines them, from its generated module (`npm run contracts:types`; ADR-005: generated into
// contracts/generated/, never committed), and the K-08 hop each call's span takes. v1.5 holds every v1 definition under
// its own name and accepts every v1 exchange (README "v1.5"; DL-340), so gateAndCommit's turn may carry the service and
// the chat id of the turn's last text (default 135) and buildFrontier's context may offer the sign-up door (K-02 v1.1).
//
// The generator names the first copy of a title plainly and numbers the later ones. Where v1.1 changed a definition,
// recordSafetyOutcome's and releaseSafetyHold's requests (each also takes the handle actor's record or release on
// arrival) and recordSafetyOutcome's and recordStopOrStart's responses (gives and hold.version; businessesTold), the plain
// name is v1's copy and v1.5's own is numbered, a number that shifts between generations. So those four are read off the
// call's v1.5 exchange, which has no numbered duplicate, never by a numbered name (DL-350), and calls.test.ts pins every
// call's three types to its exchange's, so typecheck fails on a drift.
//
// composeInput alone is K-09 v1.6's (T-1174; README "v1.6"; DL-355): its answer is K-03 v1.1's composer input, whose facts
// may also be term facts, or one of its errors, fixedLineRow and masterLineMissing among them. Its three types are read
// off v1.6's own exchange, taken from v1.6's root by its call (DL-350's way: no generated name, plain or numbered, is
// trusted), and calls.test.ts pins them there. Every other call keeps its v1.5 exchange.
//
// The types are imported as types only, so nothing here loads the generated module at run time; the validator
// (validator.ts) holds every value to the frozen schema itself, by the same v1.5 definitions (v1.6's for composeInput).
//
// The calls a later K-09 minor version adds are never CallNames: each is its journey lane's, registered through the
// base's lane door (tool-api.ts Lane; T-1022, DL-728) with its own hop, which a page's and an agent's call replace as
// they replace a v1 call's (callerHop).

import type * as K09 from "../../../contracts/generated/tool-api/tool-api.v1.5";
import type * as K09V16 from "../../../contracts/generated/tool-api/tool-api.v1.6";
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

/** composeInput's exchange in K-09 v1.6 (T-1174), read off v1.6's root by its call. */
type ComposeInputV16Exchange = Extract<K09V16.ToolApiV1Dot6, { call: "composeInput" }>;

/**
 * Each call's request, response and errors: K-09 v1.5's, the four v1.1 changed read off their exchanges, and
 * composeInput's K-09 v1.6's, read off its v1.6 exchange (each error an object with its own "error"; no response has one).
 */
export interface CallTypes {
  buildFrontier: Shapes<K09.BuildFrontierRequest, K09.BuildFrontierResponse, K09.BuildFrontierErrors>;
  closestEntries: Shapes<K09.ClosestEntriesRequest, K09.ClosestEntriesResponse, K09.ClosestEntriesErrors>;
  gateAndCommit: Shapes<K09.GateAndCommitRequest, K09.GateAndCommitResponse, K09.GateAndCommitErrors>;
  composeInput: Shapes<
    ComposeInputV16Exchange["request"],
    Exclude<ComposeInputV16Exchange["outcome"], { error: string }>,
    Extract<ComposeInputV16Exchange["outcome"], { error: string }>
  >;
  finalizeMessage: Shapes<K09.FinalizeMessageRequest, K09.FinalizeMessageResponse, K09.FinalizeMessageErrors>;
  recordSafetyOutcome: Shapes<
    K09.RecordSafetyOutcomeExchange["request"],
    Exclude<K09.RecordSafetyOutcomeExchange["outcome"], K09.RecordSafetyOutcomeErrors>,
    K09.RecordSafetyOutcomeErrors
  >;
  releaseSafetyHold: Shapes<
    K09.ReleaseSafetyHoldExchange["request"],
    K09.ReleaseSafetyHoldResponse,
    K09.ReleaseSafetyHoldErrors
  >;
  recordStopOrStart: Shapes<
    K09.RecordStopOrStartRequest,
    Exclude<K09.RecordStopOrStartExchange["outcome"], K09.RecordStopOrStartErrors>,
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
 * every call that writes alone or rides in a turn's commit the commit (README defaults). The handle actor's turn records
 * the gate and fillAndChecks hops itself, so the turn face's gateAndCommit, composeInput and finalizeMessage tell the base
 * so, and the base records no span for them (tool-api.ts CallOptions; T-1193).
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
 * The hop of the span of a call whose own hop is `own`: a secure page's call is a pageRequest and an outside AI's an
 * agentApiRequest, whatever the call (K-08 v1 hop table, arch 02 line 129); any other caller's takes `own`. A K-09 v1
 * call's own hop is CALL_HOPS' (hopOf); a lane's call's is the one its lane registered (tool-api.ts Lane; T-1022).
 */
export function callerHop(own: Hop, callerKind: CallerKind | undefined): Hop {
  if (callerKind === "page") return "pageRequest";
  if (callerKind === "agent") return "agentApiRequest";
  return own;
}

/**
 * The hop of one call's span: a secure page's call is a pageRequest and an outside AI's an agentApiRequest, whatever the
 * call (K-08 v1 hop table, arch 02 line 129); any other caller's takes the call's own hop. A name that is no call of v1
 * takes the commit hop, refused.
 */
export function hopOf(call: CallName | undefined, callerKind: CallerKind | undefined): Hop {
  return callerHop(call === undefined ? "commit" : CALL_HOPS[call], callerKind);
}
