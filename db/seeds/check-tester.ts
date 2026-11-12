// T-1302: staging's check tester (C-202 for C-205; K-05 v1.12 default 105 and item 53; QUESTIONS.md CQ-214 (a) and
// CQ-254; the D-017 path audit's D3 and ruling R5; DL-542). The automated check (T-570) and the 20-text run (T-467) use
// staging's test-phone page as a signed-in tester, and a script cannot sign in by an emailed code, so this set seeds one
// tester with a live session whose token is made at random on the build Mac and kept there by name (T-1303; making it is
// the user's live step, a secret write: DL-497, DL-514). Only the token's sha256 reaches this set, by name, in the
// environment variable STAGING_CHECK_TESTER_TOKEN_SHA256 (TOKEN_HASH_VARIABLE). The token never reaches the set, the
// repository, a log or the output, and the hash is never printed, put in an error or returned. T-201's runner runs it as
// `node db/seeds/run.mjs --set check-tester`, and seed:staging hands it the hash (T-1303). The rows, with the ids and the
// address K-05 v1.12's read-tester-standing-check-tester.json shows:
//   persons               person-check-tester        no name, no language, no role, no company and no phone handle: no
//                                                    roster phone's person, so it changes no turn's party (K-05 item 52)
//                                                    and no guard's targets (item 27)
//   handles               handle-check-tester-email  kind email, at check-tester@example.com, a reserved domain no inbox
//                                                    answers (rule 9)
//   person_handles        the person writes from that handle, its one handle
//   team_page_recipients  team-check-tester          live (removed_at null): the test console's member (K-21 default 2),
//                                                    reached only at that email handle (no chat handle), so a staging
//                                                    page reaches it only as an email through the test-phone line's email
//                                                    double (T-1186), and item 53 answers its session `tester`
//   proof_codes           code-check-tester-<n>      the sign-in code the session names (sessions.proof_code_id is
//                                                    required and unique): purpose sign_in, sent by email to that handle
//                                                    and used at once, so nothing ever checks it; its code_hash the hash
//                                                    of no code (NO_CODE_HASH) under the code key's name (no key is read);
//                                                    version 2, as a code that was used
//   sessions              session-check-tester-<n>   live: proven_via code, no device, token_sha256 the hash handed in,
//                                                    started and last seen at the run's time and ending SESSION_DAYS (30)
//                                                    days on, never open-ended
// <n> counts the check tester's sessions: 1 for the first token, 2 for the token that replaces it, and so on.
//
// The session's length: 30 days, the length every staging session takes (QUESTIONS.md CQ-238's default, DL-526; K-21
// open gap 3; read-tester-standing-check-tester.json's session runs 30 days). So the token works for 30 days at most, and
// a lost or lapsed token is replaced by a new one and this set run again with its sha256 (default 105; as CQ-218 treats
// staging's own keys): the new token's session is written, and the check tester's other sessions end in the same
// transaction (ended_why signed_out), so a replaced token opens nothing from then on. A token's session is never brought
// back: a hash whose session lapsed or ended is refused.
//
//   const result = await seedCheckTester(sql);   // result.tables.sessions: { rows: 1, inserted: 1, kept: 0 }
//
// In order, stopping at the first refusal:
//   1. Before the hash is read or the database is reached: the target must be staging's own schema, by the signals T-201's
//      runner and seed-staging.sh use: DATABASE_URL set and equal to STAGING_DATABASE_URL (how the runner knows the
//      staging database, and the database it connected to), and DB_SCHEMA unset, blank or public (the schema staging's
//      Worker reads; a preview's is refused). A local database, production, any other database and a preview are refused.
//   2. Before the database is reached: the hash must be set and be 64 lower-case hex characters (a token's sha256 as
//      K-22's sessions_token_hash_form holds it). No part of it is ever shown.
//   3. In one transaction as the job role rosie_job with no business scope (T-191), before anything is written: refused
//      when another person's session holds the hash, when the check tester's session for it ended or lapsed, when another
//      handle holds the check tester's address or its handle holds another, when the check tester's person holds a role,
//      a company or another handle, or its email handle another person, and when its team row was removed or changed or
//      it holds another live one (this set never updates, re-adds or removes a team row, a person or a handle).
// Then the writes: each fixed row only when its primary key is free (ON CONFLICT DO NOTHING); for a hash no session holds
// yet, the sign-in code and the session, and the end of the check tester's other live sessions. Last, inside the same
// transaction, it reads the standing as item 53 does (session_for_token at the transaction's time, then a live team row)
// and refuses, rolling everything back, unless the hash's session is the check tester's and its team row is live.
// Idempotent for one hash: a second run writes nothing and leaves every row as it was, version included; a fixed row that
// went missing is written again as the first run wrote it. Nothing is printed: the runner prints the counts this returns.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";

/** The environment variable on the build Mac that hands this set the token's sha256 by name (never the token). */
export const TOKEN_HASH_VARIABLE = "STAGING_CHECK_TESTER_TOKEN_SHA256";

/** The session's length in days: every staging session's (CQ-238's default, DL-526; K-21 open gap 3). */
export const SESSION_DAYS = 30;

/** The check tester's fixed rows, by their ids and its one address (K-05 v1.12 default 105). */
export const CHECK_TESTER = {
  personId: "person-check-tester",
  emailHandleId: "handle-check-tester-email",
  email: "check-tester@example.com",
  teamRowId: "team-check-tester",
} as const;

/** The name of the key a sign-in code's hash is made with (ADR-016; CQ-240): a name only, no key is read here. */
export const CODE_HASH_KEY_NAME = "PROOF_CODE_HASH_KEY";

/** The seeded code's code_hash: the hash of no code (64 zeros). The code is used, so check_proof_code never compares it. */
export const NO_CODE_HASH = "0".repeat(64);

/** A token's sha256 as K-22 keeps it (sessions_token_hash_form): 64 lower-case hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Where the set reads its variables. */
export type CheckTesterEnv = Readonly<Record<string, string | undefined>>;

export type CheckTesterSeedTable =
  "persons" | "handles" | "person_handles" | "team_page_recipients" | "proof_codes" | "sessions";

export interface CheckTesterSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  readonly tables: Readonly<Record<CheckTesterSeedTable, CoreSeedTableCount>>;
  /** The check tester's rows by id: never the hash. */
  readonly checkTester: {
    readonly personId: string;
    readonly emailHandleId: string;
    readonly teamRowId: string;
    /** The live session the hash names, and the sign-in code it names. */
    readonly sessionId: string;
    readonly proofCodeId: string;
    /** When that session ends by itself (ISO 8601, UTC): SESSION_DAYS after it started. */
    readonly sessionExpiresAt: string;
  };
  /** The check tester's other sessions this run ended (signed_out): a replaced token's. 0 when no session was written. */
  readonly sessionsEnded: number;
}

export interface CheckTesterSeedOptions {
  /** Where DATABASE_URL, STAGING_DATABASE_URL, DB_SCHEMA and the hash are read. Default process.env. */
  env?: CheckTesterEnv;
}

/** The seed refused, writing nothing. Its message names no part of the hash or of a database URL. */
export class CheckTesterSeedError extends Error {
  override readonly name = "CheckTesterSeedError";
}

const refused = (why: string): CheckTesterSeedError =>
  new CheckTesterSeedError(`the check tester seed refused, writing nothing: ${why}`);

const WHAT_TO_DO =
  "make a new token on the build Mac and run this set again with its sha256 (K-05 v1.12 default 105)";

/**
 * Refuses unless the run targets staging's own schema (step 1 above): DATABASE_URL set and equal to STAGING_DATABASE_URL,
 * and DB_SCHEMA unset, blank or public. Reads no hash and reaches no database; names no part of any URL.
 */
export function requireStagingTarget(env: CheckTesterEnv): void {
  const url = env.DATABASE_URL ?? "";
  if (url === "" || url !== (env.STAGING_DATABASE_URL ?? "")) {
    throw refused(
      "DATABASE_URL does not name the staging database (the one STAGING_DATABASE_URL names): the check tester is " +
        "staging's alone, never a local database's, production's or any other's (no part of either URL is shown)",
    );
  }
  // The runner's own reading of DB_SCHEMA: unset or blank is public.
  if (((env.DB_SCHEMA ?? "").trim() || "public") !== "public") {
    throw refused(
      "DB_SCHEMA names a schema other than public: the check tester is seeded only into the schema staging's Worker " +
        "reads, never a preview's",
    );
  }
}

/**
 * The token's sha256 handed in by name (step 2 above), refused when the variable is unset or empty, or is not 64
 * lower-case hex characters. Reaches no database; never shows any part of the value.
 */
export function tokenSha256Of(env: CheckTesterEnv): string {
  const value = env[TOKEN_HASH_VARIABLE];
  if (value === undefined || value === "") {
    throw refused(
      `${TOKEN_HASH_VARIABLE} is not set: it hands this set the sha256 of the check tester's token, which is made on ` +
        "the build Mac and kept there by name (T-1303)",
    );
  }
  if (!SHA256_HEX.test(value)) {
    throw refused(
      `${TOKEN_HASH_VARIABLE} is not 64 lower-case hex characters: it holds the token's sha256, never the token (no ` +
        "part of its value is shown)",
    );
  }
  return value;
}

/** The session a hash names, as the refusals read it: whose, and whether it is live now. */
interface HashSession {
  readonly id: string;
  readonly proofCodeId: string;
  readonly ofCheckTester: boolean;
  readonly live: boolean;
}

/**
 * Step 3 above: refuses, before anything is written, every state this set would not leave as default 105 describes it,
 * and answers the session the hash already names (the check tester's, live), or null for a hash no session holds.
 */
async function refuseClashes(tx: Tx, tokenSha256: string): Promise<HashSession | null> {
  const { personId, emailHandleId, email, teamRowId } = CHECK_TESTER;
  const problems: string[] = [];

  const [session] = await tx<{ id: string; proof_code_id: string; person_id: string; live: boolean }[]>`
    select id, proof_code_id, person_id, ended_at is null and expires_at > now() as live
    from sessions where token_sha256 = ${tokenSha256}
  `;
  const known =
    session === undefined
      ? null
      : {
          id: session.id,
          proofCodeId: session.proof_code_id,
          ofCheckTester: session.person_id === personId,
          live: session.live,
        };
  if (known !== null && !known.ofCheckTester) {
    problems.push(`another person's session holds the hash; ${WHAT_TO_DO}`);
  } else if (known !== null && !known.live) {
    problems.push(
      `the check tester's session for the hash has ended or lapsed and is never brought back; ${WHAT_TO_DO}`,
    );
  }

  const handles = await tx<{ id: string; kind: string; address: string }[]>`
    select id, kind, address from handles where id = ${emailHandleId} or address = ${email}
  `;
  if (handles.some((row) => row.id === emailHandleId && (row.kind !== "email" || row.address !== email))) {
    problems.push("the check tester's handle holds another address");
  }
  if (handles.some((row) => row.id !== emailHandleId && row.address === email)) {
    problems.push("another handle holds the check tester's address");
  }

  const [links] = await tx<{ roles: number; companies: number; handles: number; people: number }[]>`
    select
      (select count(*)::int from person_roles where person_id = ${personId}) as roles,
      (select count(*)::int from companies where owner_person_id = ${personId}) as companies,
      (select count(*)::int from person_handles where person_id = ${personId} and handle_id <> ${emailHandleId})
        as handles,
      (select count(*)::int from person_handles where handle_id = ${emailHandleId} and person_id <> ${personId})
        as people
  `;
  if ((links?.roles ?? 0) + (links?.companies ?? 0) + (links?.handles ?? 0) > 0) {
    problems.push(
      "the check tester's person holds a role, a company or another handle, so it could be a roster phone's or a " +
        "business's person",
    );
  }
  if ((links?.people ?? 0) > 0) {
    problems.push("another person writes from the check tester's email handle");
  }

  const teamRows = await tx<
    {
      id: string;
      person_id: string;
      chat_handle_id: string | null;
      email_handle_id: string | null;
      removed: boolean;
    }[]
  >`
    select id, person_id, chat_handle_id, email_handle_id, removed_at is not null as removed
    from team_page_recipients
    where id = ${teamRowId} or (person_id = ${personId} and removed_at is null)
  `;
  const own = teamRows.find((row) => row.id === teamRowId);
  if (
    own !== undefined &&
    (own.removed ||
      own.person_id !== personId ||
      own.chat_handle_id !== null ||
      own.email_handle_id !== emailHandleId)
  ) {
    problems.push(
      "the check tester's team row was removed or changed, and this set never re-adds or edits one",
    );
  }
  if (teamRows.some((row) => row.id !== teamRowId && row.person_id === personId)) {
    problems.push("the check tester holds another live team row");
  }

  if (problems.length > 0) {
    throw refused(problems.join("; "));
  }
  return known;
}

/**
 * Reads the standing as K-05 v1.12 item 53 does, inside the seed's transaction at its time: the live session the hash
 * names (session_for_token), then a live team row of that session's person. Refuses unless that is the check tester.
 */
async function requireTester(tx: Tx, tokenSha256: string): Promise<void> {
  const found = await tx<{ person_id: string; live_team_rows: number }[]>`
    select s.person_id,
           (select count(*)::int from team_page_recipients r
            where r.person_id = s.person_id and r.removed_at is null) as live_team_rows
    from session_for_token(${tokenSha256}, now()) as s
  `;
  const [standing] = found;
  if (found.length !== 1 || standing?.person_id !== CHECK_TESTER.personId || standing.live_team_rows !== 1) {
    throw refused(
      "the hash's session is not the check tester's live session with one live team row once written (K-05 v1.12 " +
        "item 53 would not answer tester)",
    );
  }
}

/** Seeds staging's check tester, its session from the token's sha256 handed in by name (see the top of this file). */
export async function seedCheckTester(
  sql: Sql,
  options: CheckTesterSeedOptions = {},
): Promise<CheckTesterSeedResult> {
  const env = options.env ?? process.env;
  requireStagingTarget(env);
  const tokenSha256 = tokenSha256Of(env);
  const { personId, emailHandleId, email, teamRowId } = CHECK_TESTER;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    const known = await refuseClashes(tx, tokenSha256);

    const persons = await tx`insert into persons (id) values (${personId}) on conflict (id) do nothing`;
    const handles = await tx`
      insert into handles (id, kind, address) values (${emailHandleId}, 'email', ${email}) on conflict (id) do nothing
    `;
    const personHandles = await tx`
      insert into person_handles (person_id, handle_id) values (${personId}, ${emailHandleId})
      on conflict (person_id, handle_id) do nothing
    `;
    const teamRows = await tx`
      insert into team_page_recipients (id, person_id, chat_handle_id, email_handle_id, added_at)
      values (${teamRowId}, ${personId}, null, ${emailHandleId}, now())
      on conflict (id) do nothing
    `;

    let session = known === null ? null : { id: known.id, proofCodeId: known.proofCodeId };
    let inserted = { proofCodes: 0, sessions: 0 };
    let sessionsEnded = 0;
    if (session === null) {
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from sessions where person_id = ${personId}
      `;
      const n = String((count?.n ?? 0) + 1);
      session = { id: `session-check-tester-${n}`, proofCodeId: `code-check-tester-${n}` };
      // A sign-in code sent to the check tester's email handle and used at once (0020's CHECKs: ten minutes, used
      // inside them), version 2 as a used code is. No key is read: the hash is of no code.
      const proofCodes = await tx`
        insert into proof_codes (id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash,
                                 hash_key_name, sent_at, expires_at, used_at, version)
        values (${session.proofCodeId}, 'sign_in', ${personId}, null, ${emailHandleId}, 'email', ${NO_CODE_HASH},
                ${CODE_HASH_KEY_NAME}, now(), now() + interval '10 minutes', now(), 2)
      `;
      const sessions = await tx`
        insert into sessions (id, person_id, token_sha256, device_sha256, proven_via, proof_code_id, started_at,
                              last_seen_at, expires_at)
        values (${session.id}, ${personId}, ${tokenSha256}, null, 'code', ${session.proofCodeId}, now(), now(),
                now() + make_interval(days => ${SESSION_DAYS}))
      `;
      inserted = { proofCodes: proofCodes.count, sessions: sessions.count };
      // The token this one replaces opens nothing from now on: the check tester's other sessions end here.
      const ended = await tx`
        update sessions set ended_at = now(), ended_why = 'signed_out', version = version + 1
        where person_id = ${personId} and ended_at is null and id <> ${session.id}
      `;
      sessionsEnded = ended.count;
    }

    await requireTester(tx, tokenSha256);
    const [expiry] = await tx<
      { expires_at: Date }[]
    >`select expires_at from sessions where id = ${session.id}`;
    return {
      ranAs: who?.role ?? "",
      session,
      sessionExpiresAt: expiry?.expires_at.toISOString() ?? "",
      sessionsEnded,
      inserted: {
        persons: persons.count,
        handles: handles.count,
        person_handles: personHandles.count,
        team_page_recipients: teamRows.count,
        proof_codes: inserted.proofCodes,
        sessions: inserted.sessions,
      },
    };
  });

  // The set holds one row in each table: the fixed rows, and the hash's session with its sign-in code.
  const count = (table: CheckTesterSeedTable): CoreSeedTableCount => {
    const rows = 1;
    const inserted = written.inserted[table];
    return { rows, inserted, kept: rows - inserted };
  };
  return {
    ranAs: written.ranAs,
    tables: {
      persons: count("persons"),
      handles: count("handles"),
      person_handles: count("person_handles"),
      team_page_recipients: count("team_page_recipients"),
      proof_codes: count("proof_codes"),
      sessions: count("sessions"),
    },
    checkTester: {
      personId,
      emailHandleId,
      teamRowId,
      sessionId: written.session.id,
      proofCodeId: written.session.proofCodeId,
      sessionExpiresAt: written.sessionExpiresAt,
    },
    sessionsEnded: written.sessionsEnded,
  };
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedCheckTester;
