// T-1466: the roster-owner set's business_setup rows alone, for each roster business it wrote before T-1462 (C-202,
// staging's seeded state; DL-978, from the user's first real-iPhone texts; T-1450, T-1462). T-1462 made the roster-owner
// set (roster-owner.ts) write each roster business's K-23 v1 business_setup row with its control not proven, the row
// limit 1's default 14 (T-1459) reads on a sign-up's second text, where a missing row fails closed (DL-961; DL-964, the
// architect's N1). But that set refuses any run, writing nothing, once a roster phone's handle has a live open question
// (then its JOIN is no first text: T-1450), and on staging the roster phone's JOIN committed S1-02's question on Nov 18,
// before T-1462 was deployed. So its run at 08:18:19Z Nov 19 was refused ("entry 1's handle has 1 live open question")
// and the roster business has no business_setup row there (DL-978). This set adds that row, and nothing else:
//   business_setup  for the entry at place <n> of the list (from 1), biz-roster-owner-<n>'s setup row exactly as the
//                   roster-owner set writes it (T-1462): its business_id alone, every other column null or its default
//                   (no_money false, version 1), so its control is not proven (control_proven_at and
//                   control_proven_via null, as before S1-75) and it holds no listing phone or email, website, About
//                   us, profile, Stripe account or terms.
// It reads only the list's places' businesses rows, by id: never a handle, a person, a role, a company, a kind of work,
// an open question, a turn, a booking, a phone row or a sealing key, and it writes no row of any of them. So what makes
// the roster-owner set refuse a roster phone (its live open question, its turns, its phone row as a reply left it) is
// neither read nor changed here.
//
//   const result = await seedRosterOwnerSetup(sql);   // result.tables.business_setup: { rows: 1, inserted: 1, kept: 0 }
//
// The list: STAGING_LINQ_ALLOWLIST, read by name at run time and split by the roster-owner set's own rosterNumbers, so
// each refusal of the list is that set's, word for word (a RosterOwnerSeedError, before anything is read or written):
// the list unset or blank, an entry that is not E.164, a number given twice, a test phone's fixed fake handle. A number
// stands for its place alone: the set's ids are its place's (rosterOwnerIds), never made from the number, and no number
// is read from or written to the database, put in a query or printed.
//
// Then, in one transaction as the job role rosie_job with no business scope (T-191), as the roster-owner set writes:
//   1. It reads which of the places' businesses (biz-roster-owner-<n>) exist, and refuses, writing nothing for any place,
//      unless every one does, naming each missing one by its place alone: a place whose business does not exist yet is
//      the roster-owner set's to seed (its rows, business_setup among them, in one run), never this set's. Only that set
//      writes these ids (its idProblems keeps each from being another company's), so a business with one is that set's.
//   2. It writes each business's row only when its key is free (ON CONFLICT (business_id) DO NOTHING; nothing is ever
//      updated or deleted): a business whose row is there keeps it as it is, counted as kept, whether or not its control
//      is proven (a proof, S1-75's code or the team's check, is never reset). The row's foreign key to its business is
//      checked at once, so a business gone since step 1 rolls the whole transaction back.
// Idempotent: a second run writes nothing. The row this set writes is the one the roster-owner set writes, so that set,
// when it runs again, keeps it and counts it as kept; every refusal and row of that set is unchanged (this file changes
// nothing in it). Nothing is printed, and no error names a number or a value of a row: the runner (T-201) prints the
// counts this returns.
//
// It runs only when named, `npm run seed:staging -- --set roster-owner-setup` (seed-staging.sh hands it the list by name,
// on that run's line alone, as it hands it to roster-owner), never in D-017's run. A new set, not a flag of roster-owner:
// the runner takes `--set <name>` alone and finds a set by its file name, so a set of its own needs no change to the
// runner and only its name in seed-staging.sh, and roster-owner.ts stays as it is.
import { SCOPE_SETTING, type Sql } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import {
  ALLOWLIST_VARIABLE,
  type RosterOwnerBusinessSetupRow,
  rosterNumbers,
  rosterOwnerIds,
} from "./roster-owner";

/** The set's rows: each roster business's business_setup row, the roster-owner set's own (T-1462). */
export interface RosterOwnerSetupSeedRows {
  readonly business_setup: readonly RosterOwnerBusinessSetupRow[];
}

export type RosterOwnerSetupSeedTable = keyof RosterOwnerSetupSeedRows;

/** A roster business the set gave its row, by its place on the list and its id alone (never its number). */
export interface RosterOwnerSetupBusiness {
  /** Its place on STAGING_LINQ_ALLOWLIST, from 1. */
  readonly place: number;
  /** biz-roster-owner-<place>: the roster-owner set's business for that place. */
  readonly businessId: string;
}

export interface RosterOwnerSetupSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  readonly tables: Readonly<Record<RosterOwnerSetupSeedTable, CoreSeedTableCount>>;
  /** Each place's business, in the list's order. */
  readonly businesses: readonly RosterOwnerSetupBusiness[];
}

export interface RosterOwnerSetupSeedOptions {
  /** Where STAGING_LINQ_ALLOWLIST is read. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The set refused, writing nothing. Its message names places alone: no number, no part of the list, no row's value. */
export class RosterOwnerSetupSeedError extends Error {
  override readonly name = "RosterOwnerSetupSeedError";
}

const WHEN =
  "this set adds the business_setup row alone, to a roster business the roster-owner set has written for its place " +
  "(npm run seed:staging -- --set roster-owner seeds a new one, its business_setup row with it), with each number at " +
  "the place it held when that set ran";

const refused = (why: string): RosterOwnerSetupSeedError =>
  new RosterOwnerSetupSeedError(`the roster owner setup seed refused, writing nothing: ${why}`);

/** Gives the roster business of each place on STAGING_LINQ_ALLOWLIST its missing business_setup row (see the top). */
export async function seedRosterOwnerSetup(
  sql: Sql,
  options: RosterOwnerSetupSeedOptions = {},
): Promise<RosterOwnerSetupSeedResult> {
  const numbers = rosterNumbers((options.env ?? process.env)[ALLOWLIST_VARIABLE]);
  const businesses = numbers.map((_, index): RosterOwnerSetupBusiness => {
    const place = index + 1;
    return { place, businessId: rosterOwnerIds(place).businessId };
  });

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    const missing: string[] = [];
    for (const { place, businessId } of businesses) {
      const [business] = await tx<{ id: string }[]>`select id from businesses where id = ${businessId}`;
      if (business === undefined) {
        missing.push(`entry ${String(place)}'s business does not exist yet`);
      }
    }
    if (missing.length > 0) {
      throw refused(`${missing.join("; ")}; ${WHEN}`);
    }
    const rows = businesses.map(({ businessId }): RosterOwnerBusinessSetupRow => ({
      business_id: businessId,
    }));
    // Its business_id alone: every other column null or its default, so control is not proven. A row already there is
    // kept as it is, a proven one included.
    const businessSetup = await tx`
      insert into business_setup ${tx(rows, "business_id")} on conflict (business_id) do nothing
    `;
    return { ranAs: who?.role ?? "", inserted: businessSetup.count };
  });

  const total = businesses.length;
  return {
    ranAs: written.ranAs,
    tables: { business_setup: { rows: total, inserted: written.inserted, kept: total - written.inserted } },
    businesses,
  };
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedRosterOwnerSetup;
