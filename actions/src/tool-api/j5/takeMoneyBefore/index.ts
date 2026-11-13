// Journey 5's takeMoneyBefore (K-09 v1.3, README "The calls v1.3 adds" and "Each key's one call"; T-1022): the one place
// that sets what a booking took, and the one call that writes journey 5's keys money_before, card_saved, deposit_paid
// and paid_full (A5-05, A5-07, A5-13, A5-16, A5-08; their twins): the card stage, C3's pay link, the yes, let go, ask the
// owner and the owner's answer. Called by a page, a turn, the customer's own AI or the owner, as each stage allows. Not
// built: its handler answers notBuilt and writes nothing until its journey 5 tasks (T-765, T-768) give it its logic in
// this folder.

import { LaneNotBuiltError, type LaneHandler } from "../../tool-api";

/** The call's name in K-09 (v1.3's `$defs/callName`). */
export const CALL = "takeMoneyBefore";

/** Not built yet: rejects before it touches the repo, so the base answers notBuilt and rolls the transaction back. */
export const handler: LaneHandler<unknown> = () => Promise.reject(new LaneNotBuiltError(CALL));
