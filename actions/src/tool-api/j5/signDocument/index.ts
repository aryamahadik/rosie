// Journey 5's signDocument (K-09 v1.3, README "The calls v1.3 adds"; T-1022): a booking's document to sign before the
// money step, giving no key (A5-19, A5-20; B5-34, B5-35): sent with its signers and each co-signer's own link, or signed
// on the secure page by the link's own person. Called by the booker's page or own AI to send, only the secure page to
// sign. Not built: its handler answers notBuilt and writes nothing until its journey 5 task (T-767) gives it its logic in
// this folder.

import { LaneNotBuiltError, type LaneHandler } from "../../tool-api";

/** The call's name in K-09 (v1.3's `$defs/callName`). */
export const CALL = "signDocument";

/** Not built yet: rejects before it touches the repo, so the base answers notBuilt and rolls the transaction back. */
export const handler: LaneHandler<unknown> = () => Promise.reject(new LaneNotBuiltError(CALL));
