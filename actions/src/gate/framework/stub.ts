// The fail-closed stub each limit's folder holds until its own task lands (T-298; T-299 to T-304 each replace only their
// own actions/src/gate/limit-N/index.ts). It refuses every part that reaches it, naming its limit, so a gate with a
// limit not built never passes a part: the gate refuses the whole call (LimitNotBuiltError) and nothing is written.

import type { Limit, LimitNumber, LimitVerdict } from "./types";

/** Limit `limit`'s slot before its task lands: every part is refused, never passed. */
export function notBuiltLimit<N extends LimitNumber>(limit: N): Limit<N> {
  const refused: LimitVerdict<N> = { result: "notBuilt" };
  return {
    limit,
    check: () => Promise.resolve(refused),
  };
}
