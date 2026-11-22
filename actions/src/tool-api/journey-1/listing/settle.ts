// S1-09's settler and its reading (T-635a; K-09 README defaults 201 to 203 and 206, as DL-1133 accepts and fixes them):
// which of S1-09's three branches an owner's typed details take, on default 191's settler port (T-1502's StepSettler,
// actions/src/commit/walk/settle.ts), bound by step id beside S1-02's (WalkDeps.settlers). It writes nothing.
//
// What it reads, and nothing else: (1) the `business` field's words (K-02 fieldValue.words: the business's name and town
// as typed), never its value and never the part's quote, which holds the claim's words; (2) the claim, owner or helper,
// the one thing it takes from the option decide named: the helper's exactly when that option's branch is "Helps run it;
// not an owner", else the owner's (default 201; DL-1133 narrows default 191's line for S1-09 to the branch and the match:
// a named "An owner; the listing matches" claims no match and a named "No match, or already listed" no mismatch); (3) the
// Places lookup (lookup.ts, default 202); (4) once a list is bound, the banned words (default 206; no binding hands one
// in: open gap 187).
//
// What it answers, checked in this order (default 201):
//   (i)   no `business` field, or its words hold no letter (a claim alone, a bare "1", a photo with no caption):
//         "ask" (noDetails)
//   (ii)  a name with no town (default 202's split leaves no try): "ask" (noTown)
//   (iii) a search fails on any try: refused, placesUnavailable, nothing written, the question still open
//   (iv)  the lookup's match carrying no banned word: "An owner; the listing matches" on the owner's claim, "Helps run
//         it; not an owner" on the helper's
//   (v)   anything else: "No match, or already listed", whatever the claim, with its reason label: noListing (no try held
//         a candidate), twoListings (the deciding try held two or more) or bannedWord (the one held candidate carries a
//         banned word). "Already listed" is never answered (default 203 (e)).
// The reading keeps the branch, the claim, the reason label (null on a match) and the name S1-09's writer writes (the
// deciding try's name, else the first try's: default 202), with the try that decided; it holds no field of a candidate.
//
// "ask" until T-1528 (DL-1133, QA's point (b); open gap 179): T-1502's port answers a label or refuses, so the bound
// settler refuses where the reading answers "ask" (listingNeedsDetails): the call fails closed with nothing written, the
// question stays open and the owner gets no reply to that text. The reading itself (readS1_09) answers all three outcomes
// (a label, "ask" with its reason, a refusal), so T-1528 changes only the binding.
//
// Held for the run (default 201, "Its reading, held for the run"; default 199 (1)): the reading is kept on the turn object
// the walk hands the settler as `turn` and every writer of the same run as `writer.turn` (a WeakMap keyed by that object,
// then by the part's index, as kinds/reads.ts walkMatcher keeps its matcher), so S1-09's writer and S1-76's read it and
// nothing else of the words, the lookup or a list, and no writer searches again. Only the settler reads; a writer that
// finds no reading refuses (notSettled). A failed reading is kept as it failed, never read again as a branch.
//
// Nothing here logs; what it throws names faults, steps and labels (errors.ts), never the words or a candidate's fields.

import type { StepSettler, StepSettlerCall } from "../../../commit/walk";
import type { PassedPart } from "../../../commit";
import { ListingRefusedError } from "./errors";
import {
  carriesBannedWord,
  foldMarks,
  holdsLetter,
  lookupListing,
  triesOf,
  type ListingSearch,
  type NameAndTown,
} from "./lookup";
import type { ListingClaim, ListingReason } from "./summary";

/** The step this folder settles and writes: S1-09, a split of three message branches (bundle v2, T-1477). */
export const S1_09 = "S1-09";

/** The step S1-09's "No match, or already listed" walks (MASTER-FLOW-A lines 158 to 166). */
export const S1_76 = "S1-76";

/** S1-09's three branches, word for word as bundle v2 labels them (MASTER-FLOW-A lines 118 to 120). */
export const OWNER_MATCHES = "An owner; the listing matches";
export const HELPS_RUN_IT = "Helps run it; not an owner";
export const NO_MATCH = "No match, or already listed";

/** The answer field S1-09's branches carry (K-01 v1 answerField `business`, type id; default 200). */
export const BUSINESS_FIELD = "business";

/** The key S1-09 gives (K-01 v1 step.gives). */
export const BUSINESS = "business";

/** Why S1-09's reading answered "ask" (default 201 (i) and (ii)). */
export type AskReason = "noDetails" | "noTown";

/** S1-09's reading of one part: a branch with what the writers read, or "ask" with its reason. */
export type ListingReading =
  | {
      readonly outcome: "branch";
      readonly branch: string;
      readonly claim: ListingClaim;
      /** The reason label on "No match, or already listed"; null on a match. */
      readonly reason: ListingReason | null;
      /** The name S1-09's writer writes: the deciding try's name, else the first try's (default 202). */
      readonly name: string;
      /** The try that decided (the owner's own words, folded), or null when none did (noListing). */
      readonly decidedBy: NameAndTown | null;
    }
  | { readonly outcome: "ask"; readonly reason: AskReason; readonly claim: ListingClaim };

/** One ask of the optional banned-word read (default 206): the call's business, its person and the turn's handle. */
export interface BannedWordsCall<Repo = unknown> {
  readonly repo: Repo;
  readonly businessId: string;
  readonly personId: string | null;
  readonly handleId: string;
}

/**
 * The banned words of the call's kept kinds (default 206; S13-11; RULES 10.1), as a list code can read: each entry a word
 * or words a plug-in bans. No binding hands one in until a list exists (open gap 187); a failed read throws and the call
 * fails closed, never read as no word.
 */
export interface BannedWords<Repo = unknown> {
  bannedWords(call: BannedWordsCall<Repo>): Promise<readonly string[]>;
}

/** What S1-09's reading reads with: the Places port, and the banned words once a binding hands a list in. */
export interface ListingReadingDeps<Repo = unknown> {
  readonly places: ListingSearch;
  /** Optional, bound nowhere (default 206; open gap 187): left out, no word is checked, hidden or flagged. */
  readonly banned?: BannedWords<Repo>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `business` field's source words (K-02 fieldValue.words), the first not blank; never its value or the quote. */
export function businessWordsOf(part: PassedPart): string | null {
  const verbPart: unknown = part.part;
  if (!isRecord(verbPart) || !Array.isArray(verbPart.fields)) return null;
  for (const field of verbPart.fields as unknown[]) {
    if (!isRecord(field) || field.name !== BUSINESS_FIELD) continue;
    if (typeof field.words === "string" && field.words.trim() !== "") return field.words;
  }
  return null;
}

/** The claim decide carries by its choice (default 201): the helper's exactly on "Helps run it; not an owner". */
export function claimOf(choice: StepSettlerCall["choice"]): ListingClaim {
  return choice.branch === HELPS_RUN_IT ? "helper" : "owner";
}

/**
 * S1-09's reading of one part (default 201's order, the top of this file). Reads the Places port (at most three
 * searches) and, for a held match with a list bound, the banned words; writes nothing. Throws ListingRefusedError
 * placesUnavailable when a search fails; what the banned-word read throws leaves as it was thrown.
 */
export async function readS1_09<Repo>(
  deps: ListingReadingDeps<Repo>,
  call: StepSettlerCall<Repo>,
): Promise<ListingReading> {
  const claim = claimOf(call.choice);
  const words = businessWordsOf(call.part);
  if (words === null) return { outcome: "ask", reason: "noDetails", claim };
  const folded = foldMarks(words);
  if (!holdsLetter(folded)) return { outcome: "ask", reason: "noDetails", claim };
  const tries = triesOf(folded);
  const [first] = tries;
  if (first === undefined) return { outcome: "ask", reason: "noTown", claim };

  const found = await lookupListing(deps.places, tries, S1_09);
  if (found.found === "noListing") {
    return {
      outcome: "branch",
      branch: NO_MATCH,
      claim,
      reason: "noListing",
      name: first.name,
      decidedBy: null,
    };
  }
  const { decidedBy } = found;
  const named = { claim, name: decidedBy.name, decidedBy };
  if (found.found === "twoListings") {
    return { outcome: "branch", branch: NO_MATCH, reason: "twoListings", ...named };
  }
  const banned =
    deps.banned === undefined
      ? []
      : await deps.banned.bannedWords({
          repo: call.repo,
          businessId: call.businessId,
          personId: call.turn.request.caller.personId,
          handleId: call.turn.turn.handleId,
        });
  if (carriesBannedWord(found.candidate, banned)) {
    return { outcome: "branch", branch: NO_MATCH, reason: "bannedWord", ...named };
  }
  const branch = claim === "helper" ? HELPS_RUN_IT : OWNER_MATCHES;
  return { outcome: "branch", branch, reason: null, ...named };
}

/** The reading of one walk, by part: started by S1-09's settler, read by the writers of the same run. */
export interface WalkReadings<Repo = unknown> {
  /** The reading for the settler's call: read once per turn object and part, every later ask the same answer. */
  read(call: StepSettlerCall<Repo>): Promise<ListingReading>;
  /** The reading held for a writer's turn object and part, or null when the settler read none. */
  held(turn: object, partIndex: number): Promise<ListingReading> | null;
}

/** One walk's readings over `deps`, kept on the turn object (a WeakMap, so a walk's reading goes with its context). */
export function walkReadings<Repo>(deps: ListingReadingDeps<Repo>): WalkReadings<Repo> {
  const readings = new WeakMap<object, Map<number, Promise<ListingReading>>>();
  return {
    read(call) {
      const byPart = readings.get(call.turn) ?? new Map<number, Promise<ListingReading>>();
      readings.set(call.turn, byPart);
      const known = byPart.get(call.part.index);
      if (known !== undefined) return known;
      const reading = readS1_09(deps, call);
      byPart.set(call.part.index, reading);
      return reading;
    },
    held(turn, partIndex) {
      return readings.get(turn)?.get(partIndex) ?? null;
    },
  };
}

/**
 * S1-09's settler over one walk's readings: the branch the reading answers, word for word; "ask" refused
 * (listingNeedsDetails, with its reason label) until T-1528 lets the walk take it. Throws ListingRefusedError (wrongStep,
 * listingNeedsDetails, placesUnavailable) or what the banned-word read throws: the call fails closed, nothing written.
 */
export function s1_09Settler<Repo>(readings: WalkReadings<Repo>): StepSettler<Repo> {
  return async (call) => {
    if (call.step.id !== S1_09) throw new ListingRefusedError("wrongStep", [S1_09, call.step.id]);
    const reading = await readings.read(call);
    if (reading.outcome === "ask")
      throw new ListingRefusedError("listingNeedsDetails", [S1_09, reading.reason]);
    return reading.branch;
  };
}
