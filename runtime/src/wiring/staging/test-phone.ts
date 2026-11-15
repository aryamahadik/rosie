// Staging's test-phone page inputs (the D-017 path audit's P6b: ops/reviews/D-017-path-audit/order_d017.txt line 48;
// T-1305; K-05 v1.12 README, "What the new tasks must hold to", the runtime engineer's bindings; the lead's notes DL-557,
// DL-581, DL-768 and DL-776). T-1257 made this file with its final signature; T-1305 binds it and edits nothing else
// (./options.ts hands it its part).
//
// RootOptions.testPhone (../test-phone TestPhoneInputs), the ports T-565's two handlers reach (actions/src/page-calls/
// staging/test-phone/types.ts), each read on the runtime side of the root's handle only (part.db.runtime: one short-lived
// client per call from HYPERDRIVE_JOB, the login rosie_worker_job, which inherits rosie_job alone, guarded before the
// read runs and ended after it; ADR-014). Never a Tool API client (DL-557): rosie_app may also execute session_for_token
// (0020's grant), so a Tool API client would find a session for an unknown hash's caller before being refused at
// team_page_recipients. HYPERDRIVE_APP is never read here. No answer is remembered: every call reads the rows as they
// stand (K-21 v1 README "Who may call": every call; K-05 v1.12 "Why the primary, uncached").
//
//   access  K-05 v1.12 item 53, as v1.15's item 68 widens it (db/repo/test-phone-reads.ts readTesterStanding): the
//           session token's sha256 and the handler's time, never the token. `standing` is mapped across unchanged
//           (tester, notTester, noSession); K-05's transient answer is thrown (TestPhoneReadTransientError), as any
//           error the answer names that is none of K-05's own, so the page entry answers 503.
//   roster  the roster's one list (db/seeds/lib/roster.ts, T-1302; K-05 default 106) gives the roster id's K-04 handle
//           id, compared exactly; an id the list does not hold answers null with nothing read. Item 54
//           (readRosterPhone) is asked for that handle alone, never a roster id or a number, and its answer is given as
//           { testPhoneId, number, email }, the number and the email as the database holds them (default 107); phone
//           null answers null, so the page answers notTestPhone and nothing is signed or posted.
//   phones  item 55 (readPhoneState) for the number item 54 gave. No phone row is a chat closed and not stopped, with
//           no STOP in force and no chat link (default 108); a row is mapped field by field. The chat link is the
//           answer's short code and ready text, with its address built in K-09 v1 issueChatLink's form,
//           `sms:<ROSIE_NUMBER>&body=<the ready text>`, the ready text percent-encoded as K-09's fixtures write it
//           (every character but RFC 3986's unreserved ones: chat-link-after-contact-add.json, staff-join-link.json).
//           ROSIE_NUMBER (T-1304) is read from the env at each call that has a link to build, and checked as E.164 by
//           the K-04 and K-11 phone pattern (DL-581): missing or malformed, chatLink is null (default 109; open gap
//           63), since a rollback to an older version, or a preview, carries no deploy-time check.
//   line    staging's test-phone line (../test-phone/line.ts, capped by T-1238), the one TestPhoneLine every isolate
//           names, where the dispatcher's parts and the email rows' emails are recorded: TEST_PHONE_LINE is read from
//           the env at each call, never at build, so a call with none bound fails closed (NoTestPhoneLineError) and the
//           page call that reached it answers 503.
//
// Unbound: any environment but staging (checked first, so no binding is read there), or staging with no HYPERDRIVE_JOB
// binding: null, as the Worker's root has always handed, so both page calls stay unconfigured (503, notConnected). At
// build nothing is read but ENVIRONMENT and HYPERDRIVE_JOB's presence (DL-768); its connection string is the handle's to
// read, at each call, and ROSIE_NUMBER and TEST_PHONE_LINE are read at each call that needs them.
//
// Bound but failing: the handle's own refusals (./db.ts: the guard's DbGuardRefusal, DbClosedError while DB_SCHEMA is
// set or the binding holds no connection string, a connect that fails as DataAccessDatabaseError) and the reads' own (a
// TypeError for a request of the wrong shape, a BrokenRecordError, any other database error scrubbed) are thrown as they
// are: each names a call, a side, a binding's name, a check's label, a field or a SQLSTATE, and never a value. Every
// throw fails the page call, which the page entry answers 503 with the error's name alone in its log line.
//
// Nothing here logs, and nothing is put in a span (T-1248's security note b): never a token, a hash, a number, an email,
// a short code, a ready text or a chat link's address. The handle writes each call's timing, labels and numbers only
// (./part.ts dbCallLine), on no trace (no port's request names one).

import {
  readPhoneState,
  readRosterPhone,
  readTesterStanding,
  type ReadPhoneStateOutcome,
  type ReadRosterPhoneOutcome,
  type ReadTesterStandingOutcome,
} from "@rosie/db/repo/test-phone-reads";
import { rosterPhone as rosterEntryOf } from "@rosie/db/seeds/lib/roster";
import type {
  ChatLink,
  PhoneState,
  RosterPhone,
  TesterStanding,
} from "@rosie/actions/src/page-calls/staging/test-phone/index";

import { environmentOf } from "../picks";
import {
  NoTestPhoneLineError,
  testPhoneLineOf,
  type TestPhoneInputs,
  type TestPhoneLinePort,
} from "../test-phone";
import type { StagingEnv, StagingPart } from "./part";

/** What T-1305's builder is handed: the env (ROSIE_NUMBER, TEST_PHONE_LINE) and the root's handle. */
export type TestPhonePart = StagingPart;

/** Item 53's read's name on the handle: on its timing line, and on the error its transient answer is thrown as. */
export const READ_TESTER_STANDING_CALL = "readTesterStanding";
/** Item 54's. */
export const READ_ROSTER_PHONE_CALL = "readRosterPhone";
/** Item 55's. */
export const READ_PHONE_STATE_CALL = "readPhoneState";

/** The three reads' names. */
export type TestPhoneReadCall =
  typeof READ_TESTER_STANDING_CALL | typeof READ_ROSTER_PHONE_CALL | typeof READ_PHONE_STATE_CALL;

/** K-04 phones_number_form and K-11's phone pattern: E.164, a + and 7 to 15 digits, the first not 0. */
const E164 = /^\+[1-9][0-9]{6,14}$/u;

const SQLSTATE = /^[0-9A-Z]{5}$/u;

/** A phone with no K-04 row yet (default 108): its chat closed, not stopped, no STOP in force and no chat link. */
const NO_ROW_STATE: PhoneState = Object.freeze({
  chatOpen: false,
  stopped: false,
  stoppedAt: null,
  chatLink: null,
});

/**
 * K-05's transient answer to one of the three reads, thrown: the database could not answer now, so the page entry answers
 * 503 and the page may ask again. It carries the call's name and the answer's SQLSTATE (null for one that is no SQLSTATE),
 * and nothing else. Thrown the same way for an answer whose error K-05 does not name for the read.
 */
export class TestPhoneReadTransientError extends Error {
  readonly call: TestPhoneReadCall;
  readonly sqlstate: string | null;

  constructor(call: TestPhoneReadCall, sqlstate: unknown) {
    const code = typeof sqlstate === "string" && SQLSTATE.test(sqlstate) ? sqlstate : null;
    super(
      `${call}: the database could not answer now (transient${code === null ? "" : `, SQLSTATE ${code}`})`,
    );
    this.name = "TestPhoneReadTransientError";
    this.call = call;
    this.sqlstate = code;
  }
}

/** The SQLSTATE an error answer carries, read as unknown: never anything else of it. */
const sqlstateOf = (answer: { readonly error: unknown }): unknown =>
  (answer as { readonly sqlstate?: unknown }).sqlstate;

/**
 * Item 53's answer as TesterAccess.standing gives it (the README's bindings line): the standing across unchanged; K-05's
 * transient answer, or any error it does not name, thrown.
 */
export function standingOf(answer: ReadTesterStandingOutcome): TesterStanding {
  if ("error" in answer) throw new TestPhoneReadTransientError(READ_TESTER_STANDING_CALL, sqlstateOf(answer));
  return answer.standing;
}

/**
 * Item 54's answer for the handle the roster's list gave a roster id, as TestPhoneRoster.phone gives it: phone null is
 * null (no roster phone by that id: notTestPhone); a phone is { testPhoneId, number, email }, as the database holds
 * them. K-05's transient answer, any error it does not name, and an answer for another handle are thrown.
 */
export function rosterPhoneOf(
  testPhoneId: string,
  handleId: string,
  answer: ReadRosterPhoneOutcome,
): RosterPhone | null {
  if ("error" in answer) throw new TestPhoneReadTransientError(READ_ROSTER_PHONE_CALL, sqlstateOf(answer));
  // The answer names the request's handle (item 54); another's would be a roster phone the list does not give.
  if (answer.handleId !== handleId) {
    throw new TypeError(`${READ_ROSTER_PHONE_CALL}: the answer names another handle than the one asked for`);
  }
  if (answer.phone === null) return null;
  return { testPhoneId, number: answer.phone.number, email: answer.phone.email };
}

/** Rosie's number as the env gives it, when it is E.164 by the K-04 and K-11 pattern, compared exactly; else null. */
export function rosieNumberOf(value: unknown): string | null {
  return typeof value === "string" && E164.test(value) ? value : null;
}

/**
 * The ready text as K-09 v1 issueChatLink's link carries it: percent-encoded, every character but RFC 3986's unreserved
 * ones (letters, digits, - . _ ~), so the apostrophe and the comma are encoded as K-09's fixtures write them.
 */
export function smsBodyOf(readyText: string): string {
  return encodeURIComponent(readyText).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * A chat link as the page shows it: the answer's short code and ready text, with the address K-09 v1 issueChatLink gives,
 * `sms:<Rosie's number>&body=<the ready text>`; null with no link, or with no Rosie's number in E.164 form (default 109;
 * DL-581).
 */
export function chatLinkOf(
  link: { readonly shortCode: string; readonly readyText: string } | null,
  rosieNumber: string | null,
): ChatLink | null {
  if (link === null || rosieNumber === null) return null;
  return {
    link: `sms:${rosieNumber}&body=${smsBodyOf(link.readyText)}`,
    readyText: link.readyText,
    shortCode: link.shortCode,
  };
}

/**
 * Item 55's answer as PhoneStates.state gives it (the README's bindings line): no phone row is a chat closed and not
 * stopped (default 108); a row field by field, with its chat link built from Rosie's number (`rosieNumber`, read only
 * when the answer holds a link). K-05's transient answer, or any error it does not name, thrown.
 */
export function phoneStateOf(answer: ReadPhoneStateOutcome, rosieNumber: () => string | null): PhoneState {
  if ("error" in answer) throw new TestPhoneReadTransientError(READ_PHONE_STATE_CALL, sqlstateOf(answer));
  if (answer.phone === null) return NO_ROW_STATE;
  return {
    chatOpen: answer.phone.chatOpen,
    stopped: answer.phone.stopped,
    stoppedAt: answer.phone.stoppedAt,
    chatLink: answer.chatLink === null ? null : chatLinkOf(answer.chatLink, rosieNumber()),
  };
}

/**
 * Staging's test-phone line, read from the env at each call (never at build): the one TestPhoneLine every isolate names,
 * a new stub for each call (../test-phone testPhoneLineOf); with no TEST_PHONE_LINE bound, each call fails closed.
 */
export function stagingLineOf(env: StagingEnv): TestPhoneLinePort {
  const line = (): TestPhoneLinePort => {
    const namespace = env.TEST_PHONE_LINE;
    if (namespace === undefined) throw new NoTestPhoneLineError();
    return testPhoneLineOf(namespace);
  };
  return {
    sendPart: async (request) => line().sendPart(request),
    partsTo: async (number) => line().partsTo(number),
    sendEmail: async (request) => line().sendEmail(request),
    sentEmails: async (request) => line().sentEmails(request),
  };
}

/** A binding is present when the env holds an object under its name; its connection string is the handle's to read. */
const isBound = (binding: unknown): boolean => typeof binding === "object" && binding !== null;

/**
 * RootOptions.testPhone for staging: items 53 to 55 on one job-side client per read through the root's handle, the
 * roster's one list, and staging's test-phone line. Null anywhere but staging (no binding read) and where no
 * HYPERDRIVE_JOB is bound, so both page calls stay unconfigured.
 */
export const stagingTestPhone: (part: TestPhonePart) => TestPhoneInputs | null = ({ env, db }) => {
  if (environmentOf(env) !== "staging" || !isBound(env.HYPERDRIVE_JOB)) return null;
  return {
    access: {
      async standing(tokenSha256, at) {
        // The hash and the time alone, as the handler gives them: never the token.
        const answer = await db.runtime(READ_TESTER_STANDING_CALL, (sql) =>
          readTesterStanding(sql, { tokenSha256, at }),
        );
        return standingOf(answer);
      },
    },
    roster: {
      async phone(testPhoneId) {
        const entry = rosterEntryOf(testPhoneId);
        // Not on the roster's list: no roster phone by that id, and nothing is read.
        if (entry === null) return null;
        const { handleId } = entry;
        const answer = await db.runtime(READ_ROSTER_PHONE_CALL, (sql) => readRosterPhone(sql, { handleId }));
        return rosterPhoneOf(entry.testPhoneId, handleId, answer);
      },
    },
    phones: {
      async state(number) {
        const answer = await db.runtime(READ_PHONE_STATE_CALL, (sql) => readPhoneState(sql, { number }));
        return phoneStateOf(answer, () => rosieNumberOf(env.ROSIE_NUMBER));
      },
    },
    line: stagingLineOf(env),
  };
};
