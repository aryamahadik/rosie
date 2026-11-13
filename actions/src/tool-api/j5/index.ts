// Journey 5's Tool API lane (T-1022; DL-728; C-074): the calls K-09 v1.3 adds (README "v1.3"; its `$defs/callName`:
// showMoneyBefore, settleOffer, signDocument, takeMoneyBefore and refundAtOnce), each in a folder of its own here named
// by the call, so each call's task touches only its own folder and they run side by side (build prompt 3.5 (c)). This
// file registers them with the Tool API base through its lane door (tool-api.ts Lane): each call's name, its K-08 hop,
// the frozen K-09 version whose definitions validate it, and its handler. The base answers each by its steps 1 to 7, as
// it answers a K-09 v1 call. Until a call's task builds it, its handler answers notBuilt and writes nothing.
//
// The version: v1.8, the newest frozen K-09 version that carries journey 5's calls by $ref from its root at main a218f36
// (v1.8 refers to v1.6, and so down to v1.3's own definitions, so every v1.3 exchange is a v1.8 exchange); each call's
// request, response and errors are read from it by the call's own name (DL-350). A newer frozen version moves the lane
// only by a task of its own.
//
// The hops, when no page or agent makes the call (a page's span is a pageRequest and an agent's an agentApiRequest, as
// every call's): showMoneyBefore, a read, takes frontier, as K-09 v1's reads off the turn face do (readSetup, matchKinds,
// lookupListing); the four that write, alone or riding a turn's commit, take commit (calls.ts CALL_HOPS' rule).

import type { Lane } from "../tool-api";
import * as refundAtOnce from "./refundAtOnce";
import * as settleOffer from "./settleOffer";
import * as showMoneyBefore from "./showMoneyBefore";
import * as signDocument from "./signDocument";
import * as takeMoneyBefore from "./takeMoneyBefore";

/** The frozen K-09 version whose definitions validate journey 5's calls (DL-728). */
export const J5_VERSION = "v1.8";

/** Journey 5's lane, its calls in the order of K-09 v1.3's `$defs/callName`; the base registers it (createToolApi). */
export const J5_LANE: Lane<unknown> = {
  lane: "j5",
  calls: [
    { call: showMoneyBefore.CALL, hop: "frontier", version: J5_VERSION, handler: showMoneyBefore.handler },
    { call: settleOffer.CALL, hop: "commit", version: J5_VERSION, handler: settleOffer.handler },
    { call: signDocument.CALL, hop: "commit", version: J5_VERSION, handler: signDocument.handler },
    { call: takeMoneyBefore.CALL, hop: "commit", version: J5_VERSION, handler: takeMoneyBefore.handler },
    { call: refundAtOnce.CALL, hop: "commit", version: J5_VERSION, handler: refundAtOnce.handler },
  ],
};
