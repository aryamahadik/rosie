// The one-kind path (T-1492; K-09 README default 199 item (4), default 185; DL-1033 ruling 7, DL-1049; rule-onekind.json
// card 7 as check-onekind.json corrects it; the ruling's decision (d)): S1-04 is "Asked only when Sam names more than one
// kind of work" (MASTER-FLOW-A.md:90), so with exactly one kept kind it is walked, not asked, by two pieces of bound code
// that share what they read and what they placed for one walk:
//
//   wrap      a wrapper around T-633's S1-02 writer (journey-1/kinds writers.ts), bound inside T-634's `kinds` wrapper
//             (journey-1/plug-ins writer.ts): plugIns.kinds(oneKind.wrap(kindsWriters["S1-02"])). It counts the owner's
//             kept picks by kind; with exactly one, the pick S1-02's rows insert for it is placed on its own insert:
//             company_id the company the turn runs under and business_id the call's business, with that kind's K-23
//             company_kinds insert just before it unless item 72 shows it on file. Any other count, or no kept pick
//             inserted: S1-02's rows go back unchanged, the very object its writer answered. Since T-634's wrapper sits
//             outside it, S1-11's text rows take the placed pick's business (T-634 copies each pick's business_id).
//   settler   S1-04's buttons settler (T-1491's WalkDeps.buttonsSettlers; commit/walk/buttons.ts), which the walk asks
//             once it has built the rows before S1-04. It recounts from the rows built so far and item 79. One kept kind:
//             rows that give companies, with no further row when the wrapper placed the pick on its insert, or, for the
//             one kept pick on file with no company, its company kind first (unless on file) and that pick's update at
//             the version it was read at (with its text, draft and block rows, which gain the same business). Two or
//             more: "ask", and the walk asks S1-04 as today. None: refused. The recount and the wrapper's placement
//             disagreeing refuses, with nothing written.
//
// How the pick takes its company in the same commit. The company itself is on file (the turn's company: default 182, the
// caller's person's own company whose business is the call's business), so no companies row is written. The commit locks
// and compares every row it updates before it writes anything (db/repo/commit-turn.ts, the header's item 2 and its setup
// tables, lines 119-131: "a state update names the row by its key ... is found by those columns"), so it cannot update a
// pick it inserts in the same commit: the pick is inserted already placed, its company_kinds row inserted before it in
// S1-02's own rows, which picked_kinds_company_kind_fk needs (K-24 0021: (company_id, kind_id) references company_kinds),
// and picked_kinds_company_business_fk holds its business to its company's. A pick on file is placed by an update at the
// version item 79 read, as S1-04's writer places one (default 182 (3)).
//
// The count (default 185; default 199 item (4)): every kept pick the owner has, this walk's (the picked_kinds inserts in
// the walk's rows) and those on file (item 79), a pick kept unless its outcome is not_booked, the caller's person's own
// alone (default 182: picked_kinds.owner_person_id), and a kind counted once (as kinds/answer.ts default 3 keeps one pick
// per kind). The count is by kind, never by pick.
//
// What one walk shares (as T-634's `kinds` wrapper keeps picks, and T-633's walkMatcher one catalog read): the turn
// context the commit hands writesOf, which the walk hands every writer of the run as `writer.turn` and the buttons
// settler as `turn`, keys a WeakMap of the wrapper's placement by part index, and of the item 79 and item 72 answers, each
// read once per walk, a failed read included (so a failure is never read again as an answer). The commit builds a new
// context for each gate run, so a repeat or a re-gate reads and places afresh.
//
// Reads only, never on the call's transaction unless the binding hands its reads that transaction, each awaited before the
// next, never side by side (staging allows a gate call 2 connections). Nothing here writes or logs; what it throws names
// faults and steps (errors.ts), and a failed read throws (reads.ts), so the call fails closed with nothing written.
//
// Defaults used (for ops/QUESTIONS.md), beside reads.ts's R1 to R3:
//   O1. The wrapper reads nothing when S1-02's rows insert no kept pick (S1-74's "Not a service we book", or an answer
//       that names only kinds already picked): it has no pick to place, so the rows go back unchanged whatever the count,
//       and the settler counts and places a pick on file itself if the walk reaches S1-04.
//   O2. A kind counted once with two kept picks (the one kind both inserted and on file, or inserted twice: T-633's writer
//       never does either, kinds/answer.ts default 3) is refused (twoPicksOneKind), since both would land in one company
//       (default 184); never one of them placed and the other left.
//   O3. A kept pick on file already placed in the turn's company is left as it is: the settler gives companies with no
//       row (nothing to place). One placed in any other company is refused (placedElsewhere), never moved.
//   O4. A pick on file that the settler places takes the call's business on its text, draft and block rows too, each
//       updated at the version item 79 read (default 182 (4): "the rows of a pick that gained a business"), so item 79
//       still answers them under the business (K-05 default 180); a row that already carries the business is left.
//   O5. No event-log entry for any row here (default 182: K-08 v1.1 has no kind for a companies, company_kinds or
//       picked_kinds row or a pick's text and draft rows; CQ-56; open gap 164).
//   O6. The settler needs the wrapper's placement for its walk and part (notPlaced without it): S1-02's writer must be
//       bound through the wrapper wherever the settler is bound, as T-634's S1-11 writer needs its `kinds` wrapper.
//   O7. Item 79 is asked for the call's business and the turn's person (CommitTurnContext.businessId and the request's
//       caller), never a request value; a pick the walk's rows insert for another person is refused (notOwnPick).

import type { ReadPickedKindsResponse, PickedKindRead } from "../../../../../db/repo/kinds-reads";
import type { ReadBusinessKindsResponse } from "../../../../../db/repo/catalog-reads";
import type { CommitTurnContext, StateWrite } from "../../../commit/types";
import type { ButtonsSettler, ButtonsSettlers, StepRows, StepWriter } from "../../../commit/walk";
import type { SetupKey } from "../../../gate/framework";
import { CompaniesRefusedError } from "./errors";
import {
  companyKindOnFile,
  draftedDefaults,
  turnCompanyOf,
  type CompaniesReads,
  type KindDefaults,
} from "./reads";

/** The step whose writer the wrapper wraps (S1-02 gives kinds). */
export const S1_02 = "S1-02";

/** The step the settler settles (S1-04 gives companies; K-01 v1 step.gives). */
export const S1_04 = "S1-04";

/** The key S1-04 gives (K-09 README "S1-04 | SetupS1_04 | companies"). */
export const COMPANIES: SetupKey = "companies";

/** What the one-kind pieces read with, bound by the turn face (T-1493, H1a). */
export interface OneKindDeps<Repo = unknown> {
  /** Item 79, item 72 and K-24's catalog by id (reads.ts). */
  readonly reads: CompaniesReads<Repo>;
}

/** The wrapper around S1-02's writer and S1-04's buttons settler, from one createOneKind instance per binding. */
export interface OneKind<Repo = unknown> {
  /** S1-02's writer (T-633's), wrapped: the one kept pick placed on its own insert; any other count, rows unchanged. */
  readonly wrap: (writer: StepWriter<Repo>) => StepWriter<Repo>;
  /** S1-04's buttons settler: rows that give companies for one kept kind, "ask" for two or more, refused for none. */
  readonly settler: ButtonsSettler<Repo>;
  /** The buttons settlers by step id for WalkDeps.buttonsSettlers: S1-04's settler, and none at any other step. */
  readonly buttonsSettlers: ButtonsSettlers<Repo>;
}

/** K-24 picked_kinds.outcome. */
type Outcome = "listed" | "new_work" | "not_booked";

const OUTCOMES: readonly Outcome[] = ["listed", "new_work", "not_booked"];

/** A picked_kinds insert in a walk's rows, as the count reads it. */
interface InsertedPick {
  readonly id: string;
  readonly outcome: Outcome;
  readonly kindId: string | null;
  readonly companyId: string | null;
  readonly businessId: string | null;
}

/** A kept pick as the count reads it: inserted in this walk, or on file (item 79's row). */
interface KeptPick {
  readonly id: string;
  readonly kindId: string;
  readonly outcome: "listed" | "new_work";
  /** Item 79's row when the pick is on file; null when this walk's rows insert it. */
  readonly onFile: PickedKindRead | null;
}

/** The count: the kinds counted, each once, in the order first met, and every kept pick. */
interface KindCount {
  readonly kinds: readonly string[];
  readonly picks: readonly KeptPick[];
}

/** What the wrapper placed on a pick's insert. */
interface Placed {
  readonly pickId: string;
  readonly kindId: string;
  readonly companyId: string;
  /** Whether it put the kind's company_kinds insert before the pick's (false: item 72 showed it on file). */
  readonly companyKind: boolean;
}

/** What the wrapper did for one walk and part: the kept picks S1-02's rows inserted, and what it placed, if anything. */
interface Placement {
  readonly inserted: readonly string[];
  readonly placed: Placed | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A column a state insert may leave out (it takes its default, null here) or give as null or a non-empty string. */
function idOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The picked_kinds inserts in `state`, in order, each held to K-24 v1's shape (pickNotWellFormed) and to the turn's
 * person as its owner (notOwnPick; default O7).
 */
function insertedPicks(state: readonly StateWrite[], personId: string, stepId: string): InsertedPick[] {
  const picks: InsertedPick[] = [];
  for (const write of state) {
    if (write.op !== "insert" || write.table !== "picked_kinds") continue;
    const values: unknown = write.values;
    if (!isRecord(values)) throw new CompaniesRefusedError("pickNotWellFormed", [stepId]);
    const { id, owner_person_id: owner } = values;
    const outcome = OUTCOMES.find((each) => each === values.outcome);
    const kindId = idOrNull(values.kind_id);
    const companyId = idOrNull(values.company_id);
    const businessId = idOrNull(values.business_id);
    if (
      typeof id !== "string" ||
      id === "" ||
      outcome === undefined ||
      kindId === undefined ||
      companyId === undefined ||
      businessId === undefined ||
      (outcome === "not_booked") !== (kindId === null)
    ) {
      throw new CompaniesRefusedError("pickNotWellFormed", [stepId]);
    }
    if (owner !== personId) throw new CompaniesRefusedError("notOwnPick", [stepId]);
    picks.push({ id, outcome, kindId, companyId, businessId });
  }
  return picks;
}

/** A pick the count keeps: any outcome but not_booked, with its kind. */
function keptOf(pick: InsertedPick): KeptPick | null {
  if (pick.outcome === "not_booked" || pick.kindId === null) return null;
  return { id: pick.id, kindId: pick.kindId, outcome: pick.outcome, onFile: null };
}

/**
 * The count (default 185; default 199 item (4)): the person's kept picks on file (item 79's order), then this walk's
 * kept inserts, each kind counted once.
 */
function countOf(
  inserted: readonly KeptPick[],
  onFile: Pick<ReadPickedKindsResponse, "picks">,
  personId: string,
): KindCount {
  const filed: KeptPick[] = [];
  for (const pick of onFile.picks) {
    if (pick.ownerPersonId !== personId || pick.outcome === "not_booked" || pick.kindId === null) continue;
    filed.push({ id: pick.id, kindId: pick.kindId, outcome: pick.outcome, onFile: pick });
  }
  const picks = [...filed, ...inserted];
  return { kinds: [...new Set(picks.map((pick) => pick.kindId))], picks };
}

/** The one kind's one kept pick, or refused when that kind has two (default O2). */
function onlyPick(count: KindCount, stepId: string): KeptPick {
  const [only, other] = count.picks;
  if (only === undefined) throw new CompaniesRefusedError("noKeptPick", [stepId]);
  if (other !== undefined) throw new CompaniesRefusedError("twoPicksOneKind", [stepId]);
  return only;
}

/** The turn's person: who owns the picks (K-09 caller.personId, the turn party's). Exported for T-1481's S1-04 writer. */
export function personOf<Repo>(turn: CommitTurnContext<Repo>, stepId: string): string {
  const { personId } = turn.request.caller;
  if (personId === null) throw new CompaniesRefusedError("noPerson", [stepId]);
  return personId;
}

/**
 * A company kind's K-23 company_kinds insert (default 182 (2)): the company's and the kind's key, `business_id` copied
 * from its company, `trade_name` null, and the kind's facts and switches. Exported for T-1481's S1-04 writer.
 */
export function companyKindInsert(
  companyId: string,
  businessId: string | null,
  kindId: string,
  defaults: KindDefaults,
): StateWrite {
  return {
    op: "insert",
    table: "company_kinds",
    values: {
      company_id: companyId,
      kind_id: kindId,
      business_id: businessId,
      trade_name: null,
      pf_facts: [...defaults.facts],
      pf_switches_a: [...defaults.switchesA],
      pf_switches_b: [...defaults.switchesB],
    },
  };
}

/** `state` with the pick `pickId`'s insert placed in the company and business, its company kind's insert before it. */
function placedState(
  state: readonly StateWrite[],
  pickId: string,
  companyId: string,
  businessId: string,
  companyKind: StateWrite | null,
): StateWrite[] {
  const placed: StateWrite[] = [];
  for (const write of state) {
    if (write.op === "insert" && write.table === "picked_kinds" && write.values.id === pickId) {
      if (companyKind !== null) placed.push(companyKind);
      placed.push({
        op: "insert",
        table: "picked_kinds",
        values: { ...write.values, company_id: companyId, business_id: businessId },
      });
      continue;
    }
    placed.push(write);
  }
  return placed;
}

/**
 * A pick on file placed in a company (default 182 (3)): its update at the version item 79 read, setting its company and,
 * where the company has one, its business (`businessId` null: the company has none yet, so the pick's business stays as
 * it is, null). Exported for T-1481's S1-04 writer.
 */
export function pickPlacement(
  pick: PickedKindRead,
  companyId: string,
  businessId: string | null,
): StateWrite {
  return {
    op: "update",
    table: "picked_kinds",
    key: { id: pick.id },
    expectVersion: pick.version,
    set: businessId === null ? { company_id: companyId } : { company_id: companyId, business_id: businessId },
  };
}

/**
 * The rows of a pick that gained a business (default 182 (4); default O4): each of its text, draft and block rows with no
 * business yet given the business, each at the version item 79 read; a row that already carries one is left. Exported
 * for T-1481's S1-04 writer.
 */
export function gainedBusinessRows(pick: PickedKindRead, businessId: string): StateWrite[] {
  const state: StateWrite[] = [];
  for (const text of pick.texts) {
    if (text.businessId !== null) continue;
    state.push({
      op: "update",
      table: "picked_kind_texts",
      key: { picked_kind_id: pick.id, pf_key: text.pfKey },
      expectVersion: text.version,
      set: { business_id: businessId },
    });
  }
  const { draft } = pick;
  if (draft !== null) {
    if (draft.businessId === null) {
      state.push({
        op: "update",
        table: "new_work_drafts",
        key: { id: draft.id },
        expectVersion: draft.version,
        set: { business_id: businessId },
      });
    }
    for (const block of draft.blocks) {
      if (block.businessId !== null) continue;
      state.push({
        op: "update",
        table: "new_work_draft_blocks",
        key: { draft_id: draft.id, block: block.block },
        expectVersion: block.version,
        set: { business_id: businessId },
      });
    }
  }
  return state;
}

/**
 * A pick on file placed in the company (default 182 (3) and (4); default O4): the pick's update at the version read,
 * then each of its text, draft and block rows with no business yet given the business, each at the version read.
 */
function placedOnFile(pick: PickedKindRead, companyId: string, businessId: string): StateWrite[] {
  return [pickPlacement(pick, companyId, businessId), ...gainedBusinessRows(pick, businessId)];
}

/** S1-04's rows for one kept kind: the state given (none, or the placing rows), giving companies. */
function giving(state: readonly StateWrite[]): StepRows {
  return { state: [...state], stateEvents: [], gives: [COMPANIES], asks: [], messages: [] };
}

/** Whether two lists of ids are the same ids in the same order. */
function sameIds(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

/**
 * The wrapper's placement of the one pick inserted in this walk, as the rows built hold it: its insert in the company
 * and the call's business, its company kind's insert before it when the wrapper made one. Else placementDisagrees.
 */
function checkPlaced(
  state: readonly StateWrite[],
  placed: Placed | null,
  only: KeptPick,
  companyId: string,
  businessId: string,
): void {
  const disagrees = (): CompaniesRefusedError => new CompaniesRefusedError("placementDisagrees", [S1_04]);
  if (placed?.pickId !== only.id || placed.kindId !== only.kindId || placed.companyId !== companyId) {
    throw disagrees();
  }
  const at = state.findIndex(
    (write) => write.op === "insert" && write.table === "picked_kinds" && write.values.id === only.id,
  );
  const insert = state[at];
  if (
    insert?.op !== "insert" ||
    insert.values.company_id !== companyId ||
    insert.values.business_id !== businessId
  ) {
    throw disagrees();
  }
  if (!placed.companyKind) return;
  const kindAt = state.findIndex(
    (write) =>
      write.op === "insert" &&
      write.table === "company_kinds" &&
      write.values.company_id === companyId &&
      write.values.kind_id === only.kindId &&
      write.values.business_id === businessId,
  );
  if (kindAt === -1 || kindAt > at) throw disagrees();
}

/**
 * The one-kind wrapper and S1-04's one-kind settler over `deps` (the top of this file), sharing one walk's reads and
 * placement. Each reads only through `deps.reads`; what it throws (CompaniesRefusedError, CompaniesReadError, or the
 * wrapped writer's own refusal) fails the call closed with nothing written.
 */
export function createOneKind<Repo = unknown>(deps: OneKindDeps<Repo>): OneKind<Repo> {
  const { reads } = deps;
  // Per walk (the turn context the commit hands writesOf): the wrapper's placement by part, and item 79's and item 72's
  // answers, each read once. WeakMaps, so a walk's reads and placement go with its context.
  const placements = new WeakMap<CommitTurnContext<Repo>, Map<number, Placement>>();
  const picksRead = new WeakMap<CommitTurnContext<Repo>, Promise<ReadPickedKindsResponse>>();
  const kindsRead = new WeakMap<CommitTurnContext<Repo>, Promise<ReadBusinessKindsResponse>>();

  /** Item 79 for the walk: the call's business and the turn's person (default O7), read once. */
  const picksOf = (turn: CommitTurnContext<Repo>, personId: string): Promise<ReadPickedKindsResponse> => {
    const known = picksRead.get(turn);
    if (known !== undefined) return known;
    const reading = reads.pickedKinds({ businessId: turn.businessId, personId });
    picksRead.set(turn, reading);
    return reading;
  };

  /** Item 72 for the walk: the call's business, read once, handed the call's repo. */
  const kindsOf = (repo: Repo, turn: CommitTurnContext<Repo>): Promise<ReadBusinessKindsResponse> => {
    const known = kindsRead.get(turn);
    if (known !== undefined) return known;
    const reading = reads.businessKinds(repo, { businessId: turn.businessId });
    kindsRead.set(turn, reading);
    return reading;
  };

  /** A kept pick's kind's facts and switches: a listed kind's from the catalog by id, a drafted kind's (default R2). */
  const defaultsOf = async (
    repo: Repo,
    turn: CommitTurnContext<Repo>,
    pick: KeptPick,
  ): Promise<KindDefaults> =>
    pick.outcome === "listed"
      ? reads.kindDefaults(repo, {
          handleId: turn.turn.handleId,
          businessId: turn.businessId,
          kindId: pick.kindId,
        })
      : draftedDefaults(pick.onFile?.draft ?? null);

  /** The kind's company kind insert, or null when item 72 shows that company kind on file. */
  const companyKindFor = async (
    repo: Repo,
    turn: CommitTurnContext<Repo>,
    companyId: string,
    pick: KeptPick,
  ): Promise<StateWrite | null> => {
    const kinds = await kindsOf(repo, turn);
    if (companyKindOnFile(kinds, companyId, pick.kindId) !== null) return null;
    return companyKindInsert(companyId, turn.businessId, pick.kindId, await defaultsOf(repo, turn, pick));
  };

  const remember = (turn: CommitTurnContext<Repo>, part: number, placement: Placement): void => {
    const byPart = placements.get(turn) ?? new Map<number, Placement>();
    byPart.set(part, placement);
    placements.set(turn, byPart);
  };

  const wrap =
    (writer: StepWriter<Repo>): StepWriter<Repo> =>
    async (call) => {
      if (call.step.id !== S1_02) throw new CompaniesRefusedError("wrongStep", [S1_02, call.step.id]);
      const rows = await writer(call);
      const { turn } = call.writer;
      const personId = personOf(turn, S1_02);
      const inserted = insertedPicks(rows.state, personId, S1_02).flatMap((pick) => keptOf(pick) ?? []);
      const ids = inserted.map((pick) => pick.id);
      // Default O1: no kept pick inserted, nothing to place and nothing read.
      if (inserted.length === 0) {
        remember(turn, call.part.index, { inserted: ids, placed: null });
        return rows;
      }
      const onFile = await picksOf(turn, personId);
      const count = countOf(inserted, onFile, personId);
      if (count.kinds.length !== 1) {
        remember(turn, call.part.index, { inserted: ids, placed: null });
        return rows;
      }
      // One kind, and this walk inserts a kept pick of it: that pick, alone (default O2).
      const only = onlyPick(count, S1_02);
      const company = turnCompanyOf(onFile, personId, turn.businessId);
      if (company === null) throw new CompaniesRefusedError("noTurnCompany", [S1_02]);
      const companyKind = await companyKindFor(call.repo, turn, company.id, only);
      remember(turn, call.part.index, {
        inserted: ids,
        placed: {
          pickId: only.id,
          kindId: only.kindId,
          companyId: company.id,
          companyKind: companyKind !== null,
        },
      });
      const placed: StepRows = {
        ...rows,
        state: placedState(rows.state, only.id, company.id, turn.businessId, companyKind),
      };
      return placed;
    };

  const settler: ButtonsSettler<Repo> = async (call) => {
    if (call.step.id !== S1_04) throw new CompaniesRefusedError("wrongStep", [S1_04, call.step.id]);
    const { turn } = call;
    const personId = personOf(turn, S1_04);
    const placement = placements.get(turn)?.get(call.part.index);
    if (placement === undefined) throw new CompaniesRefusedError("notPlaced", [S1_04]);
    const disagrees = (): CompaniesRefusedError => new CompaniesRefusedError("placementDisagrees", [S1_04]);
    const inserted = insertedPicks(call.rows.state, personId, S1_04).flatMap((pick) => keptOf(pick) ?? []);
    if (
      !sameIds(
        inserted.map((pick) => pick.id),
        placement.inserted,
      )
    ) {
      throw disagrees();
    }
    const onFile = await picksOf(turn, personId);
    const count = countOf(inserted, onFile, personId);
    if (count.kinds.length !== 1) {
      if (placement.placed !== null) throw disagrees();
      if (count.kinds.length === 0) throw new CompaniesRefusedError("noKeptPick", [S1_04]);
      return "ask";
    }
    const only = onlyPick(count, S1_04);
    const company = turnCompanyOf(onFile, personId, turn.businessId);
    if (company === null) throw new CompaniesRefusedError("noTurnCompany", [S1_04]);
    if (only.onFile === null) {
      // Inserted in this walk: the wrapper placed it on its own insert, so S1-04 adds no row.
      checkPlaced(call.rows.state, placement.placed, only, company.id, turn.businessId);
      return giving([]);
    }
    if (placement.placed !== null) throw disagrees();
    const pick = only.onFile;
    if (pick.companyId !== null) {
      // Default O3: placed already, in the turn's company, or refused.
      if (pick.companyId === company.id && pick.businessId === turn.businessId) return giving([]);
      throw new CompaniesRefusedError("placedElsewhere", [S1_04]);
    }
    const companyKind = await companyKindFor(call.repo, turn, company.id, only);
    return giving([
      ...(companyKind === null ? [] : [companyKind]),
      ...placedOnFile(pick, company.id, turn.businessId),
    ]);
  };

  const buttonsSettlers: ButtonsSettlers<Repo> = (stepId) => (stepId === S1_04 ? settler : null);

  return { wrap, settler, buttonsSettlers };
}
