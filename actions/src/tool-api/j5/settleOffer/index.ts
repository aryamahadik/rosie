// Journey 5's settleOffer (K-09 v1.3, README "The calls v1.3 adds"; T-1022): an offer settled before anything is taken,
// giving no key (A5-03, A5-22, A5-21; B5-31, B5-32, B5-21): a credit used, a pack or membership bought on the
// customer's own yes to it, or a plan's terms agreed or just this visit. Called by a page, or for a plan the customer's
// own turn. Not built: its handler answers notBuilt and writes nothing until its journey 5 task (T-766) gives it its
// logic in this folder.

import { LaneNotBuiltError, type LaneHandler } from "../../tool-api";

/** The call's name in K-09 (v1.3's `$defs/callName`). */
export const CALL = "settleOffer";

/** Not built yet: rejects before it touches the repo, so the base answers notBuilt and rolls the transaction back. */
export const handler: LaneHandler<unknown> = () => Promise.reject(new LaneNotBuiltError(CALL));
