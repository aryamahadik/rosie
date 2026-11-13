// Journey 5's refundAtOnce (K-09 v1.3, README "The calls v1.3 adds"; T-1022): S12-26, a charge made twice refunded at
// once and both told, giving no key: the refund with its Stripe effect and two clock rows due at once. Called by a job
// only (reconciliation, provider-event handling). Not built: its handler answers notBuilt and writes nothing until its
// task (T-764) gives it its logic in this folder.

import { LaneNotBuiltError, type LaneHandler } from "../../tool-api";

/** The call's name in K-09 (v1.3's `$defs/callName`). */
export const CALL = "refundAtOnce";

/** Not built yet: rejects before it touches the repo, so the base answers notBuilt and rolls the transaction back. */
export const handler: LaneHandler<unknown> = () => Promise.reject(new LaneNotBuiltError(CALL));
