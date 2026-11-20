// S1-11's read-only step writer (T-634 part 1; DL-961 card E; DL-988; DL-994): "Plug-in: each kind of work"
// (MASTER-FLOW-A S1-11, automatic: "needs kinds, gives pf.license ... pf.edges"), a StepWriter of the walk
// (commit/walk/writes.ts:153-201) that card F binds by step id. When the walk walks S1-11 (after S1-02's "All on the
// list", or "One isn't on the list yet" through S1-03), it loads the first kind named's plug-in from the turn's pinned
// bundle and gives the 11 pf keys: one K-24 v1 picked_kind_texts insert per pf key, all for that one pick (K-09 README's
// S1-11 row; MC R3; Q-39), each block its trade overlay's own (./plug-in.ts, with MC C5's fills). Like every step writer
// it only reads, and never writes: the commit writes what writesOf returns.
//
// Which kind to load: the first kind named, alone (DL-994 item 1). The master loads the first kind's plug-in now and
// each other kind's when the owner gets to it (MASTER-FLOW-A.md:73: "the barbershop's now, and plumbing's and
// electrical's when Sam gets to them"; S1-38; K-24 README "Text blocks": "so a pick may have none yet", and its seed,
// "the barbershop's 11 plug-in text blocks loaded at S1-11"). So for "Barbershop, plumbing, electrical" S1-11 gives
// exactly 11 inserts, all the barbershop pick's.
//
// The rule (a default, DL-994 item 1: the master names no rule for the cases after its first line):
//   - S1-11 loads the lowest-position kept pick of this walk's own S1-02 answer. A pick is kept unless its outcome is
//     not_booked (S1-74 sets nothing up); `position` is K-24's picked_kinds.position, the order the owner named the
//     kinds, from 1 ("the first named is set up first"). Of two kept picks at one position (K-24 has no unique key on
//     it), the one S1-02's writer gave first;
//   - whatever the owner already has on file: no pick on file is read, loaded or reloaded here;
//   - that pick listed (a trade-file kind): one overlay read and its 11 blocks;
//   - that pick drafted as new work (its blocks are K-05 v1.19's open gap 89), or no pick kept: nothing is read, state
//     is [] and gives is [];
//   - no other pick's overlay is read, so a later kind the pinned bundle holds no overlay for never refuses the part.
//
// Where the picks come from. S1-11 is walked in the same walk, and so the same commit, as S1-02's answer, whose writer
// (T-633's) gives the picks as picked_kinds inserts (commit-s1-02.json: three picked kinds, then S1-11, then S1-04's
// question). Those rows are not in the database when S1-11's writer runs, so no K-05 read answers them (K-05 v1.19's
// readPickedKinds reads committed rows, as rosie_job), and the walk hands a writer no row an earlier step's writer gave
// (StepWriterCall). StepWriter is a closure (the architect's N4 on T-1461), so the two are joined here, with no walk
// change: createPlugInWriters gives `kinds`, which card F wraps around S1-02's writer, and `plugIns`, S1-11's writer.
// `kinds` hands S1-02's rows back unchanged and keeps the picks they insert, each with its position, for the walk that
// called it (the turn context the commit hands writesOf, which the walk passes to every writer of one run, and the
// part's index); `plugIns` reads the picks kept for its own walk and part. The commit builds a new context object for
// each gate run, so a repeat or a re-gate starts with nothing kept (DL-994 item 4). S1-11 walked with none kept
// (S1-02's writer bound without `kinds`) is refused (noPicks), never guessed.
//
// What it writes (K-24 README "Picks, text blocks and drafts"):
//   - the first kind named's 11 blocks, in pf key order, each as the pinned overlay holds it, with the pick's id and the
//     pick's business, copied (picked_kind_texts_pick_business_fk; null while the pick has none, K-24 rule 2), so a
//     block is always its pick's;
//   - no event-log entry: K-08 has no kind for a pick or its blocks (CQ-56: K-08 adds each kind with the version that
//     first writes it), as S1-02's picks come with none (commit/test-support.ts samKindsWrites);
//   - no row id of its own: a picked_kind_texts row is named by its key, K-05 v1.18 item 77's `<pick id>/<pf key>`, which
//     the database builds (db/repo/setup/row-names.ts), so WriterContext.rowId is never called.
//
// What it reads (T-633's note 7, DL-979, DL-982: the role of each read on staging): one trade overlay, the first kind
// named's, through its bundles port, under the turn row's pinned bundle id (K-05 v1 turn.bundleId): KV first, else
// PostgreSQL's copy through K-05 v1 readBundleValue (item 7; arch 10 line 536), the reader the walk's flow graphs come
// through, whose client card F names. That one read is awaited before anything else, and a writer that ever reads more
// than one bundle part awaits each before the next, never side by side (staging allows a gate call 2 connections:
// DL-994 item 2). No table is read on the call's transaction, so nothing here reads handles, persons, phones,
// person_handles or turns as rosie_app, no CatalogReadError can arise, and the rosie_app pool needs no connection beside
// the call's for it. The call's business is CallContext.businessId as the commit hands it (CommitTurnContext.businessId),
// never a request value; a pick of another business is refused.
//
// Not here: binding it into the turn face (card F, turn-face/commit.ts:566); each later kind's plug-in, loaded when the
// owner gets to it (S1-38); S1-04's answer and S1-08's plan (part 2); the owner confirming arrival and free-cancel
// (S1-21, T-644).

import type { CommitTurnContext, StateWrite } from "../../../commit/types";
import type { BundleIdOf, StepRows, StepWriter } from "../../../commit/walk";
import type { SetupKey } from "../../../gate/framework";
import { PlugInRefusedError } from "./errors";
import { loadPlugIn, PF_TEXT_KEYS } from "./plug-in";

/** The step this writer writes. */
export const S1_11 = "S1-11";

/**
 * The turn's pinned bundle's trade overlays (K-01 v1 tradeOverlay), each read under the bundle's id from KV, or
 * PostgreSQL's copy on a miss (K-05 v1 readBundleValue), and handed over parsed; the writer checks every field it loads
 * itself. runtime/src/bundle's PinnedBundle.trade reads an overlay so (its notInBundle answers null here), as the walk's
 * WalkBundles.flow reads a flow graph.
 */
export interface PlugInBundles {
  /** The overlay of the trade `tradeId` in the bundle `bundleId`, or null when the bundle holds no such trade. */
  trade(bundleId: BundleIdOf, tradeId: string): Promise<unknown>;
}

/** What S1-11's writer is bound with. */
export interface PlugInDeps {
  /** The pinned bundle's trade overlays (card F binds the turn face's bundle reader). */
  readonly bundles: PlugInBundles;
}

/** A pick, as S1-11 reads it from the K-24 picked_kinds insert S1-02's writer gave. */
export interface PickedKind {
  /** The pick's id (picked_kinds.id), which its blocks name. */
  readonly id: string;
  /** Its place in the order the owner named the kinds, a whole number from 1 (picked_kinds_position_positive). */
  readonly position: number;
  readonly outcome: "listed" | "new_work" | "not_booked";
  /** The kind it became (a trade file's id when listed), or null when not booked. */
  readonly kindId: string | null;
  /** The pick's business, or null before S1-04 places it. */
  readonly businessId: string | null;
}

/** S1-11's writer, and the wrapper that keeps S1-02's picks for it in the same walk. */
export interface PlugInWriters<Repo = unknown> {
  /**
   * S1-02's writer (T-633's), wrapped: it answers what the writer answers, unchanged, and keeps the picks its rows insert
   * for S1-11 in the same walk. Card F binds the wrapped writer to S1-02.
   */
  readonly kinds: (writer: StepWriter<Repo>) => StepWriter<Repo>;
  /** S1-11's writer: the first kind named's 11 plug-in text blocks from the pinned overlay. Card F binds it to S1-11. */
  readonly plugIns: StepWriter<Repo>;
}

const OUTCOMES: readonly PickedKind["outcome"][] = ["listed", "new_work", "not_booked"];

/** K-24 kinds_id_form: a kind's id, a trade file's (barber) or a drafted kind's (new-pack-hikes). */
const KIND_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** K-24 kinds_new_work_id: a drafted kind's id starts so, and a trade file's never does. */
const DRAFTED = "new-";

/** What `kinds` kept for one part: S1-02's picks, or the fact that one of its picked_kinds inserts is not K-24's shape. */
type Kept = readonly PickedKind[] | "notWellFormed";

/** A K-24 picked_kinds insert's values as a pick, or null when they are not its shape (K-24 v1 picked_kinds' checks). */
function pickOf(values: Readonly<Record<string, unknown>>): PickedKind | null {
  const { id, position, outcome, kind_id: kindId, business_id: business } = values;
  const known = OUTCOMES.find((each) => each === outcome);
  if (typeof id !== "string" || id === "" || known === undefined) return null;
  // picked_kinds_position_positive: a whole number from 1, the order the owner named the kinds.
  if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1) return null;
  // A column left out takes its default (K-05 v1 stateWrite): picked_kinds.business_id is null until S1-04.
  const businessId = business ?? null;
  if (businessId !== null && (typeof businessId !== "string" || businessId === "")) return null;
  if (kindId === null || kindId === undefined) {
    // picked_kinds_kind_unless_not_booked: only work not booked names no kind.
    return known === "not_booked" ? { id, position, outcome: known, kindId: null, businessId } : null;
  }
  if (typeof kindId !== "string" || !KIND_ID.test(kindId) || known === "not_booked") return null;
  // picked_kinds_outcome_matches_kind: a drafted kind is new work's, and a listed kind is a trade file's.
  if (kindId.startsWith(DRAFTED) !== (known === "new_work")) return null;
  return { id, position, outcome: known, kindId, businessId };
}

/** The picks S1-02's rows insert, in their order, or notWellFormed when one picked_kinds insert is not K-24's shape. */
function picksIn(state: readonly StateWrite[]): Kept {
  const picks: PickedKind[] = [];
  for (const write of state) {
    if (write.op !== "insert" || write.table !== "picked_kinds") continue;
    const pick = pickOf(write.values);
    if (pick === null) return "notWellFormed";
    picks.push(pick);
  }
  return picks;
}

/** A listed pick, with the trade-file kind it loads. */
interface ListedPick extends PickedKind {
  readonly kindId: string;
}

const isListed = (pick: PickedKind): pick is ListedPick => pick.outcome === "listed" && pick.kindId !== null;

/**
 * The first kind named: the lowest-position kept pick (outcome not not_booked), the earlier of S1-02's rows when two
 * hold one position, or null when no pick is kept (the rule at the top of this file).
 */
function firstNamed(picks: readonly PickedKind[]): PickedKind | null {
  let first: PickedKind | null = null;
  for (const pick of picks) {
    if (pick.outcome === "not_booked") continue;
    if (first === null || pick.position < first.position) first = pick;
  }
  return first;
}

/** One picked_kind_texts insert: a block of the pick's plug-in, under the pick's id and business (K-24 v1). */
function textRow(pick: ListedPick, key: string, block: string): StateWrite {
  return {
    op: "insert",
    table: "picked_kind_texts",
    values: { picked_kind_id: pick.id, pf_key: key, business_id: pick.businessId, block },
  };
}

/**
 * S1-11's read-only step writer and the `kinds` wrapper that hands it S1-02's picks from the same walk (the top of this
 * file). Each call of `plugIns` reads at most one trade overlay, the first kind named's, through `deps.bundles`; what it
 * throws (PlugInRefusedError, or the bundles port's own failure) fails the call closed with nothing written.
 */
export function createPlugInWriters<Repo = unknown>(deps: PlugInDeps): PlugInWriters<Repo> {
  // Per walk (the turn context the commit hands writesOf) and part: what S1-02's writer gave. A WeakMap, so a walk's
  // picks go with its context.
  const kept = new WeakMap<CommitTurnContext<Repo>, Map<number, Kept>>();

  const kinds =
    (writer: StepWriter<Repo>): StepWriter<Repo> =>
    async (call) => {
      const rows = await writer(call);
      const byPart = kept.get(call.writer.turn) ?? new Map<number, Kept>();
      byPart.set(call.part.index, picksIn(rows.state));
      kept.set(call.writer.turn, byPart);
      return rows;
    };

  const plugIns: StepWriter<Repo> = async (call) => {
    if (call.step.id !== S1_11) throw new PlugInRefusedError("notS1_11", [call.step.id]);
    const { turn } = call.writer;
    const picks = kept.get(turn)?.get(call.part.index);
    if (picks === undefined) throw new PlugInRefusedError("noPicks");
    if (picks === "notWellFormed") throw new PlugInRefusedError("pickNotWellFormed");
    // A pick is of the call's business, or of none yet (CallContext.businessId, as the commit hands it).
    if (picks.some((pick) => pick.businessId !== null && pick.businessId !== turn.businessId)) {
      throw new PlugInRefusedError("pickOtherBusiness");
    }
    const first = firstNamed(picks);
    // The first kind named is drafted new work, or no pick is kept: nothing is read and nothing is given.
    if (first === null || !isListed(first)) {
      const nothing: StepRows = { state: [], stateEvents: [], gives: [], asks: [], messages: [] };
      return nothing;
    }
    const pinned: BundleIdOf = { hash: turn.turn.bundleId.hash, build: turn.turn.bundleId.build };
    // The one bundle read, awaited before anything else (a second part would be awaited after it, never beside it).
    const overlay = await deps.bundles.trade(pinned, first.kindId);
    if (overlay === null) throw new PlugInRefusedError("kindNotInBundle", [S1_11, first.kindId]);
    const plugIn = loadPlugIn(overlay, first.kindId);
    const state = plugIn.blocks.map(({ key, block }) => textRow(first, key, block));
    const gives: SetupKey[] = [...PF_TEXT_KEYS];
    const rows: StepRows = { state, stateEvents: [], gives, asks: [], messages: [] };
    return rows;
  };

  return { kinds, plugIns };
}
