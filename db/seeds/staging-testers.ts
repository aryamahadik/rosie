// T-1281: staging's human testers, ADR-016 section 7's card H (C-193 with the staging seeds; ADR-016 section 5; K-22
// v1.3 rule 10 and defaults 24 to 29, the table staging_testers of migration 0036; K-05 v1.15 items 68 and 69; DL-011,
// DL-526, DL-535, DL-753). The people who run staging's human tests sign in by a code sent to their own test inbox
// (DL-753, R5 (b)), and staging's test tools admit them as testers (K-05 v1.15 readTesterStanding). This set makes each
// inbox on staging's list such a person. T-201's runner runs it as `node db/seeds/run.mjs --set staging-testers`, and
// seed:staging hands it the list by name (T-1287). Per inbox, the rows, by the ids this set makes:
//   persons          person-staging-tester-<n>         no name and no language (null until known), as K-22 v1.3's
//                                                      seed-staging-tester.json's testers
//   handles          handle-staging-tester-<n>-email   kind email, at the inbox's address in lower case
//   person_handles   the person writes from that handle
//   accounts         the person's sign-in account: email that address, proven at the run's time, no mobile. So
//                    signInStart's one account by a proven email names the person (ADR-016 section 4 rule 4), and
//                    sendSignInCode's code goes to that handle. Proven because the testers are staff who gave their own
//                    inboxes (ADR-016 open point 11)
//   staging_testers  staging-tester-<n>-<k>            the person's live listing (removed_at null), added at the run's
//                                                      time: readTesterStanding answers the person's live session
//                                                      tester, and personStanding tester true with team false
// <n> numbers the set's testers: an inbox new to the database takes the next number after the set's highest, in the
// list's order, and keeps it on every later run, found by its address. <k> numbers that person's listings.
//
// Never written for a tester, and refused when found on one (K-22 v1.3 rule 10 and default 29; ADR-016 section 5; build
// prompt 9.4): a role at any business and a K-36 team row (team_page_recipients), so no page to Rosie's team reaches a
// tester and no tester is an owner or an admin. Nor a phone, a company, a proof code or a session: a tester signs in by a
// real code to their own inbox.
//
// The addresses are staff's, not customer data (rule 9; ADR-016 section 5 and open point 11): the testers are people of
// Rosie's own team, the user and Jay, who gave their own inboxes for this test (DL-011), as T-202's test phones are
// staff's numbers (QUESTIONS.md M2-playbook-database.7). They are read at run time, by name, from the environment
// variable STAGING_TEST_INBOXES (INBOXES_VARIABLE) on the build Mac, the list staging's Resend adapter holds as its
// allow-list (K-12 default 19; ADR-016 section 5: one source for both), and are never in the repository. None is printed,
// logged, put in an error or returned: a refusal names an entry by its place in the list, the result holds ids and
// counts, and a database error is passed on as its SQLSTATE and names alone (db/repo/clocks.ts scrubbed), never its
// detail or the statement's values.
//
// The list is read as the Resend adapter reads the same name (adapters/src/email/resend-send/send.ts readTestInboxes):
// addresses separated by commas or white space, read in lower case; an address named twice is one inbox. Unset or blank,
// it names no inbox, and the set writes nothing and ends no listing, so a run with the list missing leaves the database
// as it was (T-1287). An entry that is not an address (one @ with text on each side) is refused, as the adapter fails
// closed on it.
//
//   const result = await seedStagingTesters(sql);   // result.tables.accounts: { rows: 2, inserted: 2, kept: 0 }
//
// In order, stopping at the first refusal:
//   1. Before the database is reached: the list is read, and an entry that is not an address refused by its place.
//   2. In one transaction as the job role rosie_job with no business scope (T-191), under a transaction-level advisory
//      lock so that two runs never number one inbox twice: each inbox's handle by its address (K-04 handles_address_key).
//      None makes a new tester; this set's email handle is that tester's; another handle refuses the run.
//   3. The writes: each row only when its key is free (ON CONFLICT DO NOTHING), so a row that went missing is written
//      again; a listing only for a tester with no live one. A listing that ended is never reopened (K-22 v1.3 rule 10): an
//      inbox put back on the list lists its person again, in a new row.
//   4. When the list names an inbox: the live listing of each of this set's testers whose inbox is no longer on it ends
//      (removed_at the run's time, the version raised by one), as K-22 v1.3's open gap "Who ends a listing" proposes for
//      this set (K-05 v1.15 README: T-1281's or a later seed card's). The tester's standing ends at once (K-05 v1.15
//      default 138); nothing else of the tester is touched, and a listing of a person this set did not make never ends
//      here.
//   5. Read back inside the same transaction, and refused, rolling everything back, unless for each inbox: its handle is
//      this set's, of kind email, at the address, and the tester alone writes from it; the tester's account holds the
//      address, proven, and no other account holds it (two accounts with one email name no person: ADR-016 open point
//      14); the tester holds one live listing, no live role and no live team row.
// Idempotent: a second run with the same list writes nothing and leaves every row as it was, version included. Nothing is
// printed: the runner prints the counts this returns.
import { scrubbed } from "../repo/clocks";
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";

/** The environment variable that names staging's test inboxes (ADR-016 section 5's name; the Resend adapter's too). */
export const INBOXES_VARIABLE = "STAGING_TEST_INBOXES";

/** The name this set runs by, which a scrubbed database error carries. */
const SET_NAME = "staging-testers";

/** The transaction-level advisory lock two runs of this set take one after the other (step 2). */
const LOCK_KEY = "rosie-seed:staging-testers";

/** A tester's person id, for its number <n> (see the top of this file). */
export const personIdOf = (n: number): string => `person-staging-tester-${String(n)}`;
/** A tester's email handle id, for its number <n>. */
export const emailHandleIdOf = (n: number): string => `handle-staging-tester-${String(n)}-email`;
/** A tester's <k>-th listing id, for its number <n>. */
export const listingIdOf = (n: number, k: number): string => `staging-tester-${String(n)}-${String(k)}`;

// The forms of those ids, each holding the tester's number (and a listing its own); PostgreSQL reads the same forms.
const PERSON_ID = /^person-staging-tester-([1-9][0-9]{0,8})$/;
const EMAIL_HANDLE_ID = /^handle-staging-tester-([1-9][0-9]{0,8})-email$/;
const LISTING_ID = /^staging-tester-([1-9][0-9]{0,8})-([1-9][0-9]{0,8})$/;
const PERSON_FORM = PERSON_ID.source;
const HANDLE_FORM = EMAIL_HANDLE_ID.source;

// An entry is an address when it holds one @ with text on each side, as the Resend adapter's EMAIL_ADDRESS reads it in
// lower case (validate.ts) and as K-04 handles_address_form and K-22 accounts_email_form hold an email.
const ADDRESS = /^[^@\s]+@[^@\s]+$/;
// What separates the list's entries (readTestInboxes).
const SEPARATORS = /[\s,]+/;

export type StagingTestersEnv = Readonly<Record<string, string | undefined>>;

/** One inbox the list names: its address in lower case, and the place of its first entry in the list, from 1. */
export interface TestInbox {
  readonly address: string;
  readonly place: number;
}

export type StagingTestersSeedTable =
  "persons" | "handles" | "person_handles" | "accounts" | "staging_testers";

/** A tester as seeded: the ids written for one inbox, never its address. */
export interface SeededTester {
  readonly personId: string;
  readonly emailHandleId: string;
  /** The tester's live listing (K-22 v1.3 staging_testers). */
  readonly listingId: string;
}

export interface StagingTestersSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** Each table's rows for the list's inboxes (one per inbox), and how many of them this run wrote. */
  readonly tables: Readonly<Record<StagingTestersSeedTable, CoreSeedTableCount>>;
  /** One entry per inbox, in the list's order. */
  readonly testers: readonly SeededTester[];
  /** The live listings this run ended: this set's testers whose inbox is no longer on the list (step 4). */
  readonly listingsEnded: number;
}

export interface StagingTestersSeedOptions {
  /** Where STAGING_TEST_INBOXES is read. Default process.env. */
  env?: StagingTestersEnv;
}

/** The seed refused, writing nothing. Its message names an entry by its place in the list, never an address. */
export class StagingTestersSeedError extends Error {
  override readonly name = "StagingTestersSeedError";
}

const refused = (why: string): StagingTestersSeedError =>
  new StagingTestersSeedError(`the staging testers seed refused, writing nothing: ${why}`);

/** An entry of the list, as a refusal names it: by its place. */
const entry = (inbox: TestInbox): string => `${INBOXES_VARIABLE} entry ${String(inbox.place)}`;

/**
 * The inboxes STAGING_TEST_INBOXES names, in the list's order (step 1): unset or blank, none. Refuses an entry that is
 * not an address, naming its place among the list's entries and no part of the value.
 */
export function testInboxes(value: string | undefined): readonly TestInbox[] {
  const inboxes: TestInbox[] = [];
  const entries = (value ?? "").split(SEPARATORS).filter((part) => part !== "");
  for (const [index, part] of entries.entries()) {
    const address = part.toLowerCase();
    const place = index + 1;
    if (!ADDRESS.test(address)) {
      throw refused(
        `${INBOXES_VARIABLE} entry ${String(place)} is not an email address (one @ with text on each ` +
          "side; entries are separated by commas or white space) (no part of its value is shown)",
      );
    }
    if (!inboxes.some((inbox) => inbox.address === address)) {
      inboxes.push({ address, place });
    }
  }
  return inboxes;
}

/** A tester this run works on: its inbox, its number and the ids made from it. */
interface Tester {
  readonly inbox: TestInbox;
  readonly n: number;
  readonly personId: string;
  readonly emailHandleId: string;
}

/** The number <k> of a listing of the tester's own person under the tester's id form, or 0 for any other listing. */
function listingNumber(row: { readonly id: string; readonly person_id: string }, tester: Tester): number {
  const match = LISTING_ID.exec(row.id);
  if (row.person_id !== tester.personId || match === null || Number(match[1]) !== tester.n) {
    return 0;
  }
  return Number(match[2]);
}

/**
 * Step 2: each inbox's tester, by the handle at its address: this set's email handle gives its number; no handle, the
 * next number after the set's highest, in the list's order. Refuses, before anything is written, an inbox whose address
 * another handle holds.
 */
async function testersOf(tx: Tx, inboxes: readonly TestInbox[]): Promise<Tester[]> {
  const addresses = inboxes.map((inbox) => inbox.address);
  const found = await tx<{ id: string; address: string }[]>`
    select id, address from handles where address = any(${addresses}::text[])
  `;
  const [highest] = await tx<{ n: number }[]>`
    select coalesce(greatest(
      (select max(substring(id from ${PERSON_FORM}::text)::int) from persons where id ~ ${PERSON_FORM}::text),
      (select max(substring(id from ${HANDLE_FORM}::text)::int) from handles where id ~ ${HANDLE_FORM}::text)
    ), 0)::int as n
  `;
  let next = highest?.n ?? 0;
  const problems: string[] = [];
  const testers: Tester[] = [];
  for (const inbox of inboxes) {
    const handle = found.find((row) => row.address === inbox.address);
    let n: number;
    if (handle === undefined) {
      next += 1;
      n = next;
    } else {
      const own = EMAIL_HANDLE_ID.exec(handle.id);
      if (own === null) {
        problems.push(
          `another handle holds the address of ${entry(inbox)}: an address is one handle's (K-04 ` +
            "handles_address_key), and this set lists only a person it made",
        );
        continue;
      }
      n = Number(own[1]);
    }
    testers.push({ inbox, n, personId: personIdOf(n), emailHandleId: emailHandleIdOf(n) });
  }
  if (problems.length > 0) {
    throw refused(problems.join("; "));
  }
  return testers;
}

/**
 * Step 5: reads every tester's rows back inside the transaction and refuses, rolling the whole run back, unless each is
 * as the top of this file describes. Answers each tester's live listing id, by person id.
 */
async function requireTesters(tx: Tx, testers: readonly Tester[]): Promise<Map<string, string>> {
  const personIds = testers.map((tester) => tester.personId);
  const handleIds = testers.map((tester) => tester.emailHandleId);
  const addresses = testers.map((tester) => tester.inbox.address);
  const handles = await tx<{ id: string; kind: string; address: string }[]>`
    select id, kind, address from handles
    where id = any(${handleIds}::text[]) or address = any(${addresses}::text[])
  `;
  const writers = await tx<{ person_id: string; handle_id: string }[]>`
    select person_id, handle_id from person_handles where handle_id = any(${handleIds}::text[])
  `;
  const accounts = await tx<{ person_id: string; email: string | null; proven: boolean }[]>`
    select person_id, email, email_proven_at is not null as proven from accounts
    where person_id = any(${personIds}::text[]) or email = any(${addresses}::text[])
  `;
  const listings = await tx<{ id: string; person_id: string }[]>`
    select id, person_id from staging_testers where person_id = any(${personIds}::text[]) and removed_at is null
  `;
  const roles = await tx<{ person_id: string }[]>`
    select person_id from person_roles where person_id = any(${personIds}::text[]) and ended_at is null
  `;
  const teamRows = await tx<{ person_id: string }[]>`
    select person_id from team_page_recipients where person_id = any(${personIds}::text[]) and removed_at is null
  `;

  const problems: string[] = [];
  const live = new Map<string, string>();
  for (const { inbox, personId, emailHandleId } of testers) {
    const own: string[] = [];
    const handle = handles.find((row) => row.address === inbox.address);
    if (handle?.id !== emailHandleId || handle.kind !== "email") {
      own.push("its handle is not this set's email handle at its address");
    }
    const writing = writers.filter((row) => row.handle_id === emailHandleId);
    if (writing.length !== 1 || writing[0]?.person_id !== personId) {
      own.push("its tester is not the one person who writes from its email handle");
    }
    const account = accounts.find((row) => row.person_id === personId);
    if (account?.email !== inbox.address || !account.proven) {
      own.push("its tester's account does not hold its address, proven");
    }
    if (accounts.some((row) => row.email === inbox.address && row.person_id !== personId)) {
      own.push(
        "another account holds its address, so a sign-in by it names no person (ADR-016 open point 14)",
      );
    }
    const listing = listings.find((row) => row.person_id === personId);
    if (listing === undefined) {
      own.push("its tester holds no live listing");
    } else {
      live.set(personId, listing.id);
    }
    if (roles.some((row) => row.person_id === personId)) {
      own.push("its tester holds a live role (K-22 v1.3 rule 10: a listed person holds none)");
    }
    if (teamRows.some((row) => row.person_id === personId)) {
      own.push("its tester holds a live team row (K-22 v1.3 rule 10; build prompt 9.4)");
    }
    problems.push(...own.map((problem) => `${entry(inbox)}: ${problem}`));
  }
  if (problems.length > 0) {
    throw refused(problems.join("; "));
  }
  return live;
}

/** The whole run inside its one transaction (steps 2 to 5). */
async function seedIn(tx: Tx, inboxes: readonly TestInbox[]): Promise<StagingTestersSeedResult> {
  await tx.unsafe(`set local role ${SEED_ROLE}`);
  // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
  await tx`select set_config(${SCOPE_SETTING}, '', true)`;
  const [who] = await tx<{ role: string }[]>`select current_user as role`;
  const ranAs = who?.role ?? "";
  const counted = (inserted: number): CoreSeedTableCount => ({
    rows: inboxes.length,
    inserted,
    kept: inboxes.length - inserted,
  });
  if (inboxes.length === 0) {
    // No inbox: nothing is written and no listing ends (see the top of this file).
    return {
      ranAs,
      tables: {
        persons: counted(0),
        handles: counted(0),
        person_handles: counted(0),
        accounts: counted(0),
        staging_testers: counted(0),
      },
      testers: [],
      listingsEnded: 0,
    };
  }

  await tx`select pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`;
  const testers = await testersOf(tx, inboxes);
  const personIds = testers.map((tester) => tester.personId);
  const addresses = testers.map((tester) => tester.inbox.address);
  const personRows = testers.map((tester) => ({ id: tester.personId }));
  const handleRows = testers.map((tester) => ({
    id: tester.emailHandleId,
    kind: "email",
    address: tester.inbox.address,
  }));
  const linkRows = testers.map((tester) => ({ person_id: tester.personId, handle_id: tester.emailHandleId }));

  const persons = await tx`
    insert into persons ${tx(personRows, "id")} on conflict (id) do nothing
  `;
  const handles = await tx`
    insert into handles ${tx(handleRows, "id", "kind", "address")} on conflict (id) do nothing
  `;
  const personHandles = await tx`
    insert into person_handles ${tx(linkRows, "person_id", "handle_id")}
    on conflict (person_id, handle_id) do nothing
  `;
  // The account, by its person: email the inbox's address, proven at the run's time; no mobile.
  const accounts = await tx`
    insert into accounts (person_id, email, email_proven_at)
    select v.person_id, v.email, now()
    from unnest(${personIds}::text[], ${addresses}::text[]) as v (person_id, email)
    on conflict (person_id) do nothing
  `;

  // A listing for each tester with no live one, numbered after that person's highest (a listing is never reopened).
  const listings = await tx<{ id: string; person_id: string; live: boolean }[]>`
    select id, person_id, removed_at is null as live from staging_testers
    where person_id = any(${personIds}::text[])
  `;
  const listedNow = new Set(listings.filter((row) => row.live).map((row) => row.person_id));
  const newListings: { id: string; personId: string }[] = [];
  for (const tester of testers) {
    if (!listedNow.has(tester.personId)) {
      const k = 1 + Math.max(0, ...listings.map((row) => listingNumber(row, tester)));
      newListings.push({ id: listingIdOf(tester.n, k), personId: tester.personId });
    }
  }
  const listingIds = newListings.map((listing) => listing.id);
  const listedPersonIds = newListings.map((listing) => listing.personId);
  const listed =
    newListings.length === 0
      ? { count: 0 }
      : await tx`
          insert into staging_testers (id, person_id, added_at)
          select v.id, v.person_id, now()
          from unnest(${listingIds}::text[], ${listedPersonIds}::text[]) as v (id, person_id)
        `;

  // Step 4: this set's testers whose inbox is no longer on the list are listed no more. A listing ends no earlier than it
  // was made (staging_testers_removed_after_added), whatever the clock of a run that waited on the lock read.
  const ended = await tx`
    update staging_testers set removed_at = greatest(now(), added_at), version = version + 1
    where removed_at is null and person_id ~ ${PERSON_FORM}::text and person_id <> all(${personIds}::text[])
  `;

  const live = await requireTesters(tx, testers);
  return {
    ranAs,
    tables: {
      persons: counted(persons.count),
      handles: counted(handles.count),
      person_handles: counted(personHandles.count),
      accounts: counted(accounts.count),
      staging_testers: counted(listed.count),
    },
    testers: testers.map((tester) => ({
      personId: tester.personId,
      emailHandleId: tester.emailHandleId,
      listingId: live.get(tester.personId) ?? "",
    })),
    listingsEnded: ended.count,
  };
}

/** Seeds staging's human testers from the inboxes STAGING_TEST_INBOXES names (see the top of this file). */
export async function seedStagingTesters(
  sql: Sql,
  options: StagingTestersSeedOptions = {},
): Promise<StagingTestersSeedResult> {
  const inboxes = testInboxes((options.env ?? process.env)[INBOXES_VARIABLE]);
  try {
    return await sql.begin((tx) => seedIn(tx, inboxes));
  } catch (error) {
    // A database error's detail and the statement's values can hold an address: only its SQLSTATE and names go on.
    throw scrubbed(SET_NAME, error);
  }
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedStagingTesters;
