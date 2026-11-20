// S1-02's answer as picks (T-633; K-24 v1 picked_kinds; K-09 v1 SetupS1_02: "each kind the owner named, in order, with
// the outcome the owner picked after matchKinds"): the owner's own words, part by part, read by T-632's kind matcher over
// item 78's catalog, kept as K-24 picked_kinds rows under the branch decide picked. Pure but for its two reads (reads.ts);
// it writes nothing, and hands back the rows S1-02's step writer gives the walk.
//
// The owner's words are the chosen option's `kinds` field's words (K-02 v1 field.words: "the exact words of the text the
// value comes from", which code re-parses, never the model's value), else the part's quote ("Not a service we book" carries
// no answer field in bundle v1); split and read as matchKinds reads them (T-632: commas, semicolons and line breaks; a part
// with no word left names no work and gets no pick).
//
// Under each branch of S1-02 (bundle v1's labels), every part must fit it, else the answer is refused with nothing written:
//   - "All on the list": every part listed (one kind fits). Each is a listed pick of its kind.
//   - "One isn't on the list yet": every part listed or new work, at least one new. A listed part is a listed pick; a new
//     one is a new_work pick of a kind drafted for it at once (K-24: "gets its row when drafted so the business's kinds can
//     name it at once"), which S1-03's writer drafts as new work for a 1-business-day review.
//   - "Not a service we book": every part is kept as a not_booked pick with no kind, whatever the matcher reads, so nothing
//     is set up and no kind is given (S1-74: "Rosie says so and sets nothing up"; "A person on Rosie's team sees it within
//     1 business day, in case it was misread"); no catalog is read.
// A part two kinds fit needs the owner's "which?" first (arch 05 line 237), which is not built: notBuilt, nothing written.
//
// With S1-02's settler bound (T-1502; settle.ts; K-09 README default 191), the branch is the settled one, never the option
// decide named: the walk hands this writer the settled branch as the branch chosen, and the writer reads the catalog the
// settler read for the same walk (the catalog read handed in), so the two readings are one. This table does not change,
// and its fit check (branchNotWords) stays as a second lock, which then fires only when the two readings differ.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The branch decides how the parts are kept and must fit them, as the table above: "All on the list" and "One isn't
//      on the list yet" are refused (branchNotWords) when the matcher reads a part otherwise (a part no kind fits under the
//      first; no new part, or a part Rosie never books, under the second), since a pick made against the words would be a
//      guess. "Not a service we book" keeps every part not_booked: it sets nothing up, and S1-74's team review catches a
//      misread.
//   2. The picks are numbered after item 79's (K-05 v1.19 "T-633 ... numbers new picks after item 79's"): the first new
//      pick's position is one past the highest position among the call's business's picks and the person's picks with no
//      business, in the owner's order from there.
//   3. A listed part whose kind the owner has already picked (an item 79 pick of that kind, or an earlier part of the same
//      answer) is not picked again: K-24 keeps one pick, so one set of text blocks, per company kind
//      (picked_kinds_one_per_company_kind), and the pick on file stands. Its kind still counts toward `kinds`.
//   4. Picks are written with no company and no business (open gap 91, which the card leaves to T-633): K-24 places a
//      pick at S1-04 and sets its business from its company there ("company_id and business_id are null until S1-04
//      places the pick"), and K-05's commit refuses a state update that moves a row of one business to another (db/repo
//      commit-turn.ts default 16), so a pick written under the call's business could never be placed in the owner's other
//      business (Sam's plumbing at Lee Home Services, K-24 seed-business-kinds.json). The commit writes them on the
//      runtime side, as rosie_job (K-24 README rule 2).
//   5. picked_at is the turn's now (K-09 gateAndCommit.request.now), as T-1461's stand-in writes it.
//   6. A drafted kind's id is `new-` and the first 16 hex digits of the SHA-256 of its pick's row id, so a repeat of the
//      turn names the same row and two owners' drafts never meet (K-24: "Code makes a drafted id unique"); its name is the
//      owner's own words for it, as typed (K-24 kinds.name: "a drafted kind's name in the owner's words"); its style is
//      null and its facts null (kinds_drafted_facts_on_draft); its pattern is the closest booking pattern (S1-03: "It
//      matches the work to the closest booking pattern"): the pattern of the kind the matcher ranks first for its words, or
//      `service` when no kind meets any of them, as K-24's own drafted kind (seed-new-work-draft.json's new-pack-hikes).
//      The team's review checks it before it can go live (offline until approved).
//   7. K-08 v1.1 has no kind for a picked_kinds or a kinds row (K-09 README: setup writes have no kind yet; CQ-56), so these
//      rows carry no event-log entry, as T-1461's stand-in and K-09 v1.5 default 134 write none.

import type { PickedKindRead } from "../../../../../db/repo/kinds-reads";
import type { StepWriterCall } from "../../../commit/walk";
import type { StateWrite } from "../../../commit";
import { splitParts, words, type KindMatch } from "../../../domain/kind-matcher";
import type { SetupKey } from "../../../gate/framework";
import { KindsNotBuiltError, KindsRefusedError } from "./errors";
import { matcherOf, type KindsReads, type MatcherOf } from "./reads";

/** S1-02's three branches, as bundle v1 labels them (bundles/v1 flow A; K-01 v1 branch.label). */
export const ALL_ON_THE_LIST = "All on the list";
export const ONE_NOT_LISTED = "One isn't on the list yet";
export const NOT_A_SERVICE = "Not a service we book";

/** The key S1-02 gives (K-01 v1 step.gives; K-09 README "S1-02 (S1-74) | SetupS1_02 | kinds"). */
export const KINDS: SetupKey = "kinds";

/** The pattern of a drafted kind no catalog kind meets (default 6: K-24 seed-new-work-draft.json's new-pack-hikes). */
export const NO_PATTERN_MET = "service";

/** K-24 picked_kinds.outcome. */
export type PickOutcome = "listed" | "new_work" | "not_booked";

/** A kind drafted for a new_work pick (K-24 kinds, source new_work). */
export interface DraftedKind {
  readonly id: string;
  readonly name: string;
  readonly pattern: string;
}

/** One pick S1-02's answer writes, in the owner's order. */
export interface KindsPick {
  /** The picked_kinds row's id (default 131's form, by S1-02's writer: `pick-s1-02-<turn key>-<n>`). */
  readonly id: string;
  readonly position: number;
  /** The owner's own words for it, as typed. */
  readonly words: string;
  readonly outcome: PickOutcome;
  /** The kind it became: a trade-file kind when listed, the drafted kind when new_work; null when not booked. */
  readonly kindId: string | null;
  /** The kind drafted for it (new_work), written just before it; else null. */
  readonly drafted: DraftedKind | null;
}

/** What S1-02's answer writes: its picks and their rows, and the keys it gives. */
export interface KindsAnswer {
  /** The branch decide picked (bundle v1's label). */
  readonly branch: string;
  /** The picks written, in the owner's order (a kind already picked is not among them: default 3). */
  readonly picks: readonly KindsPick[];
  /** The state writes, in order: each drafted kind's kinds row just before its pick (picked_kinds_kind_fk). */
  readonly state: readonly StateWrite[];
  /** `kinds` when the answer keeps any kind (listed or new work); none when every part is not booked. */
  readonly gives: readonly SetupKey[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The owner's own words S1-02's answer carries: the chosen option's `kinds` field's words, else the part's quote (both
 * exact words of the turn's texts, which code confirms: K-02 v1). Null when the part carries neither.
 */
export function ownerWordsOf(call: Pick<StepWriterCall, "part">): string | null {
  const part: unknown = call.part.part;
  if (!isRecord(part)) return null;
  const fields: unknown = part.fields;
  if (Array.isArray(fields)) {
    for (const field of fields as unknown[]) {
      if (
        isRecord(field) &&
        field.name === KINDS &&
        typeof field.words === "string" &&
        field.words.trim() !== ""
      ) {
        return field.words;
      }
    }
  }
  const quote: unknown = part.quote;
  return typeof quote === "string" && quote.trim() !== "" ? quote : null;
}

/** The parts of the owner's words that name some work, as matchKinds splits them (T-632 words.ts), each as typed. */
function partsOf(text: string): string[] {
  return splitParts(text).filter((part) => words(part).length > 0);
}

/** The first new position: one past the highest of item 79's picks (default 2). */
function firstPosition(picks: readonly PickedKindRead[]): number {
  return picks.reduce((highest, pick) => Math.max(highest, pick.position), 0) + 1;
}

const encoder = new TextEncoder();

/** The first 16 hex digits of a text's SHA-256 (Web Crypto, as the Worker runs it). */
async function hex16(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A drafted kind's id (default 6): `new-` and an id code made from its pick's row id. */
export async function draftedKindId(pickId: string): Promise<string> {
  return `new-${await hex16(JSON.stringify(["kinds", "new_work", pickId]))}`;
}

/** The closest booking pattern of new words (default 6): the first-ranked kind's, else `service`. */
function closestPattern(match: MatcherOf, part: string): string {
  const [first] = match.matcher.rank(part);
  return (first === undefined ? undefined : match.kinds.get(first.id)?.pattern) ?? NO_PATTERN_MET;
}

/** A part as the branch keeps it: its outcome, its kind and, for new work, its closest pattern. */
interface Kept {
  readonly words: string;
  readonly outcome: PickOutcome;
  readonly kindId: string | null;
  readonly pattern: string | null;
}

/** Every part's match under "All on the list" or "One isn't on the list yet", held to the branch (default 1). */
async function matchedUnder(
  catalog: () => Promise<MatcherOf>,
  branch: string,
  text: string,
  stepId: string,
): Promise<Kept[]> {
  const match = await catalog();
  const parts: KindMatch[] = match.matcher.match(text);
  if (parts.length === 0) throw new KindsRefusedError("noWords", [stepId]);
  if (parts.some((part) => part.outcome === "which")) {
    throw new KindsNotBuiltError("gateAndCommit", "which", [stepId]);
  }
  const allowed: readonly string[] = branch === ALL_ON_THE_LIST ? ["listed"] : ["listed", "new_work"];
  const other = parts.find((part) => !allowed.includes(part.outcome));
  if (other !== undefined) throw new KindsRefusedError("branchNotWords", [stepId, other.outcome]);
  if (branch === ONE_NOT_LISTED && !parts.some((part) => part.outcome === "new_work")) {
    throw new KindsRefusedError("branchNotWords", [stepId, "listed"]);
  }
  return parts.map((part): Kept => {
    if (part.outcome === "listed") {
      const [kind] = part.kinds;
      if (kind === undefined) throw new KindsRefusedError("branchNotWords", [stepId, part.outcome]);
      return { words: part.words, outcome: "listed", kindId: kind.kindId, pattern: null };
    }
    return {
      words: part.words,
      outcome: "new_work",
      kindId: null,
      pattern: closestPattern(match, part.words),
    };
  });
}

/** Every part kept not_booked, with no catalog read ("Not a service we book"). */
function notBooked(text: string, stepId: string): Kept[] {
  const parts = partsOf(text);
  if (parts.length === 0) throw new KindsRefusedError("noWords", [stepId]);
  return parts.map((part) => ({ words: part, outcome: "not_booked", kindId: null, pattern: null }));
}

/**
 * S1-02's answer for one call of its writer: the owner's words read under the branch decide picked (or, with a settler
 * bound, the settled branch the walk hands it), numbered after item 79's picks, each kept pick's rows, and the keys it
 * gives. Reads item 78 through `catalog` (unless "Not a service we book"; by default a read of its own, or the walk's one
 * read shared with S1-02's settler: reads.ts walkMatcher) and item 79, each in its own read-only transaction; writes
 * nothing. Throws KindsRefusedError, KindsNotBuiltError or KindsReadError.
 */
export async function answerOf<Repo>(
  reads: KindsReads,
  call: StepWriterCall<Repo>,
  catalog: () => Promise<MatcherOf> = () => matcherOf(reads),
): Promise<KindsAnswer> {
  const stepId = call.step.id;
  const { branch } = call.choice;
  if (branch !== ALL_ON_THE_LIST && branch !== ONE_NOT_LISTED && branch !== NOT_A_SERVICE) {
    throw new KindsRefusedError("noBranch", [stepId]);
  }
  const { turn } = call.writer;
  const { request } = turn;
  const personId = request.caller.personId;
  if (personId === null) throw new KindsRefusedError("noPerson", [stepId]);
  const text = ownerWordsOf(call);
  if (text === null) throw new KindsRefusedError("noWords", [stepId]);

  const kept =
    branch === NOT_A_SERVICE ? notBooked(text, stepId) : await matchedUnder(catalog, branch, text, stepId);
  // The business is the call's own (CommitTurnContext.businessId), never a request value (DL-935).
  const onFile = await reads.pickedKinds({ businessId: turn.businessId, personId });
  const picked = new Set(onFile.picks.flatMap((pick) => (pick.kindId === null ? [] : [pick.kindId])));

  const picks: KindsPick[] = [];
  const state: StateWrite[] = [];
  let position = firstPosition(onFile.picks);
  for (const part of kept) {
    if (part.outcome === "listed" && part.kindId !== null && picked.has(part.kindId)) continue;
    const id = call.writer.rowId("pick");
    let drafted: DraftedKind | null = null;
    if (part.outcome === "new_work") {
      drafted = { id: await draftedKindId(id), name: part.words, pattern: part.pattern ?? NO_PATTERN_MET };
      state.push({
        op: "insert",
        table: "kinds",
        values: {
          id: drafted.id,
          name: drafted.name,
          style: null,
          pattern: drafted.pattern,
          facts: null,
          source: "new_work",
        },
      });
    }
    const kindId = drafted?.id ?? part.kindId;
    if (kindId !== null) picked.add(kindId);
    const pick: KindsPick = { id, position, words: part.words, outcome: part.outcome, kindId, drafted };
    picks.push(pick);
    state.push({
      op: "insert",
      table: "picked_kinds",
      values: {
        id,
        owner_person_id: personId,
        position,
        words: part.words,
        outcome: part.outcome,
        kind_id: kindId,
        company_id: null,
        business_id: null,
        picked_at: request.now,
      },
    });
    position += 1;
  }
  return { branch, picks, state, gives: branch === NOT_A_SERVICE ? [] : [KINDS] };
}
