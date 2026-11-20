// matchKinds, the S1-02 call (T-633; K-09 v1 matchKinds; arch 05 line 237; C-130 through T-632's matcher): the owner's
// words, part by part, matched to the closest of the 243 kinds of item 78's catalog, each part listed, one "which?", new
// work or not booked. Called by the frontier builder for S1-02's facts and by registration screen 1 (K-21); a read, so
// safe to repeat. Not bound into this folder's FOLDER entry here: the registry's entries stay notBuilt until the card
// that binds the setup calls (journey-1.test.ts holds every folder's handler to NotBuiltError), so the handler is
// exported for that binding (createMatchKinds).
//
// The catalog is read in a read-only transaction of its own on the Tool API's client (rosie_app; reads.ts), never on the
// call's business-scoped transaction, which is read committed (readKindCatalogIn refuses it: DL-970), so the handler
// never touches its context's repo. The request's flow filters no kind (K-05 v1.19 default 167; T-632 default 5: every
// kind runs in both flows), and its business is not read: the catalog is the same under every business.
//
// Answers (K-09 v1 matchKinds.errors): K-05's transient answer to the catalog read is K-09's transient (DL-931); a catalog
// the matcher refuses (no trade-file kind: the seed has not run) is indexUnavailable ("S1-02 asks the owner again later;
// nothing is picked"; K-05 v1.19 default 170). Words that name no work give no part, which K-09's response cannot carry
// (minItems 1): the call is refused (KindsRefusedError noWords), nothing read beyond the catalog, and the caller asks
// again (T-632: "the caller asks again"). Nothing here logs.
//
// Defaults used (for ops/QUESTIONS.md):
//  14. A catalog with no trade-file kind answers indexUnavailable (K-09's one error for a matcher that cannot read its
//      catalog), as K-05 v1.19 default 170 and CQ-348 (4) name it.
//  15. Words that name no work are refused (thrown), since K-09 v1 has no error for them and its response needs a part.

import type { ErrorsOf, ResponseOf } from "../../calls";
import type { Handler } from "../../tool-api";
import { KindsReadError, KindsRefusedError } from "./errors";
import { matcherOf, type KindsReads } from "./reads";

/** What matchKinds reads with: item 78, the catalog (reads.ts). */
export interface MatchKindsDeps {
  readonly reads: Pick<KindsReads, "catalog">;
}

type MatchKindsAnswer = ResponseOf<"matchKinds"> | ErrorsOf<"matchKinds">;

/** matchKinds' handler over `deps`, as the Tool API base takes it (its context's repo unused). */
export function createMatchKinds<Repo = unknown>(deps: MatchKindsDeps): Handler<"matchKinds", Repo> {
  return async (request): Promise<MatchKindsAnswer> => {
    let match;
    try {
      match = await matcherOf(deps.reads);
    } catch (error) {
      if (error instanceof KindsReadError) {
        if (error.fault === "noCatalog") return { error: "indexUnavailable" };
        if (error.answer?.error === "transient")
          return { error: "transient", sqlstate: error.answer.sqlstate };
      }
      throw error;
    }
    const [first, ...more] = match.matcher.match(request.words);
    if (first === undefined) throw new KindsRefusedError("noWords", ["matchKinds"]);
    return { parts: [first, ...more] };
  };
}
