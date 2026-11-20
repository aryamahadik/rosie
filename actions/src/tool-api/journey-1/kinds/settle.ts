// S1-02's settler (T-1502; K-09 README default 191 as T-1499's round 2 corrects it; DL-1018 card 4, DL-1021): the branch an
// owner's answer to S1-02 takes, from the owner's words alone, never from the option decide named. Decide carries the
// words under S1-02's lowest-id option (K-02 README default 16), and S1-02's three options differ only by Rosie's list,
// which the model never sees, so code settles the branch: the walk asks this settler before it walks (commit/walk
// settle.ts), then S1-02's writer keeps the picks under the settled branch by its own table (answer.ts).
//
// The words are read as S1-02's writer reads them (answer.ts ownerWordsOf): the `kinds` field's source words (K-02
// field.words, the exact words of the turn's text, never the model's value), else the part's quote. By K-02 README default
// 16 they are the part's whole quote exactly as typed, so this one span is split into parts at commas, semicolons and line
// breaks (a part with no word left is no part; words before the list stay in the first part: open gap 172), each part read
// by T-632's kind matcher over K-24's catalog as read on the call (item 78). The catalog is read for every answer, so an
// empty one fails closed (noCatalog) even when every part is not booked (DL-1021 ruling 3). The answer, by default 191's
// table, checked from its first row down:
//
//   no part: the words name no work                          refused (noWords), nothing written
//   any part is `which` (two kinds fit it)                   notBuilt (which), nothing written: the "which?" is not built
//   a `not_booked` part beside a `listed` or `new_work` one  refused (notBookedBesideKept), nothing written (open gap 169)
//   every part is `listed`                                   "All on the list"
//   a `new_work` part, every other `listed`, none not booked "One isn't on the list yet"
//   every part is `not_booked`                               "Not a service we book"
//
// `not_booked` comes from the matcher alone (domain/kind-matcher/not-booked.ts; RULES 1.4): never from decide, whose named
// option carries no outcome (CQ-348 (3)).
//
// One reading (default 191; check_ruling.txt card 4): kindsSteps builds the settler and the writers over one catalog read
// per walk (reads.ts walkMatcher), keyed by the turn context the walk hands both, so the settler's reading and the
// writer's are one and can never read different catalogs; the writer's own fit check (branchNotWords) stays as a second
// lock and fires only if they differ, a fault.
//
// It only reads (item 78, in a read-only transaction of its own beside the call's: reads.ts) and writes nothing; it never
// reads the call's repo. Nothing here logs; what it throws names faults, steps and codes (errors.ts), never the words.

import type { StepSettler, StepSettlerCall } from "../../../commit/walk";
import type { KindMatch } from "../../../domain/kind-matcher";
import { ALL_ON_THE_LIST, NOT_A_SERVICE, ONE_NOT_LISTED, ownerWordsOf } from "./answer";
import { KindsNotBuiltError, KindsRefusedError } from "./errors";
import { walkMatcher, type MatcherOf } from "./reads";
import { kindsWriters, type KindsWriterDeps, type KindsWriters } from "./writers";

/** The one step this folder settles: S1-02, a split of three message branches. */
export const SETTLED_STEP = "S1-02";

/** This folder's settlers by step id (T-1503 binds them through the turn face's signUpSteps). */
export type KindsSettlers<Repo = unknown> = Readonly<Record<typeof SETTLED_STEP, StepSettler<Repo>>>;

/**
 * S1-02's branch from what the matcher read of the owner's words, part by part (default 191's table, the top of this file),
 * checked from its first row down. Throws KindsRefusedError (noWords, notBookedBesideKept) or KindsNotBuiltError (which).
 */
export function settledKinds(parts: readonly KindMatch[], stepId: string): string {
  if (parts.length === 0) throw new KindsRefusedError("noWords", [stepId]);
  if (parts.some((part) => part.outcome === "which")) {
    throw new KindsNotBuiltError("gateAndCommit", "which", [stepId]);
  }
  const notBooked = parts.filter((part) => part.outcome === "not_booked").length;
  if (notBooked > 0 && notBooked < parts.length) {
    throw new KindsRefusedError("notBookedBesideKept", [stepId]);
  }
  if (parts.every((part) => part.outcome === "listed")) return ALL_ON_THE_LIST;
  // No part is `which`, and not booked is all or none: none, so at least one part is new work.
  if (notBooked === 0) return ONE_NOT_LISTED;
  return NOT_A_SERVICE;
}

/**
 * S1-02's settler for one ask of the walk: the owner's words (ownerWordsOf), the catalog through `catalog` (the walk's one
 * read), and the branch by default 191's table. Throws KindsRefusedError (wrongStep, noWords, notBookedBesideKept),
 * KindsNotBuiltError (which) or KindsReadError (the catalog's read failed, or holds no trade-file kind: noCatalog).
 */
export async function settleS1_02<Repo>(
  catalog: () => Promise<MatcherOf>,
  call: StepSettlerCall<Repo>,
): Promise<string> {
  const stepId = call.step.id;
  if (stepId !== SETTLED_STEP) throw new KindsRefusedError("wrongStep", [SETTLED_STEP, stepId]);
  const text = ownerWordsOf(call);
  if (text === null) throw new KindsRefusedError("noWords", [stepId]);
  const { matcher } = await catalog();
  return settledKinds(matcher.match(text), stepId);
}

/** S1-02's settler and the kinds writers, over one catalog read per walk. */
export interface KindsSteps<Repo = unknown> {
  readonly writers: KindsWriters<Repo>;
  readonly settlers: KindsSettlers<Repo>;
}

/**
 * S1-02's settler and S1-02's, S1-03's and S1-74's writers over `deps`, sharing one catalog read per walk (reads.ts
 * walkMatcher, keyed by the turn context the walk hands the settler as `turn` and each writer as `writer.turn`). Building
 * them reads nothing.
 */
export function kindsSteps<Repo = unknown>(deps: KindsWriterDeps): KindsSteps<Repo> {
  const catalog = walkMatcher(deps.reads);
  return {
    writers: kindsWriters<Repo>(deps, catalog),
    settlers: { [SETTLED_STEP]: (call) => settleS1_02(() => catalog(call.turn), call) },
  };
}
