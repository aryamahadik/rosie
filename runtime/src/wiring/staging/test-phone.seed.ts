// The seed of staging's test-phone page's test file (T-1305; ./test-phone.worker.test.ts; key TEST_PHONE in
// infra/test-rig/files.mjs): the rows K-05 v1.12's three test-phone reads answer from (items 53 to 55, item 53 as v1.15's
// item 68 widens it; db/repo/test-phone-reads.ts). The rig's globalSetup (infra/test-rig/rig.mjs) runs it once, in Node,
// on this file's database, after the migrations and bundle v0, with a client of the connecting login.
//
// One world, written once. The page reaches the rows through the roster's one list (db/seeds/lib/roster.ts, T-1302) and
// a session token's sha256, so each roster phone holds one state and each session one standing:
//
//   the roster phones, by the list's five ids:
//     tp-01  test owner 1 as db/seeds/skeleton.ts writes him (T-1148): handle-sam at the list's number, Sam its one
//            person, no email handle, and no phone row (read-roster-phone-tp-01 and read-phone-state-no-row, exactly)
//     tp-02  handle-tp-02: no row at all, as before seed:staging's first run (read-roster-phone-unknown, exactly)
//     tp-03  handle-tp-03 at the list's number, its one person with one email handle, the address K-12's
//            send-copy-of-text.json writes to (read-roster-phone-email-on-file's shape), and its phone row four seconds
//            after a STOP (read-phone-state-stopped, exactly: the fixture asks about this number)
//     tp-04  handle-tp-04 at the list's number, no email; its phone row after a START that followed that STOP, its
//            chat open again (read-phone-state-started-again's shape)
//     tp-05  handle-tp-05 at the list's number, no email; its chat open and never stopped (read-phone-state-chat-open's
//            shape), and one chat link holding read-phone-state-chat-link's own short code and ready text, a staff
//            invite from Lee's Barbershop
//   the sessions, as the page's standing reads them:
//     exactly, each fixture's rows:  the check tester, as read-tester-standing-check-tester's note lists it (a live
//                                    team row, the test console's member); Sam's two sessions of K-22 v1's
//                                    seed-session.json with their sign-in codes of seed-proof-code.json
//                                    (read-tester-standing-not-tester, -signed-out and -expired); and K-22 v1.3's
//                                    seed-staging-tester.json, its accounts left out, which no read here reads
//                                    (read-tester-standing-human-tester and -listing-ended)
//     the page's own:                one live session for each of three people, whose tokens this file makes up
//                                    (PAGE_TOKENS): the check tester's, tester one's and Sam's, each with its own
//                                    sign-in code, so the page's two calls carry a token and the handler hashes it as it
//                                    hashes a cookie's. Each began an hour before the seed ran and ends 30 days after it
//                                    began (every staging session's length: QUESTIONS.md CQ-238's default), timed from
//                                    the run as db/seeds/check-tester.ts times its own, so it is live at the Workers
//                                    clock the page entry reads, whatever day the file runs. NO_SESSION_TOKEN's sha256 no
//                                    session holds.
// Two fixtures cannot stand beside these: read-tester-standing-unknown-token and -removed-member ask about the check
// tester's hash on rows without its session or with its team row removed. The test maps their answers as given, and the
// page's NO_SESSION_TOKEN stands in the first's shape. The fixtures' own values are proved on the database side by K-05's
// contract test and db/repo's own (db/repo/test-phone-reads.int.test.ts; T-1300, T-1402).
//
// It writes as the other seeds do: the skeleton set by its own seed, then every other row in one transaction as the
// runtime side's role, rosie_job, with no business scope, through its own grants and policies. Nothing is updated or
// deleted. Test values only (rule 9): the contracts' fixtures, made-up ids and tokens, example.com addresses, and the
// fiction-range numbers the roster's list holds; no number is written here but the list's.
//
// The skeleton seed is loaded inside seed() and never at the top of this file: it reads fixture files through Node's own
// modules (db/seeds/lib/fixture-set.ts), and the test file, which runs in the Workers runtime, imports this file's
// constants.
import { sha256Hex } from "../../../../actions/src/page-calls/staging/test-phone/ids";
import chatLinkFixture from "../../../../contracts/data-access/fixtures/read-phone-state-chat-link.json";
import seedProofCode from "../../../../contracts/db-schema/people-access/fixtures/seed-proof-code.json";
import seedSession from "../../../../contracts/db-schema/people-access/fixtures/seed-session.json";
import seedStagingTester from "../../../../contracts/db-schema/people-access/fixtures/seed-staging-tester.json";
import sendCopyOfText from "../../../../contracts/port-email/fixtures/send-copy-of-text.json";
import { SCOPE_SETTING, type Sql, type Tx } from "../../../../db/repo/scope";
import { rosterPhone, type RosterPhone } from "../../../../db/seeds/lib/roster";

/** The roster phone with this id, from the one list (db/seeds/lib/roster.ts). */
function listed(testPhoneId: string): RosterPhone {
  const found = rosterPhone(testPhoneId);
  if (found === null) throw new Error(`the roster's list holds no ${testPhoneId}`);
  return found;
}

/** The five roster phones as the list names them: each a roster id, its K-04 handle id and its fiction-range number. */
export const TP_01 = listed("tp-01");
export const TP_02 = listed("tp-02");
export const TP_03 = listed("tp-03");
export const TP_04 = listed("tp-04");
export const TP_05 = listed("tp-05");

/** The tokens of the page's own sessions, made up for this file (never a real token), and one no session holds. */
export const PAGE_TOKENS = {
  /** The check tester's second live session: tester by its live team row (default 105). */
  checkTester: "t1305-made-up-session-token-check-tester",
  /** Tester one's second live session: tester by its live K-22 v1.3 listing (item 68). */
  humanTester: "t1305-made-up-session-token-tester-one",
  /** Sam's live session: test owner 1 holds no team row and no listing, so notTester. */
  owner: "t1305-made-up-session-token-test-owner-1",
} as const;
export const NO_SESSION_TOKEN = "t1305-made-up-session-token-no-session";

/** The people the page's sessions are for, by the fixtures' ids. */
export const CHECK_TESTER_PERSON = "person-check-tester";
export const HUMAN_TESTER_PERSON = "person-tester-one";
export const OWNER_PERSON = "person-sam";

/** The check tester's rows, as read-tester-standing-check-tester.json's note lists them (no seed file holds them). */
const CHECK_TESTER = {
  emailHandleId: "handle-check-tester-email",
  email: "check-tester@example.com",
  teamRowId: "team-check-tester",
  proofCodeId: "code-check-tester-seed",
  codeHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
  sessionId: "session-check-tester",
  tokenSha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  at: "2026-11-12T04:00:00Z",
  codeExpiresAt: "2026-11-12T04:10:00Z",
  sessionExpiresAt: "2026-12-12T04:00:00Z",
} as const;

/** When the STOP in force at tp-03 came, and the one tp-04 started after (commit-alex-stop and commit-alex-start). */
export const STOPPED_AT = "2026-11-07T15:06:36Z";
export const STARTED_AT = "2026-11-07T15:20:00Z";

/** tp-05's chat link: read-phone-state-chat-link.json's own short code and ready text. */
export const CHAT_LINK: { readonly shortCode: string; readonly readyText: string } =
  chatLinkFixture.outcome.chatLink;

/** tp-03's one person's one email handle: the address K-12's send-copy-of-text.json sends its copy to. */
export const TP_03_EMAIL = sendCopyOfText.request.to;

/** The rows this seed writes in each table the three reads read (the skeleton's included), and nothing a call wrote. */
export const SEEDED_ROWS = {
  // Sam (the skeleton's), the check tester, tester one and two, and tp-03 to tp-05's people.
  persons: 7,
  // handle-sam, four email handles (the check tester's, the two listed testers', tp-03's), tp-03 to tp-05's phones.
  handles: 8,
  person_handles: 8,
  team_page_recipients: 1,
  staging_testers: 2,
  // The check tester's seed code, Sam's two, the two listed testers', and the page's three.
  proof_codes: 8,
  sessions: 8,
  // tp-03, tp-04 and tp-05.
  phones: 3,
  chat_links: 1,
} as const;

/** The hash of no code (as db/seeds/check-tester.ts writes a used code's): the code is used, so nothing compares it. */
const NO_CODE_HASH = "0".repeat(64);

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The times of the page's own sessions and their codes, in whole seconds (UTC), from the time the seed runs. */
interface PageSessionTimes {
  readonly codeSentAt: string;
  readonly codeExpiresAt: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/**
 * A session begun an hour before `nowMs` and ending 30 days after it began, by a code sent a minute before it began and
 * used at once (K-22's proof_codes_ten_minutes: it expires ten minutes after it was sent).
 */
function pageSessionTimes(nowMs: number): PageSessionTimes {
  const startedMs = Math.floor(nowMs / 1000) * 1000 - 60 * MINUTE_MS;
  const sentMs = startedMs - MINUTE_MS;
  const iso = (ms: number): string => new Date(ms).toISOString();
  return {
    codeSentAt: iso(sentMs),
    codeExpiresAt: iso(sentMs + 10 * MINUTE_MS),
    startedAt: iso(startedMs),
    expiresAt: iso(startedMs + 30 * DAY_MS),
  };
}

type Cell = string | number | boolean | null | string[];
type Row = Record<string, Cell>;

async function insert(tx: Tx, table: string, values: Row): Promise<void> {
  await tx`insert into ${tx(table)} ${tx(values)}`;
}

/** The rows of a K-22 seed file whose table is this one (and whose id is among `ids`, when given), value for value. */
function k22Rows(
  file: { readonly rows: readonly { readonly table: string; readonly values: unknown }[] },
  table: string,
  ids?: readonly string[],
): Row[] {
  const rows = file.rows
    .filter((each) => each.table === table)
    .map((each) => ({ ...(each.values as Row) }))
    .filter((values) => ids === undefined || (typeof values.id === "string" && ids.includes(values.id)));
  if (rows.length === 0 || (ids !== undefined && rows.length !== ids.length)) {
    throw new Error(`a K-22 seed file holds not the ${table} rows this seed writes`);
  }
  return rows;
}

/** One of the page's own sessions: a sign-in code sent to the person's handle and used, and the live session it names. */
async function insertPageSession(
  tx: Tx,
  times: PageSessionTimes,
  session: {
    readonly name: string;
    readonly personId: string;
    readonly handleId: string;
    readonly channel: "text" | "email";
    readonly token: string;
  },
): Promise<void> {
  const proofCodeId = `code-t1305-${session.name}`;
  await insert(tx, "proof_codes", {
    id: proofCodeId,
    purpose: "sign_in",
    person_id: session.personId,
    business_id: null,
    sent_to_handle_id: session.handleId,
    channel: session.channel,
    code_hash: NO_CODE_HASH,
    hash_key_name: "PROOF_CODE_HASH_KEY",
    sent_at: times.codeSentAt,
    expires_at: times.codeExpiresAt,
    used_at: times.startedAt,
    version: 2,
  });
  await insert(tx, "sessions", {
    id: `session-t1305-${session.name}`,
    person_id: session.personId,
    token_sha256: await sha256Hex(session.token),
    device_sha256: null,
    proven_via: "code",
    proof_code_id: proofCodeId,
    started_at: times.startedAt,
    last_seen_at: times.startedAt,
    expires_at: times.expiresAt,
  });
}

/** A roster phone's person (no name) and its phone handle at the list's number, and their link. */
async function insertRosterPhone(tx: Tx, phone: RosterPhone, personId: string): Promise<void> {
  await insert(tx, "persons", { id: personId, name: null, language: null });
  await insert(tx, "handles", { id: phone.handleId, kind: "phone", address: phone.fakeNumber });
  await insert(tx, "person_handles", { person_id: personId, handle_id: phone.handleId });
}

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  const { seedSkeleton } = await import("../../../../db/seeds/skeleton");
  // tp-01: T-1148's SKELETON_ROWS, by its own seed (test owner 1, handle-sam at the list's number, no phone row).
  await seedSkeleton(sql);
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;

    // The check tester, as read-tester-standing-check-tester.json's note lists its rows.
    await insert(tx, "persons", { id: CHECK_TESTER_PERSON, name: null, language: null });
    await insert(tx, "handles", {
      id: CHECK_TESTER.emailHandleId,
      kind: "email",
      address: CHECK_TESTER.email,
    });
    await insert(tx, "person_handles", {
      person_id: CHECK_TESTER_PERSON,
      handle_id: CHECK_TESTER.emailHandleId,
    });
    await insert(tx, "team_page_recipients", {
      id: CHECK_TESTER.teamRowId,
      person_id: CHECK_TESTER_PERSON,
      chat_handle_id: null,
      email_handle_id: CHECK_TESTER.emailHandleId,
      added_at: CHECK_TESTER.at,
      removed_at: null,
    });
    await insert(tx, "proof_codes", {
      id: CHECK_TESTER.proofCodeId,
      purpose: "sign_in",
      person_id: CHECK_TESTER_PERSON,
      business_id: null,
      sent_to_handle_id: CHECK_TESTER.emailHandleId,
      channel: "email",
      code_hash: CHECK_TESTER.codeHash,
      hash_key_name: "PROOF_CODE_HASH_KEY",
      sent_at: CHECK_TESTER.at,
      expires_at: CHECK_TESTER.codeExpiresAt,
      used_at: CHECK_TESTER.at,
      version: 2,
    });
    await insert(tx, "sessions", {
      id: CHECK_TESTER.sessionId,
      person_id: CHECK_TESTER_PERSON,
      token_sha256: CHECK_TESTER.tokenSha256,
      device_sha256: null,
      proven_via: "code",
      proof_code_id: CHECK_TESTER.proofCodeId,
      started_at: CHECK_TESTER.at,
      last_seen_at: CHECK_TESTER.at,
      expires_at: CHECK_TESTER.sessionExpiresAt,
    });

    // Sam's two sessions (K-22 v1 seed-session.json) and the sign-in codes they name (seed-proof-code.json).
    for (const row of k22Rows(seedProofCode, "proof_codes", [
      "code-sam-sign-in-oct20",
      "code-sam-sign-in-oct26",
    ])) {
      await insert(tx, "proof_codes", row);
    }
    for (const row of k22Rows(seedSession, "sessions")) await insert(tx, "sessions", row);

    // K-22 v1.3's two listed testers (seed-staging-tester.json), with no team row and no role; their accounts are
    // left out, since no read here reads one.
    for (const table of [
      "persons",
      "handles",
      "person_handles",
      "staging_testers",
      "proof_codes",
      "sessions",
    ]) {
      for (const row of k22Rows(seedStagingTester, table)) await insert(tx, table, row);
    }

    // The page's own sessions, each live from an hour before this run for 30 days.
    const times = pageSessionTimes(Date.now());
    await insertPageSession(tx, times, {
      name: "check-tester",
      personId: CHECK_TESTER_PERSON,
      handleId: CHECK_TESTER.emailHandleId,
      channel: "email",
      token: PAGE_TOKENS.checkTester,
    });
    await insertPageSession(tx, times, {
      name: "tester-one",
      personId: HUMAN_TESTER_PERSON,
      handleId: "handle-tester-one-email",
      channel: "email",
      token: PAGE_TOKENS.humanTester,
    });
    await insertPageSession(tx, times, {
      name: "test-owner-1",
      personId: OWNER_PERSON,
      handleId: TP_01.handleId,
      channel: "text",
      token: PAGE_TOKENS.owner,
    });

    // tp-03: its one person's one email handle, and its phone row four seconds after a STOP (commit-alex-stop).
    await insertRosterPhone(tx, TP_03, "person-tp-03");
    await insert(tx, "handles", { id: "handle-tp-03-email", kind: "email", address: TP_03_EMAIL });
    await insert(tx, "person_handles", { person_id: "person-tp-03", handle_id: "handle-tp-03-email" });
    await insert(tx, "phones", {
      number: TP_03.fakeNumber,
      handle_id: TP_03.handleId,
      chat_open: false,
      chat_open_at: "2026-11-07T15:00:00Z",
      chat_way: "imessage",
      stopped: true,
      stop_at: STOPPED_AT,
      start_at: null,
      version: 4,
    });

    // tp-04: its phone row after a START that followed the STOP (commit-alex-start): the chat open again, stop_at kept.
    await insertRosterPhone(tx, TP_04, "person-tp-04");
    await insert(tx, "phones", {
      number: TP_04.fakeNumber,
      handle_id: TP_04.handleId,
      chat_open: true,
      chat_open_at: STARTED_AT,
      chat_way: "imessage",
      stopped: false,
      stop_at: STOPPED_AT,
      start_at: STARTED_AT,
      version: 5,
    });

    // tp-05: its chat open and never stopped, and one chat link, a staff invite from Lee's Barbershop.
    await insertRosterPhone(tx, TP_05, "person-tp-05");
    await insert(tx, "phones", {
      number: TP_05.fakeNumber,
      handle_id: TP_05.handleId,
      chat_open: true,
      chat_open_at: "2026-10-19T18:00:00Z",
      chat_way: "imessage",
      stopped: false,
      stop_at: null,
      start_at: null,
      version: 2,
    });
    await insert(tx, "chat_links", {
      id: "chatlink-t1305-tp-05",
      short_code: CHAT_LINK.shortCode,
      purpose: "staff_invite",
      business_id: "biz-lees-barbershop",
      booking_id: null,
      person_id: "person-tp-05",
      phone_number: TP_05.fakeNumber,
      ready_text: CHAT_LINK.readyText,
      given_via: ["owner"],
      issued_at: "2026-10-19T15:00:00Z",
    });
  });
}
