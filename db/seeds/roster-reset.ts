// T-1517: a staging-only reset of a roster phone, so its next text starts sign-up again at S1-01, with nothing of its old
// sign-up deleted (C-202, staging's seeded state; DL-1033 ruling 9; ops/reviews/live-reply-faults/rule-onekind.json card
// 13 with check-onekind.json point 3). The user's phone holds an open S1-04 question asked of a one-kind owner (DL-1032)
// and one plumbing pick with no company. Nothing on staging takes that question as an answer or moves it, and the
// roster-owner set (T-1450, roster-owner.ts) refuses a handle with a live open question, so the phone cannot sign up
// again. For each roster phone on STAGING_LINQ_ALLOWLIST that has something live, this set closes what is live and gives
// the phone a fresh stand-in business head, the rows roster-owner writes under ids of a new generation:
//   open_questions  each live question sent to the phone's handle (status waiting or open, the guard's "live":
//                   db/repo/targets.ts) is withdrawn: status withdrawn and closed_at now, version raised by one (K-04 v1
//                   open_questions: "waiting, open, answered, defaulted or withdrawn"; arch 02 line 123, a question taken
//                   back, so no clock arms). Never answered or defaulted: nothing was answered, and no safe default ran
//   clock_rows      each live clock (state waiting or armed) of the handle, or of one of the handle's questions, is
//                   cancelled: state cancelled and cancelled_at now, version raised by one (K-04 v1 clock_rows)
//   businesses      biz-roster-owner-<n>-g<k>: roster-owner's business head (the skeleton seed's, value for value, version
//                   included), but its id
//   business_setup  that business's K-23 v1 setup row exactly as roster-owner writes it: its business_id alone, control
//                   not proven
//   persons         person-roster-owner-<n>-g<k>, with no name and no language, as first sight writes a person
//   companies       company-roster-owner-<n>-g<k>: roster-owner's company, value for value, owned by that person and naming
//                   that business
//   company_kinds   none (DL-1048): a new owner has no kind of work until S1-02 names one. roster-owner's barber
//                   (roster-owner.ts:26) is not copied, since the one-kind path's S1-04 settler would leave it beside the
//                   named kind, and later steps (services per kind) would then ask about barbering
//   person_handles  the handle's one link moves to the new person: the old person's link is removed and the new one added,
//                   as K-04 allows ("Rows are added or removed, never updated": migration 0004; 0012 grants rosie_job
//                   DELETE on person_handles for exactly this, and on no other table)
// Here <n> is the entry's place on the list (from 1) and <k> the next generation: roster-owner's ids are generation 1, and
// each reset of the place adds one. The ids are the set's own, never made from the number, and never parsed: the place's
// newest generation is found by asking for each generation's business id in turn. Why a new person and not only a new
// business: K-05 v1.19 item 79 (readPickedKinds) reads every pick of the turn's business and every pick of the turn's
// person with no business, and the phone's plumbing pick has none (S1-04 places a pick), so under the same person the old
// pick would stay on file for the new sign-up; under a new person it stays with the old one, as history.
//
// What stays, as history, untouched: the old business, its setup row, company and kind of work; the old person, its
// roles, picks, their text blocks and drafts, its companies and its sealing key; every turn, outbox row and part, thread,
// message and event_log row; the phone row (read for its stopped flag alone, never written) and the handle. Nothing is
// deleted but the one person_handles link the move removes. The closed questions keep their person, handle, business,
// options, versions and bundle, and the cancelled clocks what they fire, so the old sign-up reads as it ended.
//
// The reset reason: K-04 has no column for a reason, so it is carried by the closing states themselves, as K-04 allows
// them: withdrawn, never answered or defaulted (no answer was given and no safe default ran), with closed_at; and
// cancelled, never fired, with cancelled_at. The person the handle's link moved from, and the business it moved off, are
// the closed questions' own person_id and business_id.
//
//   const result = await seedRosterReset(sql);   // result.tables.businesses: { rows: 1, inserted: 1, kept: 0 }
//
// The list: STAGING_LINQ_ALLOWLIST, read by name at run time and split by roster-owner's own rosterNumbers, so each refusal
// of the list is that set's, word for word (a RosterOwnerSeedError, before anything is read or written). A number stands
// for its place alone: it is read from the database only to find its handle (handles_address_key), as roster-owner reads
// it, and is never written, answered or printed.
//
// Then, in one transaction as the job role rosie_job with no business scope (T-191), as roster-owner writes:
//   1. For each place, the handle that holds its number, the handle's live questions and live clocks, read and locked
//      (FOR UPDATE). A place with no handle, or none live, is left as it is: nothing is read of it beyond that and nothing
//      written ("nothing live").
//   2. Each place with something live is checked, and the whole set refuses, writing nothing for any place, naming every
//      problem by its entry's place alone: its handle is no phone handle, or has not one person; its person holds a role
//      (live or ended) or owns anything but its place's newest company (roster-owner's checks: the phone is a test owner
//      as roster-owner or this set left it); its place's roster business does not exist yet (roster-owner seeds it); a
//      live question or clock names another business (only the phone's own sign-up is closed here); its handle has a
//      booking (bookings are never closed here); its phone is stopped (a recorded STOP is never reset); the next
//      generation's business, company or person id is held already; two places' handles are one person's.
//   3. The writes, in the order the foreign keys need: the questions withdrawn and the clocks cancelled (each update
//      compares the state it read and must touch every row it read), the new head's rows inserted (a clash on any key is
//      an error that rolls everything back), then the link moved (exactly one row removed, one added).
//   4. Each reset place read again, refusing and rolling everything back unless it is a test owner as roster-owner's
//      checks require of its own ids, here the new generation's: the number's handle is the phone handle, whose one person
//      is the new person, with no role, owning the new company alone, naming the new business, which holds no live owner
//      role; the guard finds a first text (K-05 v1.2 handleTargets: no live open question and no booking); no live clock
//      of the handle is left; the phone is not stopped. So readTurnParty answers atBusiness with the new business (K-05
//      v1.11 default 100, which reads no kind of work), readPickedKinds finds no pick for the new business and person, the
//      new company holds no kind of work, and JOIN is a first text that the frontier answers with S1-02's question (K-02
//      v1.1 default 9; K-09 README default 130).
// Idempotent: a place with nothing live is never touched, so a second run, with nothing live, writes nothing and says so
// (every table 0 rows, and each place answered nothingLive). Nothing is printed, and no error names a number or a value of
// a row: the runner (T-201) prints the counts this returns, the new head's rows alone (as staging-testers' ended listings
// are not printed, the closed questions and clocks and the moved link are counted in the result, not by the runner).
//
// It runs only when named, `npm run seed:staging -- --set roster-reset` (seed-staging.sh hands it the list by name, on that
// run's line alone, as it hands it to roster-owner), never in D-017's run, and only on staging or a local database (the
// runner's own refusal). It reads and writes the database alone: the handle's actor is T-1452's to reset (DL-944), never
// here. After a reset, roster-owner itself refuses the place (its ids are generation 1's, and the phone's person now owns
// the new generation's company); roster-owner-setup keeps generation 1's setup row as it is.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { handleTargetsIn } from "../repo/targets";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import {
  ALLOWLIST_VARIABLE,
  type RosterOwnerBusinessSetupRow,
  type RosterOwnerIds,
  type RosterOwnerPersonRow,
  rosterNumbers,
  rosterOwnerIds,
} from "./roster-owner";
import {
  type SkeletonBusinessRow,
  type SkeletonCompanyRow,
  type SkeletonPersonHandleRow,
  SKELETON_ROWS,
} from "./skeleton";

/** The most generations one place may have: a cap on the search for its newest, never reached by a test phone. */
export const MAX_GENERATION = 99;

/** The ids of a place's business head at one generation: roster-owner's at 1, the same with -g<k> after them from 2. */
export function rosterResetIds(place: number, generation: number): Omit<RosterOwnerIds, "handleId"> {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
    throw new RangeError(`a generation is a whole number from 1 to ${String(MAX_GENERATION)}`);
  }
  const first = rosterOwnerIds(place);
  if (generation === 1) {
    return { businessId: first.businessId, companyId: first.companyId, personId: first.personId };
  }
  const suffix = `-g${String(generation)}`;
  return {
    businessId: `${first.businessId}${suffix}`,
    companyId: `${first.companyId}${suffix}`,
    personId: `${first.personId}${suffix}`,
  };
}

/** The set's rows, table by table, in the order their foreign keys need: one row of each for each place reset. */
export interface RosterResetSeedRows {
  readonly businesses: readonly SkeletonBusinessRow[];
  readonly business_setup: readonly RosterOwnerBusinessSetupRow[];
  readonly persons: readonly RosterOwnerPersonRow[];
  readonly companies: readonly SkeletonCompanyRow[];
  readonly person_handles: readonly SkeletonPersonHandleRow[];
}

export type RosterResetSeedTable = keyof RosterResetSeedRows;

/** A business head by ids alone: its business, its company and the person who owns it. */
export interface RosterHead {
  readonly businessId: string;
  readonly companyId: string;
  readonly personId: string;
}

/** What the set did at one place of the list, by ids alone (never its number), in the list's order. */
export type RosterResetPlace =
  | {
      /** Its place on STAGING_LINQ_ALLOWLIST, from 1. */
      readonly place: number;
      /** No handle holds its number, or its handle has no live question and no live clock: nothing was written. */
      readonly outcome: "nothingLive";
      /** The handle that holds the number, or null for none. */
      readonly handleId: string | null;
    }
  | {
      readonly place: number;
      /** Its live questions withdrawn, its live clocks cancelled, and the handle moved to a fresh head. */
      readonly outcome: "reset";
      readonly handleId: string;
      /** The head the handle wrote under before, kept as it was. */
      readonly from: RosterHead & { readonly generation: number };
      /** The fresh head the handle writes under now. */
      readonly to: RosterHead & { readonly generation: number };
      /** The questions withdrawn, in id order. */
      readonly withdrawn: readonly string[];
      /** The clocks cancelled, in id order. */
      readonly cancelled: readonly string[];
    };

export interface RosterResetSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fresh heads' rows: one of each table for each place reset (none when nothing was live). */
  readonly tables: Readonly<Record<RosterResetSeedTable, CoreSeedTableCount>>;
  /** What was closed, and the links removed by the move: none when nothing was live. */
  readonly closed: {
    readonly open_questions: number;
    readonly clock_rows: number;
    readonly person_handles: number;
  };
  readonly places: readonly RosterResetPlace[];
}

export interface RosterResetSeedOptions {
  /** Where STAGING_LINQ_ALLOWLIST is read. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The set refused, writing nothing. Its message names places alone: no number, no part of the list, no row's value. */
export class RosterResetSeedError extends Error {
  override readonly name = "RosterResetSeedError";
}

const WHEN =
  "this set resets a roster phone that roster-owner made a test owner (or this set reset before), whose person holds " +
  "no role and owns its place's newest company alone, with no booking and no STOP, and whose live questions and clocks " +
  "are its own sign-up's, with each number at the place it held when roster-owner ran";

const refused = (why: string): RosterResetSeedError =>
  new RosterResetSeedError(`the roster reset seed refused, writing nothing: ${why}`);

const counted = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** "entry 2": a place on the list, never its value. */
const entryOf = (place: number): string => `entry ${String(place)}`;

/** T-1148's rows for tp-01, the values roster-owner gives every roster phone's rows, and so this set too. */
function skeletonRow<T>(rows: readonly T[], table: string): T {
  const [row, ...more] = rows;
  if (row === undefined || more.length > 0) {
    throw new Error(`the skeleton seed has not one ${table} row, whose values this set takes`);
  }
  return row;
}

const BUSINESS = skeletonRow(SKELETON_ROWS.businesses, "businesses");
const COMPANY = skeletonRow(SKELETON_ROWS.companies, "companies");

/** A place with something live, as read and checked before any write. */
interface Plan {
  readonly place: number;
  readonly number: string;
  readonly handleId: string;
  readonly from: RosterHead & { readonly generation: number };
  readonly to: RosterHead & { readonly generation: number };
  readonly withdrawn: readonly string[];
  readonly cancelled: readonly string[];
}

/** The handle that holds a number (handles_address_key), or null. */
async function handleAt(tx: Tx, number: string): Promise<{ id: string; kind: string } | null> {
  const [found] = await tx<
    { id: string; kind: string }[]
  >`select id, kind from handles where address = ${number}`;
  return found ?? null;
}

/** The people who write from a handle, in id order. */
async function peopleOf(tx: Tx, handleId: string): Promise<string[]> {
  const links = await tx<{ person_id: string }[]>`
    select person_id from person_handles where handle_id = ${handleId} order by person_id collate "C"
  `;
  return links.map((link) => link.person_id);
}

/** How many roles a person holds, live or ended, at any business. */
async function rolesOf(tx: Tx, personId: string): Promise<number> {
  const [row] = await tx<
    { n: number }[]
  >`select count(*)::int as n from person_roles where person_id = ${personId}`;
  return row?.n ?? 0;
}

/** The companies a person owns, by id and business, in id order. */
async function companiesOf(tx: Tx, personId: string): Promise<{ id: string; business_id: string | null }[]> {
  const companies = await tx<{ id: string; business_id: string | null }[]>`
    select id, business_id from companies where owner_person_id = ${personId} order by id collate "C"
  `;
  return [...companies];
}

/** Whether a row with this id is in this table (a table name of this file's own, never a request's). */
async function held(tx: Tx, table: "businesses" | "companies" | "persons", id: string): Promise<boolean> {
  const [row] = await tx<{ id: string }[]>`select id from ${tx(table)} where id = ${id}`;
  return row !== undefined;
}

/** The place's newest generation: the highest whose business exists, from 1; 0 when roster-owner has not seeded it. */
async function newestGeneration(tx: Tx, place: number): Promise<number> {
  let newest = 0;
  for (let generation = 1; generation <= MAX_GENERATION; generation += 1) {
    if (!(await held(tx, "businesses", rosterResetIds(place, generation).businessId))) {
      break;
    }
    newest = generation;
  }
  return newest;
}

/** The handle's live questions (the guard's live: waiting or open), locked, by id and business, in id order. */
async function liveQuestions(
  tx: Tx,
  handleId: string,
): Promise<{ id: string; business_id: string | null }[]> {
  const rows = await tx<{ id: string; business_id: string | null }[]>`
    select id, business_id from open_questions
    where handle_id = ${handleId} and status in ('waiting', 'open')
    order by id collate "C"
    for update
  `;
  return [...rows];
}

/**
 * The handle's live clocks (waiting or armed): those that name the handle, and those of one of the handle's questions
 * whatever it names, locked, by id, business and handle, in id order.
 */
async function liveClocks(
  tx: Tx,
  handleId: string,
): Promise<{ id: string; business_id: string | null; handle_id: string | null }[]> {
  const rows = await tx<{ id: string; business_id: string | null; handle_id: string | null }[]>`
    select id, business_id, handle_id from clock_rows
    where state in ('waiting', 'armed')
      and (handle_id = ${handleId}
           or open_question_id in (select id from open_questions where handle_id = ${handleId}))
    order by id collate "C"
    for update
  `;
  return [...rows];
}

/** Whether the handle's phone row says stopped (read as a boolean alone; no row: not stopped). */
async function stopped(tx: Tx, handleId: string): Promise<boolean> {
  const [phone] = await tx<{ stopped: boolean }[]>`select stopped from phones where handle_id = ${handleId}`;
  return phone?.stopped ?? false;
}

/**
 * Reads every place before anything is written: the places with nothing live, left as they are, and a plan for each
 * place with something live; or refuses, writing nothing for any place, naming every problem by its entry's place (see
 * the top of this file).
 */
async function planResets(
  tx: Tx,
  numbers: readonly string[],
): Promise<{ plans: Plan[]; places: Map<number, RosterResetPlace> }> {
  const problems: string[] = [];
  const plans: Plan[] = [];
  const places = new Map<number, RosterResetPlace>();
  const placeOfPerson = new Map<string, number>();
  for (const [index, number] of numbers.entries()) {
    const place = index + 1;
    const entry = entryOf(place);
    const handle = await handleAt(tx, number);
    if (handle === null) {
      places.set(place, { place, outcome: "nothingLive", handleId: null });
      continue;
    }
    const questions = await liveQuestions(tx, handle.id);
    const clocks = await liveClocks(tx, handle.id);
    if (questions.length === 0 && clocks.length === 0) {
      places.set(place, { place, outcome: "nothingLive", handleId: handle.id });
      continue;
    }

    const found: string[] = [];
    if (handle.kind !== "phone") {
      found.push(`${entry}'s handle is not a phone handle`);
    }
    const people = await peopleOf(tx, handle.id);
    const [personId, ...more] = people;
    const generation = await newestGeneration(tx, place);
    if (generation === 0) {
      found.push(`${entry}'s roster business does not exist yet (roster-owner seeds it)`);
    }
    const current = rosterResetIds(place, Math.max(generation, 1));
    if (personId === undefined || more.length > 0) {
      found.push(`${entry}'s handle has ${counted(people.length, "person", "people")}, not one`);
    } else {
      const roles = await rolesOf(tx, personId);
      if (roles > 0) {
        found.push(`${entry}'s person holds ${counted(roles, "role", "roles")}, live or ended`);
      }
      const companies = await companiesOf(tx, personId);
      const [company, ...others] = companies;
      if (
        generation > 0 &&
        (company?.id !== current.companyId || company.business_id !== current.businessId || others.length > 0)
      ) {
        found.push(`${entry}'s person does not own its place's newest company alone`);
      }
      const before = placeOfPerson.get(personId);
      if (before !== undefined) {
        found.push(`entries ${String(before)} and ${String(place)} are one person's handles`);
      }
      placeOfPerson.set(personId, place);
    }
    const ownBusiness = (businessId: string | null): boolean =>
      businessId === null || (generation > 0 && businessId === current.businessId);
    const foreignQuestions = questions.filter((question) => !ownBusiness(question.business_id)).length;
    if (foreignQuestions > 0) {
      found.push(
        `${entry}'s handle has ${counted(foreignQuestions, "live open question", "live open questions")} of ` +
          "another business",
      );
    }
    const foreignClocks = clocks.filter(
      (clock) =>
        !ownBusiness(clock.business_id) || (clock.handle_id !== null && clock.handle_id !== handle.id),
    ).length;
    if (foreignClocks > 0) {
      found.push(
        `${entry}'s handle has ${counted(foreignClocks, "live clock", "live clocks")} of another business or handle`,
      );
    }
    const targets = await handleTargetsIn(tx, { handleId: handle.id });
    if ("error" in targets) {
      found.push(`${entry}'s handle is missing`);
    } else if (targets.bookings.length > 0) {
      found.push(`${entry}'s handle has ${counted(targets.bookings.length, "booking", "bookings")}`);
    }
    if (await stopped(tx, handle.id)) {
      found.push(`${entry}'s phone is stopped, and a recorded STOP is never reset`);
    }
    const next = generation + 1;
    if (generation > 0 && next > MAX_GENERATION) {
      found.push(`${entry} has had ${String(MAX_GENERATION)} generations already`);
    }
    if (generation > 0 && next <= MAX_GENERATION) {
      const ids = rosterResetIds(place, next);
      if (
        (await held(tx, "businesses", ids.businessId)) ||
        (await held(tx, "companies", ids.companyId)) ||
        (await held(tx, "persons", ids.personId))
      ) {
        found.push(`an id of ${entry}'s next generation is held already`);
      }
    }

    if (found.length > 0 || personId === undefined) {
      problems.push(...found);
      continue;
    }
    plans.push({
      place,
      number,
      handleId: handle.id,
      from: { ...current, personId, generation },
      to: { ...rosterResetIds(place, next), generation: next },
      withdrawn: questions.map((question) => question.id),
      cancelled: clocks.map((clock) => clock.id),
    });
  }
  if (problems.length > 0) {
    throw refused(`${problems.join("; ")}; ${WHEN}`);
  }
  return { plans, places };
}

/** Each fresh head's rows (see the top of this file), one of each table, in the list's order. */
function rowsOf(plans: readonly Plan[]): RosterResetSeedRows {
  return {
    businesses: plans.map(({ to }): SkeletonBusinessRow => ({ ...BUSINESS, id: to.businessId })),
    business_setup: plans.map(({ to }): RosterOwnerBusinessSetupRow => ({ business_id: to.businessId })),
    persons: plans.map(({ to }): RosterOwnerPersonRow => ({ id: to.personId, name: null, language: null })),
    companies: plans.map(({ to }): SkeletonCompanyRow => ({
      ...COMPANY,
      id: to.companyId,
      owner_person_id: to.personId,
      business_id: to.businessId,
    })),
    person_handles: plans.map(({ to, handleId }): SkeletonPersonHandleRow => ({
      person_id: to.personId,
      handle_id: handleId,
    })),
  };
}

/** The rows an update or a delete touched: every one it was meant to, or the whole transaction rolls back. */
function requireTouched(touched: number, meant: number, what: string): void {
  if (touched !== meant) {
    throw refused(`${what} changed while the set ran (${String(touched)} of ${String(meant)}); run it again`);
  }
}

/**
 * Reads every reset place again after the writes, inside the seed's transaction, and refuses, rolling everything back,
 * unless each is a test owner under its fresh head, as roster-owner's checks require of its own ids (see the top of this
 * file).
 */
async function requireFreshHeads(tx: Tx, plans: readonly Plan[]): Promise<void> {
  const problems: string[] = [];
  for (const { place, number, handleId, to } of plans) {
    const entry = entryOf(place);
    const handle = await handleAt(tx, number);
    if (handle?.id !== handleId || handle.kind !== "phone") {
      problems.push(`${entry}'s number is not held by its phone handle`);
      continue;
    }
    const people = await peopleOf(tx, handleId);
    if (people.length !== 1 || people[0] !== to.personId) {
      problems.push(
        `${entry}'s handle has ${counted(people.length, "person", "people")}, not its new owner alone`,
      );
    }
    if ((await rolesOf(tx, to.personId)) > 0) {
      problems.push(`${entry}'s new person holds a role`);
    }
    const [company, ...others] = await companiesOf(tx, to.personId);
    if (company?.id !== to.companyId || company.business_id !== to.businessId || others.length > 0) {
      problems.push(`${entry}'s new person does not own its new company alone`);
    }
    const [business] = await tx<{ owners: number }[]>`
      select (select count(*)::int from person_roles
              where business_id = ${to.businessId} and role = 'owner' and ended_at is null) as owners
      from businesses where id = ${to.businessId}
    `;
    if (business === undefined) {
      problems.push(`${entry}'s new business is missing`);
    } else if (business.owners > 0) {
      problems.push(`${entry}'s new business has a live owner role`);
    }
    const targets = await handleTargetsIn(tx, { handleId });
    if ("error" in targets) {
      problems.push(`${entry}'s handle is missing`);
    } else {
      if (targets.openQuestions.length > 0) {
        problems.push(`${entry}'s handle still has a live open question`);
      }
      if (targets.bookings.length > 0) {
        problems.push(`${entry}'s handle has a booking`);
      }
    }
    if ((await liveClocks(tx, handleId)).length > 0) {
      problems.push(`${entry}'s handle still has a live clock`);
    }
    if (await stopped(tx, handleId)) {
      problems.push(`${entry}'s phone is stopped`);
    }
  }
  if (problems.length > 0) {
    throw refused(
      `a reset phone's JOIN would not be a first text under its fresh head: ${problems.join("; ")}`,
    );
  }
}

/** Resets each roster phone on STAGING_LINQ_ALLOWLIST that has something live (see the top of this file). */
export async function seedRosterReset(
  sql: Sql,
  options: RosterResetSeedOptions = {},
): Promise<RosterResetSeedResult> {
  const numbers = rosterNumbers((options.env ?? process.env)[ALLOWLIST_VARIABLE]);

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    const { plans, places } = await planResets(tx, numbers);
    const withdrawn = plans.flatMap((plan) => plan.withdrawn);
    const cancelled = plans.flatMap((plan) => plan.cancelled);

    if (withdrawn.length > 0) {
      const closed = await tx`
        update open_questions set status = 'withdrawn', closed_at = now(), version = version + 1
        where id in ${tx(withdrawn)} and status in ('waiting', 'open')
      `;
      requireTouched(closed.count, withdrawn.length, "a live open question");
    }
    if (cancelled.length > 0) {
      const closed = await tx`
        update clock_rows set state = 'cancelled', cancelled_at = now(), version = version + 1
        where id in ${tx(cancelled)} and state in ('waiting', 'armed')
      `;
      requireTouched(closed.count, cancelled.length, "a live clock");
    }

    let unlinked = 0;
    if (plans.length > 0) {
      const rows = rowsOf(plans);
      await tx`
        insert into businesses ${tx(
          rows.businesses,
          "id",
          "name",
          "display_name",
          "status",
          "time_zone",
          "text_hours_start",
          "text_hours_end",
          "version",
        )}
      `;
      // Its business_id alone, after its businesses row: every other column null or its default, so control is not
      // proven, as roster-owner writes it.
      await tx`insert into business_setup ${tx(rows.business_setup, "business_id")}`;
      await tx`insert into persons ${tx(rows.persons, "id", "name", "language")}`;
      await tx`
        insert into companies ${tx(rows.companies, "id", "owner_person_id", "name", "business_id", "version")}
      `;
      // No company_kinds row (DL-1048): the new company holds no kind of work until S1-02 names one.
      // The move: the old person's one link to the handle removed, the new person's added (K-04: added or removed).
      for (const { handleId, from } of plans) {
        const removed = await tx`
          delete from person_handles where person_id = ${from.personId} and handle_id = ${handleId}
        `;
        requireTouched(removed.count, 1, "a handle's link");
        unlinked += removed.count;
      }
      await tx`insert into person_handles ${tx(rows.person_handles, "person_id", "handle_id")}`;
    }

    await requireFreshHeads(tx, plans);
    for (const plan of plans) {
      places.set(plan.place, {
        place: plan.place,
        outcome: "reset",
        handleId: plan.handleId,
        from: plan.from,
        to: plan.to,
        withdrawn: plan.withdrawn,
        cancelled: plan.cancelled,
      });
    }
    return {
      ranAs: who?.role ?? "",
      resets: plans.length,
      closed: { open_questions: withdrawn.length, clock_rows: cancelled.length, person_handles: unlinked },
      places: numbers.map((_, index): RosterResetPlace => {
        const done = places.get(index + 1);
        if (done === undefined) {
          throw new Error("every place of the list has an outcome");
        }
        return done;
      }),
    };
  });

  const count = (): CoreSeedTableCount => ({ rows: written.resets, inserted: written.resets, kept: 0 });
  return {
    ranAs: written.ranAs,
    tables: {
      businesses: count(),
      business_setup: count(),
      persons: count(),
      companies: count(),
      person_handles: count(),
    },
    closed: written.closed,
    places: written.places,
  };
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedRosterReset;
