// S1-04's read-only step writer (T-1481, T-634 part 2a; card 12 of ops/reviews/s1-04-design/check-merge.json, its
// decision (c); DL-999, DL-1088; K-09 README v1.11 defaults 182 to 184 and 190, as its round 2 corrects them): which of
// the owner's kinds of work share one company, with one tax number (MASTER-FLOW-A lines 88 to 100: "Reply 1 Some share
// one, 2 All share one, 3 Each is its own"). A StepWriter closure (actions/src/commit/walk/writes.ts StepWriter), exported
// for the binding card (T-1484, H1b) to bind at S1-04 by step id: it returns S1-04's rows and writes nothing, so the
// commit writes them in the turn's one commit, or nothing at all.
//
// What it reads, each through this folder's CompaniesReads port (reads.ts), each awaited before the next, never side by
// side (staging allows a gate call 2 connections): item 79 (the caller's person's picks and companies), item 72 handed
// the call's repo (which company kinds are on file), K-24's catalog by id handed the call's repo (a listed kind's facts
// and switches, for each company kind it inserts) and, for "Some share one" alone, each listed kept kind's name by id
// (default 190's matching). A failed read throws (CompaniesReadError, or what the port throws), so the call fails closed
// with nothing written; a failed read is never read as "none".
//
// What it writes (default 182), for the button chosen (the choice's branch, word for word: default 180's table):
//   - Groups. "Each is its own" puts each kept pick alone; "All share one" puts every kept pick together; "Some share one"
//     puts the picks `shared_kinds` names together (at least two, each word naming exactly one kept pick: default 190)
//     and each other kept pick alone.
//   - The company under way. The group that holds the first kind named takes the company the turn runs under (the
//     caller's person's own company whose business is the call's business: turnCompanyOf); every other group is a new
//     company (`company-s1-04-<turn key>-<n>`, n from 1 in the groups' order: the walk's rowId), owned by the caller's
//     person, with no business until its own S1-09 (MASTER-FLOW-A line 93).
//   - Rows, in the order the foreign keys need (K-09 tool-api.rules.mjs S1_04_WRITE_ORDER): (1) companies: the company
//     under way updated to the name at the version read whenever the owner named its group (default 183), then each new
//     company inserted; (2) company_kinds: one per kept pick whose company and kind are not on file together, business
//     copied from its company, trade name null, a listed kind's facts and switches from the catalog by id and a drafted
//     kind's from its draft (companyKindInsert, draftedDefaults); (3) picked_kinds: each kept pick updated at the version
//     read with its company and, where its company has one, its business (pickPlacement); (4) the rows of the picks that
//     gained a business, each at the version read (gainedBusinessRows): every picked_kind_texts row, then every
//     new_work_drafts row, then every new_work_draft_blocks row. It gives `companies`.
//   - Refused, with nothing returned (CompaniesRefusedError, default 184): a `shared_kinds` word that names no kept pick
//     or two (sharedWordNoPick, sharedWordTwoPicks); fewer than two picks in the shared group (sharedGroupTooSmall); a
//     second shared group (secondSharedGroup); "Some share one" with no words to match (noSharedKinds); two picks of one
//     kind in one company (twoPicksOneKind); no kept pick (noKeptPick); no company of the caller's person under the
//     call's business (noTurnCompany); a kept pick placed already (alreadyPlaced, default 190); a branch that is none of
//     the three buttons (unknownBranch); a call at another step (wrongStep) or with no person (noPerson); and any answer
//     that needs a second company while the binding's flag says the party rule is not live (secondCompany: K-05 v1.11
//     item 52, default 98, would answer that phone's next turn as several businesses, so it would park the phone and its
//     STOP; open gap 149). With the flag off only an answer whose groups come to one company is saved, "All share one"
//     in practice; `commit-s1-04-some-share.json` shows the rows with the flag on.
//
// Whose rows it may write (default 182, the security reviewer's): only the caller's person's own picks (item 79's picks
// whose owner is that person), their text, draft and block rows, the company that person owns under the call's business,
// and new companies owned by that person with no business; never another person's row and never a new company under a
// business. The owner's words reach only a company's name (company_name's value, or the pick's own S1-02 words), never a log or
// an error: what it throws names faults and steps (errors.ts).
//
// Defaults used (for ops/QUESTIONS.md), beside one-kind.ts's O1 to O7 and reads.ts's R1 to R3:
//   W1. The kept picks are item 79's alone: the caller's person's (picked_kinds.owner_person_id), outcome listed or
//       new_work; a not_booked pick is never placed (picked_kinds_not_booked_unplaced), and another person's pick under
//       the call's business is left out, never refused. A writer's call carries no rows built before it, and an answered
//       S1-04's walk starts at S1-04 (default 181), so the turn's own picks are none: S1-02 placed them in an earlier turn.
//   W2. The first kind named is the kept pick of the lowest position (S1-02 sets the first kind named up first), item
//       79's order (picked_at, position, id) on a tie; its group takes the company the turn runs under (open gap 151).
//   W3. The groups' order: by each group's first kind named; the new companies' ids follow it. Within each kind of row
//       (company kinds, pick updates) the picks go in the kept picks' order (W2's). A gained business's rows go table by
//       table, as default 182 (4) lists them and buttonsAnswerCommit's S1_04_WRITE_ORDER holds them: every pick's text
//       rows, then every draft, then every draft block; within one table the picks go in the kept picks' order, and a
//       pick's rows in the order item 79 answers them (texts by pf key, blocks by number), as gainedBusinessRows takes
//       them. The commit compares and sets each by its own key and version, so no finer order is needed
//       (commit-s1-04.json lists the same rows with its texts in the pf keys' own order).
//   W4. A company's name (defaults 182 and 183): company_name's value as given (K-02 fieldValue: the name limit 6
//       re-parsed from its words, and the name buttonsAnswerCommit checks), never its source words; default 190 reads
//       source words for shared_kinds alone. It names the shared group's company: the one group's under "All share
//       one", the shared group's under "Some share one". When that group takes the company under way, that company is
//       updated to the name at the version read, always, even when the name equals its stored one (default 183: "that
//       company's name is updated to it"); with no name it keeps its stored name and is not written. A new company with
//       no name takes its group's first kind's S1-02 words as stored (picked_kinds.words), until its S1-09 reads the
//       listing (open gap 152).
//   W5. A field is read only under a button that carries it (default 180's table): shared_kinds under "Some share one",
//       company_name under "Some share one" and "All share one"; a field under "Each is its own" is not read (limit 6
//       holds a part's fields to its choice). A shared_kinds whose words are blank, or a company_name whose value is
//       blank or no text, counts as not given.
//   W6. "A second shared group" (default 184) is shared_kinds, or company_name, given twice in the part, each given as
//       W5 reads it: one field's words are one group, never split inside (default 190 reads them as words, not parts).
//   W7. A kind's name for default 190's matching: a listed kind's kinds.name, read by id through readTurnState (reads.ts
//       kindNames; item 79 answers no kind's name), and a drafted kind's the pick's own words (K-24 kinds.name: "a drafted
//       kind's name in the owner's words"). "Some share one" whose words name every kept pick is one group, so one
//       company, and is saved with the flag off (default 184: "only an answer whose groups come to one company").
//   W8. A kept pick that carries a business but no company is refused as alreadyPlaced, as a placed one is (default 190):
//       S1-04 gives a pick its business with its company, and moving its rows off a business is refused by the commit
//       (db/repo/commit-turn.ts default 16).
//   W9. The party rule's flag (`partyRuleLive`) is on only when the binding hands in true; left out, or anything else,
//       it is off (default 184: "off unless the caller sets it"). It is checked once the groups are known, before item
//       72 or the catalog is read.
//   W10. No event-log entry for any row (stateEvents empty): default 182 as K-09 v1.11's round 2 item 5 corrects it
//       (K-08 v1.1 has no kind for these rows; CQ-56; open gap 164), which the card's "Each with its event-log entry"
//       predates; the commit writes its own entries for the questions, clock rows and outbox rows.
//   W11. A company kind on file (item 72 under the call's business) is kept, never written again (staging's roster
//       business keeps its seeded barber kind); a trade name is always null (line 92's are a later card).

import type { PickedKindRead } from "../../../../../db/repo/kinds-reads";
import type { StateWrite } from "../../../commit/types";
import type { StepRows, StepWriter, StepWriterCall } from "../../../commit/walk";
import { meets, words } from "../../../domain/kind-matcher";
import { CompaniesRefusedError } from "./errors";
import { COMPANIES, S1_04, companyKindInsert, gainedBusinessRows, personOf, pickPlacement } from "./one-kind";
import {
  companyKindOnFile,
  draftedDefaults,
  turnCompanyOf,
  type CompaniesReads,
  type KindDefaults,
} from "./reads";

/** S1-04's three buttons, word for word (MASTER-FLOW-A line 97; K-09 README default 180's table). */
export const SOME_SHARE_ONE = "Some share one";
export const ALL_SHARE_ONE = "All share one";
export const EACH_IS_ITS_OWN = "Each is its own";

/** The fields default 180's table lists (K-01 answerField names). */
export const SHARED_KINDS = "shared_kinds";
export const COMPANY_NAME = "company_name";

/** What S1-04's writer reads with, bound by the binding card (T-1484, H1b). */
export interface CompaniesWriterDeps<Repo = unknown> {
  /** Item 79, item 72 and K-24's catalog by id (reads.ts), as the one-kind path reads them. */
  readonly reads: CompaniesReads<Repo>;
  /**
   * Whether the party rule is live (default 184; open gap 149): true lets an answer write a second company; left out, or
   * anything but true, it is off and any such answer is refused (secondCompany). Staging sets it only once K-05's party
   * version and its db/repo read are live (cards 17 to 19).
   */
  readonly partyRuleLive?: boolean;
}

type Button = typeof SOME_SHARE_ONE | typeof ALL_SHARE_ONE | typeof EACH_IS_ITS_OWN;

const BUTTONS: readonly Button[] = [SOME_SHARE_ONE, ALL_SHARE_ONE, EACH_IS_ITS_OWN];

/** The tables of a pick that gained a business, in the order the rows go (default 182 (4); K-09 S1_04_WRITE_ORDER). */
const AFTER_PICKS: readonly string[] = ["picked_kind_texts", "new_work_drafts", "new_work_draft_blocks"];

/** A kept pick: one of the caller's person's own, listed or new work, with its kind (W1). */
interface KeptPick {
  readonly pick: PickedKindRead;
  readonly kindId: string;
  readonly outcome: "listed" | "new_work";
}

/** One group of kept picks, which lands in one company; `shared` when the owner's company_name names it (W4). */
interface Group {
  readonly picks: readonly KeptPick[];
  readonly shared: boolean;
}

/** Where a group lands: the company under way (its business the call's) or a new company with no business. */
interface Landing {
  readonly companyId: string;
  readonly businessId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text `key` (`words` or `value`) of each field named `name` the part carries, blank or non-text ones left out (W5). */
function fieldTexts(call: Pick<StepWriterCall, "part">, name: string, key: "words" | "value"): string[] {
  const part: unknown = call.part.part;
  if (!isRecord(part) || !Array.isArray(part.fields)) return [];
  const found: string[] = [];
  for (const field of part.fields as unknown[]) {
    if (!isRecord(field) || field.name !== name) continue;
    const text = field[key];
    if (typeof text === "string" && text.trim() !== "") found.push(text);
  }
  return found;
}

/**
 * The answer's fields as its button carries them, each once or none: the shared kinds' source words, trimmed (default
 * 190), and the company's name, company_name's value as given (W4).
 */
function fieldsOf(
  call: Pick<StepWriterCall, "part">,
  button: Button,
): { shared: string | null; name: string | null } {
  if (button === EACH_IS_ITS_OWN) return { shared: null, name: null };
  const names = fieldTexts(call, COMPANY_NAME, "value");
  const shared =
    button === SOME_SHARE_ONE ? fieldTexts(call, SHARED_KINDS, "words").map((each) => each.trim()) : [];
  if (names.length > 1 || shared.length > 1) throw new CompaniesRefusedError("secondSharedGroup", [S1_04]);
  if (button === SOME_SHARE_ONE && shared.length === 0) {
    throw new CompaniesRefusedError("noSharedKinds", [S1_04]);
  }
  return { shared: shared[0] ?? null, name: names[0] ?? null };
}

/** The caller's person's kept picks in item 79's answer, the first kind named first (W1, W2; a stable sort). */
function keptPicksOf(picks: readonly PickedKindRead[], personId: string): KeptPick[] {
  const kept: KeptPick[] = [];
  for (const pick of picks) {
    if (pick.ownerPersonId !== personId || pick.outcome === "not_booked" || pick.kindId === null) continue;
    kept.push({ pick, kindId: pick.kindId, outcome: pick.outcome });
  }
  return kept.sort((first, second) => first.pick.position - second.pick.position);
}

/** A kept pick's two names as default 190 reads them: its own S1-02 words and its kind's name, as the matcher's words. */
function nameWordsOf(kept: KeptPick, kindNames: ReadonlyMap<string, string>): string[] {
  const kindName = kept.outcome === "listed" ? (kindNames.get(kept.kindId) ?? "") : kept.pick.words;
  return [...words(kept.pick.words), ...words(kindName)];
}

/**
 * The picks `shared` names (default 190): each word, read as the kind matcher reads words, names the kept picks one of
 * whose names has a word it meets; every word must name exactly one, and the picks named, at least two, are the group.
 */
function sharedGroupOf(
  shared: string,
  kept: readonly KeptPick[],
  kindNames: ReadonlyMap<string, string>,
): KeptPick[] {
  const asked = words(shared);
  if (asked.length === 0) throw new CompaniesRefusedError("noSharedKinds", [S1_04]);
  const names = kept.map((each) => nameWordsOf(each, kindNames));
  const named = new Set<number>();
  for (const word of asked) {
    const hits = names.flatMap((each, index) => (each.some((name) => meets(word, name) > 0) ? [index] : []));
    const [hit, other] = hits;
    if (hit === undefined) throw new CompaniesRefusedError("sharedWordNoPick", [S1_04]);
    if (other !== undefined) throw new CompaniesRefusedError("sharedWordTwoPicks", [S1_04]);
    named.add(hit);
  }
  if (named.size < 2) throw new CompaniesRefusedError("sharedGroupTooSmall", [S1_04]);
  return kept.filter((_, index) => named.has(index));
}

/** The groups for the button, in the groups' order (W3): each led by its first kind named. */
function groupsOf(button: Button, kept: readonly KeptPick[], shared: readonly KeptPick[]): Group[] {
  if (button === ALL_SHARE_ONE) return [{ picks: [...kept], shared: true }];
  if (button === EACH_IS_ITS_OWN) return kept.map((each) => ({ picks: [each], shared: false }));
  const groups: Group[] = [];
  for (const each of kept) {
    if (!shared.includes(each)) groups.push({ picks: [each], shared: false });
    else if (shared[0] === each) groups.push({ picks: [...shared], shared: true });
  }
  return groups;
}

/** A new company's name with none given (default 183; W4): its group's first kind's own S1-02 words, as stored. */
function firstWordsOf(group: Group): string {
  const [first] = group.picks;
  // Every group holds a kept pick (groupsOf); one with none would have no company to name, so it is refused.
  if (first === undefined) throw new CompaniesRefusedError("noKeptPick", [S1_04]);
  return first.pick.words;
}

/**
 * S1-04's writer over `deps` (the top of this file): the rows that place the caller's person's kept picks in the groups
 * the chosen button and its fields give. It reads only through `deps.reads` and writes nothing; what it throws
 * (CompaniesRefusedError, CompaniesReadError, or what a read port throws) fails the call closed with nothing written.
 */
export function companiesWriter<Repo = unknown>(deps: CompaniesWriterDeps<Repo>): StepWriter<Repo> {
  const { reads } = deps;
  const partyRuleLive = deps.partyRuleLive === true;

  return async (call: StepWriterCall<Repo>): Promise<StepRows> => {
    if (call.step.id !== S1_04) throw new CompaniesRefusedError("wrongStep", [S1_04, call.step.id]);
    const { turn } = call.writer;
    const personId = personOf(turn, S1_04);
    const button = BUTTONS.find((each) => each === call.choice.branch);
    if (button === undefined) throw new CompaniesRefusedError("unknownBranch", [S1_04]);
    const fields = fieldsOf(call, button);

    // Item 79: the caller's person's picks and companies, under the call's business (default O7's reading).
    const onFile = await reads.pickedKinds({ businessId: turn.businessId, personId });
    const kept = keptPicksOf(onFile.picks, personId);
    if (kept.length === 0) throw new CompaniesRefusedError("noKeptPick", [S1_04]);
    if (kept.some((each) => each.pick.companyId !== null || each.pick.businessId !== null)) {
      throw new CompaniesRefusedError("alreadyPlaced", [S1_04]);
    }
    const underWay = turnCompanyOf(onFile, personId, turn.businessId);
    if (underWay === null) throw new CompaniesRefusedError("noTurnCompany", [S1_04]);

    let shared: KeptPick[] = [];
    if (fields.shared !== null) {
      const listed = kept.filter((each) => each.outcome === "listed").map((each) => each.kindId);
      const kindNames = await reads.kindNames(call.repo, {
        handleId: turn.turn.handleId,
        businessId: turn.businessId,
        kindIds: [...new Set(listed)],
      });
      shared = sharedGroupOf(fields.shared, kept, kindNames);
    }
    const groups = groupsOf(button, kept, shared);
    for (const group of groups) {
      const kinds = group.picks.map((each) => each.kindId);
      if (new Set(kinds).size !== kinds.length) throw new CompaniesRefusedError("twoPicksOneKind", [S1_04]);
    }
    if (groups.length > 1 && !partyRuleLive) throw new CompaniesRefusedError("secondCompany", [S1_04]);

    // (1) companies: the company under way, updated to the name when named; each other group a new company, no business.
    const companies: StateWrite[] = [];
    const landing = new Map<KeptPick, Landing>();
    groups.forEach((group, index) => {
      const name = group.shared ? fields.name : null;
      let lands: Landing;
      if (index === 0) {
        lands = { companyId: underWay.id, businessId: turn.businessId };
        if (name !== null) {
          companies.push({
            op: "update",
            table: "companies",
            key: { id: underWay.id },
            expectVersion: underWay.version,
            set: { name },
          });
        }
      } else {
        lands = { companyId: call.writer.rowId("company"), businessId: null };
        companies.push({
          op: "insert",
          table: "companies",
          values: {
            id: lands.companyId,
            owner_person_id: personId,
            name: name ?? firstWordsOf(group),
            business_id: null,
          },
        });
      }
      for (const each of group.picks) landing.set(each, lands);
    });
    // Every kept pick is in one group; the rows below go in the kept picks' order (W3).
    const placed = kept.flatMap((each) => {
      const lands = landing.get(each);
      return lands === undefined ? [] : [{ each, lands }];
    });

    // (2) company_kinds: one per placed pick whose company and kind are not on file together (item 72; W11).
    const onFileKinds = await reads.businessKinds(call.repo, { businessId: turn.businessId });
    const companyKinds: StateWrite[] = [];
    for (const { each, lands } of placed) {
      if (companyKindOnFile(onFileKinds, lands.companyId, each.kindId) !== null) continue;
      const defaults: KindDefaults =
        each.outcome === "listed"
          ? await reads.kindDefaults(call.repo, {
              handleId: turn.turn.handleId,
              businessId: turn.businessId,
              kindId: each.kindId,
            })
          : draftedDefaults(each.pick.draft);
      companyKinds.push(companyKindInsert(lands.companyId, lands.businessId, each.kindId, defaults));
    }

    // (3) the picks placed at the version read; (4) then the rows of each pick that gained a business, table by table:
    // every text row, then every draft, then every draft block (W3).
    const picks = placed.map(({ each, lands }) =>
      pickPlacement(each.pick, lands.companyId, lands.businessId),
    );
    const rowsGained = placed.flatMap(({ each, lands }) =>
      lands.businessId === null ? [] : gainedBusinessRows(each.pick, lands.businessId),
    );
    const gained = [...rowsGained].sort(
      (first, second) => AFTER_PICKS.indexOf(first.table) - AFTER_PICKS.indexOf(second.table),
    );

    return {
      state: [...companies, ...companyKinds, ...picks, ...gained],
      stateEvents: [],
      gives: [COMPANIES],
      asks: [],
      messages: [],
    };
  };
}
