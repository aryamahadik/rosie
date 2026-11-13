// Journey 5's showMoneyBefore (K-09 v1.3, README "The calls v1.3 adds"; T-1022): what the money step shows first, a
// read that gives no key (A5-01, A5-19, A5-04, A5-31; their twins): the offers, a document to sign, the one branch of
// what is taken now (never a hold), whose yes books it, Stripe down, the page's clock and each money word's row. Called by
// a page or the customer's own AI. Not built: its handler answers notBuilt and writes nothing until its journey 5 task
// gives it its logic in this folder (T-765's branch, T-766's offers, T-767's document).

import { LaneNotBuiltError, type LaneHandler } from "../../tool-api";

/** The call's name in K-09 (v1.3's `$defs/callName`). */
export const CALL = "showMoneyBefore";

/** Not built yet: rejects before it touches the repo, so the base answers notBuilt and rolls the transaction back. */
export const handler: LaneHandler<unknown> = () => Promise.reject(new LaneNotBuiltError(CALL));
