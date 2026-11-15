// Contract test for K-05, the data-access calls: the database side of v1.3, v1.4, v1.6, v1.7, v1.8, v1.9, v1.10,
// v1.11 and v1.14 (T-1169; T-1199 for v1.6; T-1214 for v1.7; T-1218 for v1.8; T-1232 for v1.9; T-1260 for v1.10, the
// D-017 path audit's Q1; T-1270 for v1.11; T-1355 for v1.14; DL-348, DL-373, DL-398, DL-444, DL-456, DL-474, DL-506,
// DL-511, DL-687, DL-698, DL-760, DL-761, DL-766, DL-775, DL-778; contracts/data-access/README.md sections "v1.3",
// "v1.4", "v1.6", "v1.7", "v1.8", "v1.9", "v1.10", "v1.11" and "v1.14", their "Consumers of" lists, "Fixtures", and
// "Producers and consumers").
//
// v1.14 (T-1355; README item 67): claimOutbox with sendClass safety, the safety-only claim of a danger line's own wake
// (T-1354, db/repo/outbox.ts claimOutboxV114). Its nine fixtures run here as every side entry does, with what is its
// own: a claim of v1.14 runs through claimOutboxV114, while a claim of an earlier version a chain runs first keeps the
// claim of its own version (SAFETY_CLAIM: v1's own, or v1.2's, as before); each fixture's note lists the rows its
// database side writes itself before the claim, its danger line's turn and row, as commit-alex-safety's and
// write-plan-alex-safety's requests write Alex's first line, and for claim-safety-past-ten-checked-rows the ten routine
// notices too (DANGER_LINES, noticeRows; NOTED_ROWS); the outbox after a claim holds the claims its answer gives and
// every other row as it was (claimProblems); two refused exchanges are refused for their request (REQUEST_TWINS: no
// recipient, another class) and two for their outcome (EXCHANGE_TWINS: a routine row claimed too, a held row listed);
// and two cases no fixture shows end the file: row S's (a quick_reply outage row sending under a live claim, ahead of
// a safety row, never read or locked) and a claim without sendClass through claimOutboxV114, answered in v1.13 item
// 64's form with the rows and fields claimOutboxV113 gives (DL-761).
//
// The fixture part, data-access.v1.test.ts, checks every fixture against the schema of its version. This part is the
// producer's side (C-152) for the versions whose calls the database engineer built: v1.3's three turn-face reads
// (T-1138, db/repo/turn-face-reads.ts), v1.4's seven safety reads (T-1161, db/repo/safety-reads.ts), v1.6's
// businessSensitive on readOutboxRow (T-1197, db/repo/turn-face-reads.ts: the row's business's sensitive switch, read
// from K-23's company_kinds; README item 45), v1.7's openChatOnText (T-1212, db/repo/chat-open.ts: a number's text
// opens its chat, writing its phone row and one phone.chat_opened entry; README item 46), v1.8's sendState (T-1216,
// db/repo/send-state.ts: limit 8's read, whose texts consent row says who gave the yes and for which booking,
// fromContact and bookingId, read from K-29's consents and the turn that wrote the row; README item 47), v1.9's
// markPart (T-1227, db/repo/outbox.ts markPartV12: a delivery receipt that repeats a recorded delivery says what it
// repeats, repeatedDelivery, whether that delivery was the row's first and when, read from the delivered_at of the
// row's part tries with nothing written, and null on every other answer; README item 48: REPEAT, MARKS), v1.10's
// three reads on the runtime side (T-1258, db/repo/arming-reads.ts: readQuestionFacts, the facts the clock arming's
// due rule reads about one open question, and readHandle, a handle's kind and address by its id; T-1259,
// db/repo/threads.ts: readChatHandle, the phone handle a Linq chat id names, or none; README items 49 to 51) and
// v1.11's party read on the runtime side (T-1269, db/repo/turn-party.ts: readTurnParty, the handle's party for a turn,
// the handle's id, the one business its people may act for or none, the person and that business's zone, or
// businessUndecided with its reason where the rows give no one business; README item 52). v1.5 adds no database call
// (README "v1.5": rowReader is the consumers' mapping), so it has no database side. Every entry of
// fixtures/index.json whose version is one of DB_SIDE_VERSIONS runs here, selected by its version, never by a pinned
// list or count (DL-124, DL-125), against local PostgreSQL with every migration applied to a fresh schema
// (db/repo/test-db.ts), in a database of this file's own, so a claim in a chain never meets another run's lock on the
// same recipient (an advisory lock is per database; T-1251):
//   - each accepted exchange: its given is loaded (its k04Seeds and partSeeds, each with its own after chain, and the
//     exchanges its after chain names, run first through db/repo, each answering its own fixture's outcome, a call no
//     side entry names through CHAIN_CALLS, the gateway's handleSealingKey before read-turn-party-first-text under a
//     wrapping key made for this run among them, and a v1 claim through K-05 v1's own claimOutbox, V1_CHAIN_CALLS, with
//     the saved-time clock row a held reserve gets, which db/repo's reserve does not write yet: SAVED_TIME; then the
//     rows its note says its database side writes itself, where no frozen seed holds them: NOTED_ROWS, the practice's
//     five rows, before read-chat-handle-sam S1-01's thread, which K-09 v1.5's turn 1 commit writes and no K-05 exchange
//     does, and before five v1.11 reads the rows their notes list, PARTY_NOTES: test owner 1's as T-1148's
//     SKELETON_ROWS, the second company and its business, the two companies with no business yet, Hugo P.'s person and
//     owner role, and Sam's ended owner role); then its request goes through the db/repo call it names, in the role and
//     on the side the README gives that call (items 28, 34 to 43, 46, 47 and 49 to 52; commitTurn per write, as
//     rosie_job). The answer is the fixture's outcome, and the answer and the exchange that holds it are valid against
//     the schema of the entry's own version (a v1.10 read's notFound, a handle or a chat no row holds, and v1.11's
//     unknown handle and its undecided business, an error, among them), a v1.8 sendState answer against
//     sendState.v1dot8Response, which states fromContact and bookingId always (CONSENT_SOURCE). For a call that writes
//     (WRITERS: v1.7's openChatOnText), the tables then hold what the answer gives: the row as the call leaves it and
//     the one entry it appends, or nothing written. A v1.9 markPart answer is judged by markPart.v1dot9Response, which
//     states repeatedDelivery and the row always (REPEAT), and the outbox then holds what it gives (MARKS): a repeat
//     wrote nothing, the row is the answer's, a recorded delivery is the part try's at the receipt's time, and the
//     delivery a repeat names is the part try's as stored, the row's first by the stored times. Three answers are
//     compared otherwise, each with a field a later version adds, never with one dropped: db/repo answers a
//     readOutboxRow exchange of a version before v1.6 as v1.6 does, which always states businessSensitive (SWITCH), so
//     its answer is the fixture's outcome, whole, with businessSensitive null and nothing else changed (the exchange's
//     world holds no kind of work, checked before the read), valid at v1.6, whose readOutboxRow.v1dot6Response is a
//     v1.6 answer; a v1.1 claim a chain runs first is answered as v1.2 does, each claimed row naming its port (PORT),
//     valid at v1.2; and a mark of a version before v1.9 a chain runs first is answered as v1.9 does, its outcome with
//     repeatedDelivery null and nothing else changed (REPEAT: none of them repeats a delivery), valid at v1.9;
//   - each refused request: the db/repo call refuses it before any statement reaches the database, so nothing is read or
//     written; a refused request its fixture holds in an exchange (REQUEST_TWINS: v1.10's
//     refuse-question-facts-caller-business, a facts request naming a business beside the question, and v1.11's
//     refuse-turn-party-caller-business, a party request naming the business it wants beside the handle) is refused the
//     same way in its own given, its twin's but for its note, with the rows its twin's note lists written before it
//     (notedRowsOf), and with its one fault taken out, its twin's request, db/repo answers it the outcome the two
//     fixtures share;
//   - each refused answer (its definition a call's response, v1.6's readOutboxRow.v1dot6Response, v1.8's
//     sendState.v1dot8Response, v1.9's markPart.v1dot9Response, or a call's errors, v1.11's readTurnParty.errors, which
//     refuses an undecided business answered with the businesses found): in the state of the accepted exchange that
//     answers the same read or mark (its twin), db/repo's answer is valid against the refused entry's own definition,
//     at the version db/repo answers the twin, which refuses the fixture too, and it differs from the refused fixture
//     only at the fault the fixture carries (and at businessSensitive alone where db/repo answers an earlier twin as
//     v1.6): the repo answers it put right, never as it stands;
//   - each refused exchange whose fault is its outcome (EXCHANGE_TWINS: v1.7's refuse-open-chat-stopped-number, v1.9's
//     refuse-mark-delivered-repeat-null): in its own given, its twin's but for its note, db/repo answers its request
//     with the twin's outcome, which differs from the refused one only at its fault, the exchange with that answer is
//     accepted, and nothing is written (for a mark, to the outbox, its claims, the clock rows or the log: MARKS).
// So a call of db/repo that drifts from the frozen contract fails this test. The repo's own tests (db/repo/*.int.test.ts)
// hold the rest of the producer's side for these calls: other businesses' rows, the column lists, the roles refused,
// for openChatOnText parallel texts, a STOP and a START around the call, and its transient answers, and for sendState
// the rows no v1.8 fixture shows (a yes by text in another handle's turn, a page's yes, an email contact's yes, a START
// with no turn beside a yes with no turn that is not one), and for markPart the repeats no v1.9 fixture shows (two parts
// delivered at one time, a receipt recorded after a later-timed one, a second report at another time, a repeated sent
// and failed mark: db/repo/outbox.int.test.ts, T-1227), and for v1.10's reads the rows no v1.10 fixture holds (the
// never-delivered rows default 92 orders, the threads its cases add beside the seeds') and every statement each read
// sends: its tables and columns, the question's own business named beside each key, no visit's address, no message's
// words and no column of sealing_keys, and one read-only transaction per read (db/repo/arming-reads.int.test.ts,
// T-1258; db/repo/threads-chat-handle.int.test.ts, T-1259), and for v1.11's read the cases no v1.11 fixture shows (two
// people on one handle, a live role beside a company with no business yet, two reasons at once, a kind that is not the
// stored handle's), every statement it sends and that nothing is written (db/repo/turn-party.int.test.ts, T-1269).
//
// It needs PostgreSQL: `npm run db:up` locally (DATABASE_URL, else the local Docker database when CI is unset), and the
// merge check's service database (DATABASE_URL) in CI.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readHandle, readQuestionFacts } from "../../db/repo/arming-reads";
import { openChatOnText } from "../../db/repo/chat-open";
import { armClock } from "../../db/repo/clocks";
import { commitTurn } from "../../db/repo/commit-turn";
import { handleSealingKey } from "../../db/repo/handle-keys";
import {
  claimOutbox,
  claimOutboxV113,
  claimOutboxV114,
  claimOutboxV12,
  markPartV12,
  markRow,
  markRowV12,
  writePlan,
} from "../../db/repo/outbox";
import { reserve } from "../../db/repo/reservations";
import {
  readBusinessOwner,
  readBusinessZone,
  readOutboxRowWritten,
  readSafetyHold,
  readSafetyHoldOfOutcome,
  readSafetyOutcome,
  readSafetyOutcomeOfEvent,
} from "../../db/repo/safety-reads";
import type { Sql, Tx } from "../../db/repo/scope";
import { sendState } from "../../db/repo/send-state";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { readChatHandle } from "../../db/repo/threads";
import { readFixedLineFacts, readOpenHolds, readOutboxRow } from "../../db/repo/turn-face-reads";
import { readTurnParty } from "../../db/repo/turn-party";
import { SKELETON_ROWS } from "../../db/seeds/skeleton";
import { CONTRACTS_ROOT, REPO_ROOT, type FixtureEntry } from "./_harness";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
const DB_SCHEMA_DIR = path.join(CONTRACTS_ROOT, "db-schema");
const CORE_SEEDS_DIR = path.join(DB_SCHEMA_DIR, "core", "fixtures");
/** K-09's fixtures: turn 1's commit, whose stated writes hold S1-01's thread (README "Fixtures", v1.10). */
const TOOL_API_FIXTURES_DIR = path.join(CONTRACTS_ROOT, "tool-api", "fixtures");
/** Fixture set v1's demo shops (rule 9): a kind of work a note lists takes its facts from its shop. */
const SHOPS_DIR = path.join(REPO_ROOT, "fixtures", "v1", "test-kit", "shops");
const SLOW = { timeout: 60_000 };

/**
 * The versions with a database side here: v1.3 (T-1138), v1.4 (T-1161), v1.6 (T-1197), v1.7 (T-1212), v1.8 (T-1216),
 * v1.9 (T-1227), v1.10 (T-1258, T-1259), v1.11 (T-1269) and v1.14 (T-1354). v1 to v1.2's database sides are tasks of
 * their own (README: T-116, T-478), and v1.5 has none. v1.12, v1.13 and v1.15 join with their own QA tasks (README
 * "Consumers of v1.12": "after the database engineer's reads"; v1.13's is T-1292); v1.14 joined ahead of them
 * (T-1355), since the first text's send waits on its claim (DL-778).
 */
const DB_SIDE_VERSIONS = ["v1.3", "v1.4", "v1.6", "v1.7", "v1.8", "v1.9", "v1.10", "v1.11", "v1.14"];

interface Given {
  k04Seeds: string[];
  partSeeds?: string[];
  after: string[];
  now: string;
  note?: string;
}

interface Exchange {
  call: string;
  given: Given;
  request: Record<string, Json>;
  outcome: Record<string, Json>;
}

interface SeedRow {
  table: string;
  values: Record<string, Json>;
}

interface SeedFile {
  after: string[];
  rows: SeedRow[];
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an answer is one of its call's errors. */
const isError = (answer: unknown): boolean => isRecord(answer) && "error" in answer;

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
const entryOf = (file: string): FixtureEntry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry ${file}`,
  );
/** Every entry of a version with a database side, in the index's order. */
const sideEntries = entries.filter((entry) => DB_SIDE_VERSIONS.includes(entry.version));
const sideAccepted = sideEntries.filter((entry) => entry.expect === "accept");
const sideRefused = sideEntries.filter((entry) => entry.expect === "refuse");

/** A fresh copy of a fixture of this folder. */
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;

/** `<call>.<part>`: the call a definition belongs to, and its part (exchange, request, response). */
function defOf(entry: FixtureEntry): { call: string; part: string } {
  const def = must(entry.def, `${entry.file}'s def`);
  const dot = def.lastIndexOf(".");
  if (dot < 1) throw new Error(`${entry.file}: ${def} is no <call>.<part> definition`);
  return { call: def.slice(0, dot), part: def.slice(dot + 1) };
}

/**
 * The parts of a definition that name an answer: a call's response; v1.6's readOutboxRow.v1dot6Response, the answer a
 * v1.6 call gives (README item 45), which refuses refuse-outbox-row-switch-left-out; v1.8's
 * sendState.v1dot8Response, the answer a v1.8 call gives (item 47), which refuses refuse-send-state-yes-source-left-out
 * and refuse-send-state-booking-left-out; v1.9's markPart.v1dot9Response, the answer a v1.9 call gives (item 48),
 * which refuses refuse-mark-repeat-delivery-left-out; and a call's errors, an answer too (an exchange's outcome is its
 * call's response or one of its errors): v1.11's readTurnParty.errors (item 52) refuses
 * refuse-turn-party-undecided-names-businesses, an undecided business answered with the businesses found.
 */
const ANSWER_PARTS: readonly string[] = [
  "response",
  "v1dot6Response",
  "v1dot8Response",
  "v1dot9Response",
  "errors",
];
const isAnswerDef = (entry: FixtureEntry): boolean => ANSWER_PARTS.includes(defOf(entry).part);

/** A version's major and minor number: v1.3 is [1, 3]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`the index names a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/** Whether `earlier` is an earlier minor version than `later`, of the same major version. */
function isBefore(earlier: string, later: string): boolean {
  const [major, minor] = placeOf(earlier);
  const [laterMajor, laterMinor] = placeOf(later);
  return major === laterMajor && minor < laterMinor;
}

/** The later of two minor versions of one major version. */
const laterOf = (one: string, other: string): string => (isBefore(one, other) ? other : one);

// ---------------------------------------------------------------------------------------------------------------
// v1.6's switch on every readOutboxRow answer (README item 45; lead note DL-398)

/**
 * v1.6 (T-1196): readOutboxRow's answer states businessSensitive, the row's business's sensitive switch, and a v1.6
 * producer checks every answer it gives against readOutboxRow.v1dot6Response, which requires it. db/repo is that
 * producer (T-1197), so it states the switch for an exchange of every version, and an exchange of an earlier version,
 * whose outcome leaves it out and whose readOutboxRow.response is closed (v1.3), is answered as v1.6 answers it.
 */
const SWITCH = {
  call: "readOutboxRow",
  version: "v1.6",
  field: "businessSensitive",
  answerDef: "readOutboxRow.v1dot6Response",
} as const;

/** Whether db/repo answers an exchange with the switch its version leaves out: a readOutboxRow answer before v1.6. */
const addsSwitch = (entry: FixtureEntry, exchange: Exchange): boolean =>
  exchange.call === SWITCH.call && !isError(exchange.outcome) && isBefore(entry.version, SWITCH.version);

/** The version db/repo answers an exchange at, whose schema judges its answer: v1.6 where it adds the switch. */
const answeredAt = (entry: FixtureEntry, exchange: Exchange): string =>
  addsSwitch(entry, exchange) ? SWITCH.version : entry.version;

/** An earlier exchange's outcome as v1.6 answers it in a world with no kind of work: the switch null, added whole. */
const withSwitch = (outcome: Record<string, Json>): Record<string, Json> => ({
  ...outcome,
  [SWITCH.field]: null,
});

// ---------------------------------------------------------------------------------------------------------------
// v1.2's port on every claimed row (README v1.2 item 30; K-07 v1 outboxRow.port)

/**
 * v1.2 (T-072): claimOutbox's claimed row names its port, and db/repo's claim that answers the claim v1.1's exchanges
 * show (claimOutboxV12; its v1 claimOutbox answers no claim and no claimedFrom) always states it. So a v1.1 claim a
 * chain runs first (Dee W.'s, before open-chat-dee-closed-chat) is answered as v1.2 answers it: the fixture's outcome
 * with each claimed row's port added by its channel, as v1.2's claimedRow ties them (email for the email channel, linq
 * for imessage, rcs and sms), never with the field dropped from db/repo's answer, and that answer is valid at v1.2. A v1
 * claim (claim-in-order, before every v1.8 read) runs through db/repo's v1 claimOutbox, which answers v1's claimed rows
 * as v1 states them (V1_CHAIN_CALLS), so no port is added to it.
 */
const PORT = { call: "claimOutbox", version: "v1.2", field: "port" } as const;

/** K-05 v1, whose own outbox calls db/repo keeps beside v1.2's: a v1 exchange of one runs through it (V1_CHAIN_CALLS). */
const V1 = "v1";

/** Whether db/repo answers an exchange with the port its version leaves out: a claim after v1 and before v1.2. */
const addsPort = (entry: FixtureEntry, exchange: Exchange): boolean =>
  exchange.call === PORT.call &&
  !isError(exchange.outcome) &&
  isBefore(V1, entry.version) &&
  isBefore(entry.version, PORT.version);

/** An earlier claim's outcome as v1.2 answers it: each claimed row's port, by its channel, added whole. */
function withPorts(outcome: Record<string, Json>): Record<string, Json> {
  const { claimed } = outcome;
  if (!Array.isArray(claimed)) throw new Error("a claim's outcome names no claimed rows");
  return {
    ...outcome,
    claimed: claimed.map((row): Json => {
      if (!isRecord(row) || typeof row.channel !== "string")
        throw new Error("a claimed row names no channel");
      return { ...(row as Record<string, Json>), [PORT.field]: row.channel === "email" ? "email" : "linq" };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// v1.8's who gave the yes, and for which booking, on every sendState answer (README item 47)

/**
 * v1.8 (T-1102): sendState's texts consent row says who gave the yes and for which booking, and a v1.8 producer
 * "always writes both fields ... and checks every answer against sendState.v1dot8Response" (README "Consumers of v1.8").
 * db/repo is that producer (T-1216), so its answer at v1.8 or later is judged by that definition, which requires both
 * fields on a row, never by sendState.response alone, which also takes an answer of v1.2 to v1.7 with neither. Every
 * sendState exchange that runs here is v1.8's (v1.2's are its own database side's: README T-478).
 */
const CONSENT_SOURCE = {
  call: "sendState",
  version: "v1.8",
  fields: ["fromContact", "bookingId"],
  answerDef: "sendState.v1dot8Response",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// v1.9's repeatedDelivery on every markPart answer (README item 48)

/**
 * v1.9 (T-1226): markPart's answer to a delivery receipt that repeats a recorded delivery says what it repeats,
 * repeatedDelivery, and a v1.9 producer "always writes the field ... and checks every answer against
 * markPart.v1dot9Response" (README "Consumers of v1.9"). db/repo's markPartV12 is that producer (T-1227), so its answer
 * at v1.9 or later is judged by that definition, which requires the field and the row, never by markPart.response
 * alone, which also takes an answer of v1 to v1.8 with neither. It states the field for an exchange of every version,
 * so a mark of an earlier version a chain runs first (v1.2's marks of A7-03's two parts, before every v1.9 exchange:
 * README "Fixtures", v1.9), whose outcome leaves it out, is answered as v1.9 answers it: null, since none of them
 * repeats a delivery (default 87). Every mark that runs here states its row (v1.1 item 15); v1's, which state none, are
 * in no chain.
 */
const REPEAT = {
  call: "markPart",
  version: "v1.9",
  field: "repeatedDelivery",
  answerDef: "markPart.v1dot9Response",
} as const;

/** Whether an exchange is a delivery receipt answered repeated: the one answer that names what it repeats (item 48). */
const repeatsDelivery = (exchange: Exchange): boolean =>
  exchange.call === REPEAT.call &&
  exchange.request.outcome === "delivered" &&
  exchange.outcome.repeated === true;

/** Whether db/repo answers an exchange with the field its version leaves out: a markPart answer before v1.9. */
const addsRepeat = (entry: FixtureEntry, exchange: Exchange): boolean =>
  exchange.call === REPEAT.call && !isError(exchange.outcome) && isBefore(entry.version, REPEAT.version);

/**
 * An earlier mark's outcome as v1.9 answers it: repeatedDelivery null, added whole. An earlier exchange that repeats a
 * delivery is answered with the delivery the record holds, which its fixture does not state, so it is a broken test,
 * never answered null here.
 */
function withRepeat(exchange: Exchange): Record<string, Json> {
  if (repeatsDelivery(exchange)) {
    throw new Error("an earlier mark that repeats a delivery: what it repeats is the record's, never null");
  }
  return { ...exchange.outcome, [REPEAT.field]: null };
}

// ---------------------------------------------------------------------------------------------------------------
// v1.14's sendClass on claimOutbox, the safety-only claim (README item 67)

/**
 * v1.14 (T-1353): claimOutbox takes one optional field, sendClass, whose only value is safety, with a named recipient
 * alone; with it the claim waits for the recipient and walks only the recipient's safety rows, and without it the call
 * is v1.13's, answered in v1.13's form (`form`: item 64's emailPurpose and notAfter on every claimed row). db/repo's
 * claimOutboxV114 is that claim (T-1354), so a claim exchange of v1.14 runs through it (DB_CALLS). A claim of an
 * earlier version a chain runs first keeps the claim of its own version, K-05 v1's own (V1_CHAIN_CALLS) or v1.2's
 * (CHAIN_CALLS), whose answers are the fixtures' (the card's lead note, DL-698: "The chains run existing v1, v1.1 and
 * v1.2 exchanges (claim-alex-safety runs through claimOutboxV12)").
 */
const SAFETY_CLAIM = {
  call: "claimOutbox",
  version: "v1.14",
  field: "sendClass",
  value: "safety",
  form: "v1.13",
} as const;

/** Whether an entry is a claim of a version before v1.14, which the claim of its own version answers (SAFETY_CLAIM). */
const claimsBefore = (entry: FixtureEntry): boolean =>
  defOf(entry).call === SAFETY_CLAIM.call && isBefore(entry.version, SAFETY_CLAIM.version);

// ---------------------------------------------------------------------------------------------------------------
// The schemas: every schema under contracts/, as contracts:check loads them, so each $ref resolves; one strict
// validator (Ajv 2020-12), each definition taken from the schema of the version an entry lists

const SKIPPED = new Set(["node_modules", "generated"]);

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : schemaFiles(full);
    return entry.isFile() && entry.name.endsWith(".schema.json") ? [full] : [];
  });
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS_ROOT)) ajv.addSchema(readJson(file) as object);

const idOf = (version: string): string =>
  (readJson(path.join(DATA_ACCESS_DIR, `data-access.${version}.schema.json`)) as { $id: string }).$id;

/** The validator of one definition of a version's schema. */
function validatorOf(version: string, def: string): ValidateFunction {
  const key = `${idOf(version)}#/$defs/${def}`;
  return must(ajv.getSchema(key), `the schema ${key}`);
}

/** Ajv's errors as one line each; none when `value` is valid. */
function errorsOf(validate: ValidateFunction, value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? ""}`);
}

/**
 * The definition an answer is judged by at `version`: its call's errors when it is one, else the answer its call gives
 * there, which from v1.6 on is readOutboxRow.v1dot6Response for readOutboxRow (README item 45), from v1.8 on
 * sendState.v1dot8Response for sendState (item 47), from v1.9 on markPart.v1dot9Response for markPart (item 48), and
 * else its response.
 */
function answerDefOf(version: string, call: string, answer: unknown): string {
  if (isError(answer)) return `${call}.errors`;
  if (call === SWITCH.call && !isBefore(version, SWITCH.version)) return SWITCH.answerDef;
  if (call === CONSENT_SOURCE.call && !isBefore(version, CONSENT_SOURCE.version)) {
    return CONSENT_SOURCE.answerDef;
  }
  if (call === REPEAT.call && !isBefore(version, REPEAT.version)) return REPEAT.answerDef;
  return `${call}.response`;
}

/** An answer against the definition answerDefOf names for it at `version`. */
function answerErrors(version: string, call: string, answer: unknown): string[] {
  return errorsOf(validatorOf(version, answerDefOf(version, call, answer)), answer);
}

// ---------------------------------------------------------------------------------------------------------------
// Each call through db/repo, in the role and on the side the README gives it

type Role = "app" | "job";

interface DbCall {
  /** The role a request runs as: rosie_app (the Tool API's) or rosie_job (the runtime side's). */
  role: (request: Record<string, Json>) => Role;
  run: (sql: Sql, request: never, options: { now: Date }) => Promise<unknown>;
}

/** The Tool API's role under a business, the runtime side's with none (README items 34, 37 to 41; default 25). */
const byBusiness = (request: Record<string, Json>): Role => (request.businessId === null ? "job" : "app");

/**
 * The calls v1.3, v1.4, v1.7, v1.10 and v1.11 add, the calls v1.8 and v1.9 change, and the commit their chains run:
 * items 34 to 36 (v1.3), 37 to 43 (v1.4), 46 (v1.7), 47 (v1.8), 48 (v1.9), 49 to 51 (v1.10) and 52 (v1.11), each in the
 * role its row of the README's table names; commitTurn per write, on the runtime side as rosie_job (README "Scope").
 * v1.6 adds no call: businessSensitive is readOutboxRow's own (item 45, in item 35's transaction). openChatOnText runs
 * on the runtime side, as rosie_job with no business scope (item 46's table: phones and handles are scoped none), and
 * so does sendState, item 47's read inside item 28's read-only transaction (README "Consumers of v1.8"; v1.2 default
 * 25). markPart is the dispatcher's markPartV12, which answers as v1.9 does (T-1227), item 48 inside item 15's one
 * transaction as rosie_job with no business scope (README "Consumers of v1.9"); the v1.2 marks a chain runs first go
 * through it too (REPEAT). v1.10's three reads, items 49 to 51, run on the runtime side as rosie_job with no business
 * scope (README "The calls v1.10 adds": the receipt path and the clock arming work across businesses by handle, and
 * handles and threads are tables only rosie_job reads); each takes its request alone, and no time from its caller.
 * v1.11's readTurnParty, item 52, runs the same way, on the runtime side as rosie_job with no business scope (README
 * "The call v1.11 adds": the read decides which business a turn runs under, so it runs before there is a business
 * scope, and handles and person_handles are tables only rosie_job reads), with its request alone. v1.14's claimOutbox,
 * item 67, is the dispatcher's claimOutboxV114 (T-1354), one transaction on the runtime side as rosie_job with no
 * business scope (README "The call v1.14 changes"), its time the request's own now; a claim of an earlier version a
 * chain runs first does not run through it (SAFETY_CLAIM, stepCallOf).
 */
const DB_CALLS: Readonly<Record<string, DbCall>> = {
  claimOutbox: { role: () => "job", run: claimOutboxV114 },
  commitTurn: { role: () => "job", run: commitTurn },
  readOpenHolds: { role: byBusiness, run: readOpenHolds },
  readOutboxRow: { role: () => "job", run: readOutboxRow },
  readFixedLineFacts: { role: () => "job", run: readFixedLineFacts },
  readSafetyOutcomeOfEvent: { role: byBusiness, run: readSafetyOutcomeOfEvent },
  readSafetyOutcome: { role: byBusiness, run: readSafetyOutcome },
  readSafetyHold: { role: byBusiness, run: readSafetyHold },
  readSafetyHoldOfOutcome: { role: byBusiness, run: readSafetyHoldOfOutcome },
  readOutboxRowWritten: { role: byBusiness, run: readOutboxRowWritten },
  readBusinessOwner: { role: () => "job", run: readBusinessOwner },
  readBusinessZone: { role: () => "app", run: readBusinessZone },
  openChatOnText: { role: () => "job", run: openChatOnText },
  sendState: { role: () => "job", run: sendState },
  markPart: { role: () => "job", run: markPartV12 },
  readQuestionFacts: { role: () => "job", run: readQuestionFacts },
  readHandle: { role: () => "job", run: readHandle },
  readChatHandle: { role: () => "job", run: readChatHandle },
  readTurnParty: { role: () => "job", run: readTurnParty },
};

/** The one secret name K-05's fixtures name for a handle's key (handle-key-first-sight.json's wrappingKeyName). */
const WRAPPING_KEY_NAME = "SEALING_WRAP_KEY";

/**
 * The wrapping key a chain's handleSealingKey wraps a new handle's key under (K-05 v1.2 item 29: the request names the
 * secret, and the caller's resolver gives its value): made for this run, random, never a real key and never read from
 * the environment, as db/repo/turn-party.int.test.ts makes its own. The resolver answers it for that one name alone.
 */
const RUN_WRAPPING_KEY = new Uint8Array(randomBytes(32));
const WRAPPING_KEYS = {
  resolve: (name: string): Uint8Array | undefined =>
    name === WRAPPING_KEY_NAME ? RUN_WRAPPING_KEY : undefined,
};

/**
 * The calls a chain runs first that no entry of a version with a database side names: v1's reserve, which saves Alex's
 * Nov 14 time before the commit that books it (commit-first, in the chain of every v1.8 exchange: README "Fixtures",
 * v1.8), under the reservation's business as rosie_app (README "Scope": business; item 8), then SAVED_TIME; and the
 * plan, claim and limit-8 mark, which Dee W.'s waiting notice runs before open-chat-dee-closed-chat (README "Fixtures",
 * v1.7) and Alex's confirmation before every v1.8 read ("Consumers of v1.8": "its chains running v1's plan and claim
 * steps"), each on the runtime side as rosie_job (v1 items 2 to 4; v1.1 items 13 and 16): writePlan, the same in every
 * version, and the claim and the mark through v1.2's calls, which answer v1.1's claim (PORT) and its waitingChat mark. A
 * v1 claim runs through K-05 v1's own (V1_CHAIN_CALLS). A7-03's chain, before every v1.9 exchange ("Consumers of v1.9":
 * "its chains running v1's commitTurn and v1.2's plan, claim and marks"), runs the plan and v1.2's claim the same way,
 * and before the poll goes the arming of the question's clock at the words' receipt (arm-clock-a7-03-after-4006: v1
 * item 5), armClock on the runtime side as rosie_job. And before read-turn-party-first-text (README "Fixtures", v1.11:
 * "a number's first text after v1.2's handle-key-first-sight") goes the gateway's handleSealingKey, which writes the
 * number's handle, its person with no name yet and their link at receipt (v1.2 item 29), on the runtime side as
 * rosie_job, under this run's wrapping key (WRAPPING_KEYS); its answer is the call's outcome, compared with the
 * fixture's, and the data key it hands back beside the answer is left unused.
 */
const CHAIN_CALLS: Readonly<Record<string, DbCall>> = {
  reserve: { role: () => "app", run: reserve },
  writePlan: { role: () => "job", run: writePlan },
  claimOutbox: { role: () => "job", run: claimOutboxV12 },
  markRow: { role: () => "job", run: markRowV12 },
  armClock: { role: () => "job", run: armClock },
  handleSealingKey: {
    role: () => "job",
    run: async (sql, request, options) =>
      (await handleSealingKey(sql, WRAPPING_KEYS, request, options)).outcome,
  },
};

/**
 * K-05 v1's own claim, which db/repo keeps beside v1.2's (db/repo/outbox.ts: "The outbox calls come in two versions,
 * each answering its own contract's shapes"): it writes no claim row and answers v1's claimed rows, which hold no
 * claim, claimedFrom or port. So a v1 claim a chain runs first (claim-in-order, which claims Alex's confirmation before
 * every v1.8 read: README "Fixtures", v1.8) runs through it, on the runtime side as rosie_job (v1 item 3), and answers
 * its own fixture's outcome, whole, as no v1.2 claim could (PORT adds nothing to it); a v1.1 claim runs through v1.2's.
 * So does a v1 mark of a row (mark-held-for-text-hours, limit 8's hold of Sam's evening notice to 8am, which runs
 * after v1's claim-evening-notice and before v1.14's claim-safety-past-held-row: README "Fixtures", v1.14): K-05 v1's
 * own markRow (v1 item 4), on the runtime side as rosie_job, which marks a row v1's claim took, with no claim row.
 */
const V1_CHAIN_CALLS: Readonly<Record<string, DbCall>> = {
  claimOutbox: { role: () => "job", run: claimOutbox },
  markRow: { role: () => "job", run: markRow },
};

/** The calls that write: an answer gives the row it leaves and the entry it appends (item 46 step 4), or none. */
const WRITERS: readonly string[] = ["openChatOnText"];

const callOf = (call: string): DbCall => must(DB_CALLS[call], `a db/repo call for ${call}`);

/** Whether a chain step is a v1 exchange of a call whose v1 form db/repo keeps (V1_CHAIN_CALLS). */
const runsAtV1 = (step: string): boolean =>
  entryOf(step).version === V1 && Object.hasOwn(V1_CHAIN_CALLS, exchangeOf(step).call);

/**
 * The call a chain step runs through: one of DB_CALLS, else K-05 v1's own (runsAtV1), else one of CHAIN_CALLS. A claim
 * of a version before v1.14 is not DB_CALLS', which is v1.14's claim: it runs through K-05 v1's own claim or, from
 * v1.1, through v1.2's, as it did before v1.14 had a database side (claimsBefore).
 */
function stepCallOf(step: string): DbCall {
  const { call } = exchangeOf(step);
  const v1 = runsAtV1(step) ? V1_CHAIN_CALLS[call] : undefined;
  const side = claimsBefore(entryOf(step)) ? undefined : DB_CALLS[call];
  return must(side ?? v1 ?? CHAIN_CALLS[call], `a db/repo call for ${call}, run first`);
}

/**
 * The side entries a chain's call of that name would answer too: every side entry of the call, but for a claim those
 * of v1.14 on, which DB_CALLS' claim answers (SAFETY_CLAIM). None, for every call of CHAIN_CALLS and V1_CHAIN_CALLS:
 * a call is the side's own or a chain's at any one version, never both.
 */
const sideEntriesOfChainCall = (call: string): string[] =>
  sideEntries
    .filter((entry) => defOf(entry).call === call)
    .filter((entry) => call !== SAFETY_CLAIM.call || claimsBefore(entry))
    .map((entry) => entry.file);

/**
 * Each refused answer of a version with a database side, with its twin: the accepted exchange that answers the same
 * read, whose state and request this test gives db/repo; `part`, when the refused answer shows only one piece of the
 * twin's (one hold of two); and `faults`, the places the refused fixture carries its fault (README "Fixtures": each
 * refused for one reason).
 */
const RESPONSE_TWINS: Readonly<Record<string, { twin: string; part?: string; faults: string[] }>> = {
  // v1.3
  "invalid/refuse-open-holds-hold-with-words.json": {
    twin: "read-open-holds-alex.json",
    part: "holds.0",
    faults: ["holds.0.sealedWords"],
  },
  "invalid/refuse-outbox-row-returns-inbound-words.json": {
    twin: "read-outbox-row-s1-02.json",
    faults: ["answers.texts.0.words"],
  },
  "invalid/refuse-outbox-row-returns-address.json": {
    twin: "read-outbox-row-s1-02.json",
    faults: ["recipient.address"],
  },
  "invalid/refuse-fixed-line-facts-returns-number.json": {
    twin: "fixed-line-facts-s1-02.json",
    faults: ["phoneNumber"],
  },
  // v1.4
  "invalid/refuse-safety-outcome-with-sealed-words.json": {
    twin: "read-safety-outcome-of-event-alex.json",
    faults: ["safetyOutcome.sealedWords"],
  },
  "invalid/refuse-safety-hold-released-without-why.json": {
    twin: "read-safety-hold-alex-released.json",
    faults: ["hold.releasedWhy"],
  },
  "invalid/refuse-safety-hold-of-outcome-two-holds.json": {
    twin: "read-safety-hold-of-outcome-alex-threat.json",
    faults: ["hold"],
  },
  "invalid/refuse-outbox-row-written-returns-words.json": {
    twin: "outbox-row-written-alex-safety.json",
    faults: ["finalParts"],
  },
  "invalid/refuse-business-owner-returns-number.json": {
    twin: "business-owner-barbershop.json",
    faults: ["owner.address"],
  },
  "invalid/refuse-business-zone-null.json": {
    twin: "business-zone-barbershop.json",
    faults: ["timeZone"],
  },
  // v1.6: both are the practice's answer, put right (README "Fixtures")
  "invalid/refuse-outbox-row-switch-left-out.json": {
    twin: "read-outbox-row-practice-sensitive.json",
    faults: ["businessSensitive"],
  },
  "invalid/refuse-outbox-row-switch-per-flow.json": {
    twin: "read-outbox-row-practice-sensitive.json",
    faults: ["businessSensitive"],
  },
  // v1.8: each is its twin's outcome, put right (README "Consumers of v1.8")
  "invalid/refuse-send-state-yes-source-left-out.json": {
    twin: "send-state-business-yes.json",
    faults: ["textsConsent.fromContact"],
  },
  "invalid/refuse-send-state-booking-left-out.json": {
    twin: "send-state-own-yes-one-booking.json",
    faults: ["textsConsent.bookingId"],
  },
  "invalid/refuse-send-state-stop-read-as-own-yes.json": {
    twin: "send-state-stop-row.json",
    faults: ["textsConsent.fromContact"],
  },
  // v1.9: each is the words' repeat's outcome, put right (README "Consumers of v1.9")
  "invalid/refuse-mark-repeat-delivery-left-out.json": {
    twin: "mark-a7-03-delivered-repeat.json",
    faults: ["repeatedDelivery"],
  },
  "invalid/refuse-mark-repeat-says-first-delivery.json": {
    twin: "mark-a7-03-delivered-repeat.json",
    faults: ["firstDelivery"],
  },
  // v1.10: each is its twin's outcome, put right (README "Consumers of v1.10")
  "invalid/refuse-question-facts-visit-address.json": {
    twin: "read-question-facts-a7-03.json",
    faults: ["visit.address"],
  },
  "invalid/refuse-read-handle-phone-not-e164.json": {
    twin: "read-handle-sam.json",
    faults: ["handle.address"],
  },
  // The one fault is the email handle the answer names, by its id, its kind and its address: the chat's handle is
  // Alex's phone (item 51, default 94).
  "invalid/refuse-chat-handle-email.json": {
    twin: "read-chat-handle-alex.json",
    faults: ["handleId", "handle.kind", "handle.address"],
  },
  // v1.11: each is its twin's outcome, put right (README "Consumers of v1.11"); the first is refused by its call's
  // errors, an undecided business that names the businesses it found
  "invalid/refuse-turn-party-undecided-names-businesses.json": {
    twin: "read-turn-party-several-businesses.json",
    faults: ["businessIds"],
  },
  "invalid/refuse-turn-party-business-zone-null.json": {
    twin: "read-turn-party-test-owner-1.json",
    faults: ["zone"],
  },
  "invalid/refuse-turn-party-no-business-zone-utc.json": {
    twin: "read-turn-party-first-text.json",
    faults: ["zone"],
  },
};

/**
 * Each refused exchange of a version with a database side whose one fault is its outcome, with its twin: the accepted
 * exchange whose given (but its note) and request it shares, whose outcome db/repo answers in the refused fixture's own
 * given (README "Fixtures": put right, each is its accepted twin's); and `faults`, the places of the refused outcome
 * that carry its one fault. A refused exchange whose fault is its request is in REQUEST_TWINS.
 */
const EXCHANGE_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // v1.7: a text that opens Ben T.'s stopped chat by clearing his stop, which is its answer, its row and its entry; the
  // handle is the same (README "Consumers of v1.7": twin open-chat-ben-stopped, its outcome, nothing written)
  "invalid/refuse-open-chat-stopped-number.json": {
    twin: "open-chat-ben-stopped.json",
    faults: ["result", "phone", "event"],
  },
  // v1.9: the poll's receipt again, answered as if it repeated no delivery (README "Consumers of v1.9": twin
  // mark-a7-03-poll-delivered-repeat, its outcome, nothing written)
  "invalid/refuse-mark-delivered-repeat-null.json": {
    twin: "mark-a7-03-poll-delivered-repeat.json",
    faults: ["repeatedDelivery"],
  },
  // v1.14: a safety claim answered with Sam's first routine notice claimed ahead of his danger line; the claimed list
  // is one row longer, so it differs as a whole (README "Fixtures", v1.14: twin claim-safety-past-ten-checked-rows,
  // its outcome)
  "invalid/refuse-safety-claim-takes-routine-row.json": {
    twin: "claim-safety-past-ten-checked-rows.json",
    faults: ["claimed"],
  },
  // v1.14: a safety claim answered with Sam's held routine row listed, as an ordinary claim lists it (README
  // "Fixtures", v1.14: twin claim-safety-past-held-row, its outcome)
  "invalid/refuse-safety-claim-lists-held-row.json": {
    twin: "claim-safety-past-held-row.json",
    faults: ["passedHeld"],
  },
};

/**
 * Each refused exchange of a version with a database side whose one fault is its request, a refused request its
 * fixture holds in an exchange, with its twin: the accepted exchange whose given (but its note) and outcome it shares,
 * and whose request it is with the fault taken out (README "Fixtures", v1.10: "twin read-question-facts-s1-02, its
 * request"); and `faults`, the places of the refused request that carry its one fault. db/repo refuses such a request
 * before any statement reaches the database, as it refuses a refused request that stands alone.
 */
const REQUEST_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // v1.10: a facts request naming a business beside the question, which the read takes from the question's own row
  // (README item 49; "Consumers of v1.10": twin read-question-facts-s1-02, its request)
  "invalid/refuse-question-facts-caller-business.json": {
    twin: "read-question-facts-s1-02.json",
    faults: ["businessId"],
  },
  // v1.11: a party request naming the business it wants the turn to run under beside the handle, which the read takes
  // from the rows (README item 52; "Consumers of v1.11": twin read-turn-party-test-owner-1, its request); its given's
  // rows are its twin's, written before it (notedRowsOf)
  "invalid/refuse-turn-party-caller-business.json": {
    twin: "read-turn-party-test-owner-1.json",
    faults: ["businessId"],
  },
  // v1.14: a safety claim made with no recipient, and a claim with sendClass is made for one named recipient alone
  // (README item 67, default 134; "Fixtures", v1.14: twin claim-safety-past-live-safety-claim, its request); its
  // given's danger line is its twin's, written before it (notedRowsOf)
  "invalid/refuse-claim-safety-no-recipient.json": {
    twin: "claim-safety-past-live-safety-claim.json",
    faults: ["recipientHandleId"],
  },
  // v1.14: a claim asking for send class routine, and sendClass names safety alone (README item 67, default 133;
  // "Fixtures", v1.14: twin claim-safety-past-routine-live-claim, its request)
  "invalid/refuse-claim-safety-other-class.json": {
    twin: "claim-safety-past-routine-live-claim.json",
    faults: ["sendClass"],
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Comparing a refused answer with db/repo's

const stepsOf = (at: string): string[] => (at === "" ? [] : at.split("."));

/** The value at a dotted path; a missing step is a broken test. */
function valueAt(value: unknown, at: string): unknown {
  let node = value;
  for (const step of stepsOf(at)) {
    if (Array.isArray(node) && /^\d+$/.test(step) && Number(step) < node.length) node = node[Number(step)];
    else if (isRecord(node) && Object.hasOwn(node, step)) node = node[step];
    else throw new Error(`no ${step} on the way to ${at}`);
  }
  return node;
}

/** The dotted paths at which two JSON values differ, under `at`; an array whose length changed differs as a whole. */
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const inside = (step: string | number): string => (at === "" ? String(step) : `${at}.${String(step)}`);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((item: unknown, place) => differences(item, b[place], inside(place)));
  }
  if (isRecord(a) && isRecord(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      differences(a[key], b[key], inside(key)),
    );
  }
  return [at];
}

/** Whether a place is the field at `at` or inside it. */
const within = (place: string, at: string): boolean => place === at || place.startsWith(`${at}.`);

/**
 * Each way db/repo's answer fails to be the refused answer put right, none when it is: they differ, and only at the
 * refused fixture's faults (compared at `part` when given), and each fault is a place they differ. `added` names the
 * fields of the answer's version that the refused fixture's version leaves out (v1.6's businessSensitive, where db/repo
 * answers an earlier twin as v1.6): such a field may differ only where the answer holds it and the refused fixture
 * holds none, and it excuses no other place.
 */
export function twinProblems(
  refused: unknown,
  answer: unknown,
  twin: { part?: string; faults: readonly string[]; added?: readonly string[] },
): string[] {
  const at = twin.part ?? "";
  const isAdded = (place: string): boolean =>
    (twin.added ?? []).includes(place) &&
    isRecord(answer) &&
    Object.hasOwn(answer, place) &&
    isRecord(refused) &&
    !Object.hasOwn(refused, place);
  const differ = differences(valueAt(refused, at), valueAt(answer, at), at).filter(
    (place) => !isAdded(place),
  );
  const problems: string[] = [];
  if (differ.length === 0) problems.push("db/repo answers the refused fixture as it stands");
  for (const place of differ) {
    if (!twin.faults.some((fault) => within(place, fault))) {
      problems.push(`db/repo's answer differs at ${place}, which is not the fault`);
    }
  }
  for (const fault of twin.faults) {
    if (!differ.some((place) => within(place, fault) || within(fault, place))) {
      problems.push(`the fault ${fault} is not where db/repo's answer differs`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The rows a fixture's note says its database side writes itself (README "Fixtures", v1.6)

/** A value a row holds as text; anything else is a broken test. */
function textOf(value: Json | undefined, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} is no text`);
  return value;
}

/** The bundle K-04's seed-bundle-registry.json registers, which a note's turn and row name. */
function seedBundle(): { hash: string; build: number } {
  const seed = readJson(path.join(CORE_SEEDS_DIR, "seed-bundle-registry.json")) as SeedFile;
  const { hash, build } = must(
    seed.rows.find((row) => row.table === "bundles"),
    "seed-bundle-registry.json's bundle",
  ).values;
  if (typeof build !== "number") throw new Error("seed-bundle-registry.json's bundle has no build");
  return { hash: textOf(hash, "seed-bundle-registry.json's bundle hash"), build };
}

/** A demo shop of fixture set v1 (test-kit/shops/<id>.json): the facts its kind of work lists. */
const shopFactsOf = (id: string): string[] =>
  (readJson(path.join(SHOPS_DIR, `${id}.json`)) as { facts: string[] }).facts;

/**
 * read-outbox-row-practice-sensitive.json's five rows, in its note's order and with its note's values (no frozen seed
 * holds a business with a sensitive kind of work): Lee Associates' business head (fixture set v1's therapist demo shop's
 * flow A business), its company, owned by Sam, its one kind of work, therapist, with the facts therapist.json lists and
 * the switch on in flow A only, the turn of Alex's first text there, and the row that answers it, which asks nothing,
 * both in the bundle of K-04's seed-bundle-registry.json.
 */
function practiceRows(): SeedRow[] {
  const bundle = seedBundle();
  const business = "biz-lee-associates";
  const company = "company-lee-associates";
  const turn = "turn-alex-lee-associates-first";
  const trace = "trace-alex-lee-associates-0001";
  return [
    {
      table: "businesses",
      values: {
        id: business,
        name: "Lee Associates",
        display_name: "Lee Associates",
        status: "live",
        time_zone: "America/New_York",
        text_hours_start: "08:00",
        text_hours_end: "20:00",
        version: 1,
      },
    },
    {
      table: "companies",
      values: {
        id: company,
        owner_person_id: "person-sam",
        name: "Lee Associates",
        business_id: business,
        version: 1,
      },
    },
    {
      table: "company_kinds",
      values: {
        company_id: company,
        kind_id: "therapist",
        business_id: business,
        trade_name: null,
        pf_facts: shopFactsOf("therapist"),
        pf_switches_a: ["sensitive"],
        pf_switches_b: [],
        version: 1,
      },
    },
    {
      table: "turns",
      values: {
        id: turn,
        handle_id: "handle-alex",
        event_ids: ["evt-alex-lee-associates-0001"],
        state: "committed",
        bundle_hash: bundle.hash,
        bundle_build: bundle.build,
        trace_id: trace,
        joined_trace_ids: [],
        tries: 1,
        committed_at: "2026-10-26T15:00:03Z",
        version: 1,
      },
    },
    {
      table: "outbox_rows",
      values: {
        id: "out-alex-lee-associates-first",
        turn_id: turn,
        recipient_handle_id: "handle-alex",
        recipient_person_id: "person-alex",
        business_id: business,
        booking_id: null,
        channel: "imessage",
        send_class: "quick_reply",
        versions_read: [],
        open_question_id: null,
        plan: null,
        final_parts: null,
        state: "planned",
        bundle_hash: bundle.hash,
        bundle_build: bundle.build,
        trace_id: trace,
        version: 1,
      },
    },
  ];
}

/** v1.6's practice fixture, whose note lists five rows (README "Fixtures", v1.6). */
const PRACTICE = "read-outbox-row-practice-sensitive.json";
/** v1.10's turn 1 receipt, whose note lists one row, S1-01's thread (README "Fixtures", v1.10). */
const CHAT_OF_TURN_1 = "read-chat-handle-sam.json";
/** K-09's turn 1 commit, whose given.stated.writes holds S1-01's thread (K-09 v1.5 defaults 135 and 136). */
const TURN_1_COMMIT = "commit-s1-01.json";

/** What this test reads of K-09's turn 1 commit: the rows its walk states, and the rows its answer lists as written. */
interface StatedCommit {
  given: { stated: { writes: { state: { op: string; table: string; values: Record<string, Json> }[] } } };
  outcome: { written: { written: { table: string; rowId: string; version: number }[] } };
}

/**
 * read-chat-handle-sam.json's one row, with its note's columns and values in its note's order (README "Fixtures",
 * v1.10: "No frozen seed holds S1-01's thread, which K-05's commit-s1-01-sam leaves to K-09 v1.5's commit-s1-01.json"):
 * S1-01's thread, handle-sam's chat with Rosie's number, with the Linq chat id turn 1's commit writes on it, the id the
 * receipt for Sam's reply carries. The row is that commit's stated write, at the version its answer lists.
 */
function chatThreadRows(): SeedRow[] {
  return [
    {
      table: "threads",
      values: {
        id: "thread-s1-01-sam-1",
        handle_id: "handle-sam",
        kind: "chat",
        booking_id: null,
        linq_chat_id: "linq-chat-demo-sam",
        reply_address: null,
        version: 1,
      },
    },
  ];
}

/** v1.11's turn 1 party, whose note lists test owner 1's five rows (README "Fixtures", v1.11). */
const PARTY_OF_TURN_1 = "read-turn-party-test-owner-1.json";
/** Sam with no role and the two companies of his S1-04 answer, each with its business: its note lists the second. */
const PARTY_TWO_COMPANIES = "read-turn-party-several-companies.json";
/** The same two companies before S1-09, with no business yet: its note lists Sam's rows and both companies. */
const PARTY_BEFORE_BUSINESS = "read-turn-party-sign-up-before-business.json";
/** S11-100's hand-over to Hugo P.: its note lists Hugo's person and his live owner role. */
const PARTY_HANDED_OVER = "read-turn-party-handed-over.json";
/** The same hand-over made on papers, before Hugo confirms: its note lists Sam's ended owner role. */
const PARTY_ROLE_ENDED = "read-turn-party-owner-role-ended.json";
/** K-04's seed that holds the barbershop's business head, which test owner 1's note has loaded first. */
const BUSINESS_HEAD_SEED = "seed-business-head.json";
/** K-23's seed, which holds Sam's second company and its business (the note: "as K-23's ... holds it"). */
const TWO_KINDS_SEED = "business-setup/seed-company-two-kinds.json";

/**
 * read-turn-party-test-owner-1.json's five rows, in its note's order (README "Fixtures", v1.11: "No frozen seed holds
 * test owner 1 without K-04's three owner roles"): the rows of T-1148's db/seeds/skeleton.ts, "as that seed writes
 * them (its SKELETON_ROWS)", taken from that seed's own list, so this test and the seed cannot drift: Sam, his phone
 * handle, their link, the barbershop's company and its one kind of work, which the read does not read. The seed's
 * sixth row, the barbershop's business head, is K-04's seed-business-head.json's, value for value, which the fixture's
 * given loads first, so it is not written again. The note states the person's version, 1, which the seed leaves to the
 * column's default.
 */
function testOwnerRows(): SeedRow[] {
  const { persons, handles, person_handles: links, companies, company_kinds: kinds } = SKELETON_ROWS;
  return [
    ...persons.map((row): SeedRow => ({ table: "persons", values: { ...row, version: 1 } })),
    ...handles.map((row): SeedRow => ({ table: "handles", values: { ...row } })),
    ...links.map((row): SeedRow => ({ table: "person_handles", values: { ...row } })),
    ...companies.map((row): SeedRow => ({ table: "companies", values: { ...row } })),
    ...kinds.map((row): SeedRow => ({
      table: "company_kinds",
      values: {
        ...row,
        pf_facts: [...row.pf_facts],
        pf_switches_a: [...row.pf_switches_a],
        pf_switches_b: [...row.pf_switches_b],
      },
    })),
  ];
}

/**
 * read-turn-party-several-companies.json's own two rows, written after test owner 1's, with its note's values in its
 * note's order: the business of Sam's second company from his S1-04 answer, and that company, "as K-23's
 * seed-company-two-kinds.json holds it, without that seed's owner role".
 */
function secondCompanyRows(): SeedRow[] {
  return [
    {
      table: "businesses",
      values: {
        id: "biz-lee-home-services",
        name: "Lee Home Services",
        display_name: "Lee Home Services",
        status: "saved",
        time_zone: "America/New_York",
        text_hours_start: "08:00",
        text_hours_end: "20:00",
        version: 1,
      },
    },
    {
      table: "companies",
      values: {
        id: "company-lee-home-services",
        owner_person_id: "person-sam",
        name: "Lee Home Services LLC",
        business_id: "biz-lee-home-services",
        version: 2,
      },
    },
  ];
}

/** The tables of Sam's own rows: the person, the handle and their link, before any company. */
const SAM_TABLES: readonly string[] = ["persons", "handles", "person_handles"];

/**
 * read-turn-party-sign-up-before-business.json's five rows, in its note's order (its given names no seed): Sam, his
 * phone handle and their link, "as T-1148's seed writes them", which are test owner 1's first three rows, then the two
 * companies of his S1-04 answer with no business yet, each at version 1.
 */
function signUpRows(): SeedRow[] {
  const company = (id: string, name: string): SeedRow => ({
    table: "companies",
    values: { id, owner_person_id: "person-sam", name, business_id: null, version: 1 },
  });
  return [
    ...testOwnerRows().filter((row) => SAM_TABLES.includes(row.table)),
    company("company-lee-home-services", "Lee Home Services LLC"),
    company("company-lees-barbershop", "Lee's Barbershop LLC"),
  ];
}

/**
 * read-turn-party-handed-over.json's own two rows, written after test owner 1's, with its note's values in its note's
 * order: Hugo P.'s person and his live owner role at the barbershop from the handover time (S11-100's own sample;
 * person-hugo and role-hugo-barber are examples).
 */
function newOwnerRows(): SeedRow[] {
  return [
    { table: "persons", values: { id: "person-hugo", name: "Hugo P.", language: null, version: 1 } },
    {
      table: "person_roles",
      values: {
        id: "role-hugo-barber",
        person_id: "person-hugo",
        business_id: "biz-lees-barbershop",
        role: "owner",
        ended_at: null,
        version: 1,
      },
    },
  ];
}

/**
 * read-turn-party-owner-role-ended.json's own row, written after test owner 1's, with its note's values: Sam's owner
 * role at the barbershop as it stands after the hand-over, ended at the handover time, Mon Nov 30 at 9:00am in New York.
 */
function endedRoleRows(): SeedRow[] {
  return [
    {
      table: "person_roles",
      values: {
        id: "role-sam-barber",
        person_id: "person-sam",
        business_id: "biz-lees-barbershop",
        role: "owner",
        ended_at: "2026-11-30T14:00:00Z",
        version: 2,
      },
    },
  ];
}

/**
 * By v1.11 fixture, how its note lists the rows its database side writes itself (README "Fixtures", v1.11: "five
 * fixtures' notes list the rows their database side writes itself before the read (T-1148's SKELETON_ROWS, the second
 * company, the two companies with no business, Hugo's person and role, Sam's ended role)"): `afterTestOwner`, whether
 * the note has test owner 1's rows written first, "as read-turn-party-test-owner-1's note lists them"; and `own`, the
 * rows the note lists itself, in its order.
 */
const PARTY_NOTES: Readonly<Record<string, { afterTestOwner: boolean; own: () => SeedRow[] }>> = {
  [PARTY_OF_TURN_1]: { afterTestOwner: false, own: testOwnerRows },
  [PARTY_TWO_COMPANIES]: { afterTestOwner: true, own: secondCompanyRows },
  [PARTY_BEFORE_BUSINESS]: { afterTestOwner: false, own: signUpRows },
  [PARTY_HANDED_OVER]: { afterTestOwner: true, own: newOwnerRows },
  [PARTY_ROLE_ENDED]: { afterTestOwner: true, own: endedRoleRows },
};

/** A v1.11 fixture's noted rows: test owner 1's first where its note has them written first, then its own. */
function partyRows(file: string): SeedRow[] {
  const { afterTestOwner, own } = must(PARTY_NOTES[file], `${file}'s noted rows`);
  return [...(afterTestOwner ? testOwnerRows() : []), ...own()];
}

/** v1.1's commit of Alex's first danger line, whose request every v1.14 note has its danger line's rows written as. */
const FIRST_LINE_COMMIT = "commit-alex-safety.json";
/** v1.1's plan of that line: the fixed line safetyEmergency as its plan and final parts (README "Fixtures", v1.14). */
const FIRST_LINE_PLAN = "write-plan-alex-safety.json";
/** v1.14's claim past ten checked routine notices, whose note lists the ten and their turn before its danger line. */
const PAST_TEN_NOTICES = "claim-safety-past-ten-checked-rows.json";

/** A danger line as a v1.14 note lists it: its turn, with its handle, event, trace and commit time, and its one row. */
interface DangerLine {
  turnId: string;
  handleId: string;
  personId: string;
  eventId: string;
  traceId: string;
  rowId: string;
  /** When its turn committed: the note's time of day, on the day of the claim. */
  at: string;
}

/**
 * By v1.14 fixture, the danger line its note lists, with the note's ids and time (README "Fixtures", v1.14: "each note
 * lists the two rows its database side writes itself before the claim: the turn and its one outbox row, as v1.1's
 * commit-alex-safety and write-plan-alex-safety requests write Alex's first line, with the note's ids and times").
 */
const DANGER_LINES: Readonly<Record<string, DangerLine>> = {
  "claim-safety-past-live-safety-claim.json": {
    turnId: "turn-alex-safety-0051",
    handleId: "handle-alex",
    personId: "person-alex",
    eventId: "evt-alex-0051",
    traceId: "trace-alex-0051",
    rowId: "out-alex-safety-0051",
    at: "2026-11-07T16:00:02Z",
  },
  "claim-safety-past-routine-live-claim.json": {
    turnId: "turn-sam-safety-0062",
    handleId: "handle-sam",
    personId: "person-sam",
    eventId: "evt-sam-0062",
    traceId: "trace-sam-0062",
    rowId: "out-sam-safety-0062",
    at: "2026-11-07T15:06:36Z",
  },
  "claim-safety-past-planned-row.json": {
    turnId: "turn-alex-safety-0052",
    handleId: "handle-alex",
    personId: "person-alex",
    eventId: "evt-alex-0052",
    traceId: "trace-alex-0052",
    rowId: "out-alex-safety-0052",
    at: "2026-11-07T15:06:31Z",
  },
  "claim-safety-past-held-row.json": {
    turnId: "turn-sam-safety-0063",
    handleId: "handle-sam",
    personId: "person-sam",
    eventId: "evt-sam-0063",
    traceId: "trace-sam-0063",
    rowId: "out-sam-safety-0063",
    at: "2026-11-08T01:31:00Z",
  },
  [PAST_TEN_NOTICES]: {
    turnId: "turn-sam-safety-0064",
    handleId: "handle-sam",
    personId: "person-sam",
    eventId: "evt-sam-0064",
    traceId: "trace-sam-0064",
    rowId: "out-sam-safety-0064",
    at: "2026-11-09T15:00:01Z",
  },
};

/** A value a request holds at a dotted path, as JSON; a missing step is a broken test. */
const jsonAt = (value: unknown, at: string): Json => valueAt(value, at) as Json;

/**
 * Alex's first danger line as v1.1's two requests name it: the ids a note's danger line puts its own in place of, and
 * the time its commit's exchange runs at.
 */
function firstLine(): DangerLine {
  const { request, given: state } = exchangeOf(FIRST_LINE_COMMIT);
  const rows = jsonAt(request, "writes.outboxRows");
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error(`${FIRST_LINE_COMMIT} writes one outbox row`);
  const text = (at: string): string => textOf(jsonAt(request, at), `${FIRST_LINE_COMMIT}'s ${at}`);
  return {
    turnId: text("turn.id"),
    handleId: text("turn.handleId"),
    personId: text("writes.outboxRows.0.recipientPersonId"),
    eventId: text("turn.eventIds.0"),
    traceId: text("turn.traceId"),
    rowId: text("writes.outboxRows.0.id"),
    at: state.now,
  };
}

/** A request of Alex's first danger line with another line's ids: each text that is one of the first line's, swapped. */
function withIdsOf(value: Json, line: DangerLine): Json {
  const first = firstLine();
  const swaps = new Map<string, string>([
    [first.turnId, line.turnId],
    [first.handleId, line.handleId],
    [first.personId, line.personId],
    [first.eventId, line.eventId],
    [first.traceId, line.traceId],
    [first.rowId, line.rowId],
  ]);
  const swap = (node: Json): Json => {
    if (typeof node === "string") return swaps.get(node) ?? node;
    if (Array.isArray(node)) return node.map(swap);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, swap(child)]));
  };
  return swap(value);
}

/**
 * A danger line's two rows, in the note's order: its turn, committed at the line's time, and its one outbox row, "as
 * commit-alex-safety's and write-plan-alex-safety's requests write Alex's first line", read from those two requests
 * with the line's ids in place of Alex's first line's, so this test and the frozen requests cannot drift: the row as
 * the commit writes it (send class safety, imessage, no booking, question or copy, no versions read, in the turn's
 * bundle and trace), then as the plan leaves it, checked, one version on, with the plan and the final parts the plan's
 * request holds (the fixed line safetyEmergency, the row's own id in both).
 */
function dangerLineRows(line: DangerLine): SeedRow[] {
  const commit = withIdsOf(exchangeOf(FIRST_LINE_COMMIT).request, line);
  const planned = withIdsOf(exchangeOf(FIRST_LINE_PLAN).request, line);
  const expectVersion = jsonAt(planned, "expectVersion");
  if (typeof expectVersion !== "number") throw new Error(`${FIRST_LINE_PLAN} names no version`);
  if (jsonAt(planned, "outboxRowId") !== line.rowId) throw new Error(`${FIRST_LINE_PLAN} plans another row`);
  return [
    {
      table: "turns",
      values: {
        id: jsonAt(commit, "turn.id"),
        handle_id: jsonAt(commit, "turn.handleId"),
        event_ids: jsonAt(commit, "turn.eventIds"),
        state: "committed",
        bundle_hash: jsonAt(commit, "turn.bundleId.hash"),
        bundle_build: jsonAt(commit, "turn.bundleId.build"),
        trace_id: jsonAt(commit, "turn.traceId"),
        joined_trace_ids: jsonAt(commit, "turn.joinedTraceIds"),
        tries: jsonAt(commit, "turn.tries"),
        committed_at: line.at,
        version: 1,
      },
    },
    {
      table: "outbox_rows",
      values: {
        id: jsonAt(commit, "writes.outboxRows.0.id"),
        turn_id: jsonAt(commit, "turn.id"),
        recipient_handle_id: jsonAt(commit, "writes.outboxRows.0.recipientHandleId"),
        recipient_person_id: jsonAt(commit, "writes.outboxRows.0.recipientPersonId"),
        business_id: jsonAt(commit, "writes.outboxRows.0.businessId"),
        booking_id: jsonAt(commit, "writes.outboxRows.0.bookingId"),
        channel: jsonAt(commit, "writes.outboxRows.0.channel"),
        send_class: jsonAt(commit, "writes.outboxRows.0.sendClass"),
        versions_read: jsonAt(commit, "writes.outboxRows.0.versionsRead"),
        open_question_id: jsonAt(commit, "writes.outboxRows.0.openQuestionId"),
        plan: jsonAt(planned, "plan"),
        final_parts: jsonAt(planned, "finalParts"),
        copy_of_row_id: jsonAt(commit, "writes.outboxRows.0.copyOfRowId"),
        state: "checked",
        bundle_hash: jsonAt(commit, "turn.bundleId.hash"),
        bundle_build: jsonAt(commit, "turn.bundleId.build"),
        trace_id: jsonAt(commit, "turn.traceId"),
        version: expectVersion + 1,
      },
    },
  ];
}

/** The ten routine notices' turn, as claim-safety-past-ten-checked-rows's note lists it. */
const NOTICES_TURN = {
  turnId: "turn-sam-notices-0070",
  handleId: "handle-sam",
  personId: "person-sam",
  eventId: "evt-sam-0070",
  traceId: "trace-sam-0070",
  businessId: "biz-lees-barbershop",
  channel: "imessage",
  at: "2026-11-09T14:50:00Z",
  count: 10,
} as const;

/** A notice's row id and its words, by its place of ten: out-sam-notice-01 and 'Notice 1 of 10.' */
const noticeIdOf = (place: number): string => `out-sam-notice-${String(place).padStart(2, "0")}`;
const noticeWordsOf = (place: number): string => `Notice ${String(place)} of ${String(NOTICES_TURN.count)}.`;

/**
 * claim-safety-past-ten-checked-rows's eleven rows before its danger line, in its note's order and with its note's
 * values (no chain writes them): the turn of Sam's ten routine notices, in the bundle of K-04's
 * seed-bundle-registry.json, then the ten, out-sam-notice-01 to out-sam-notice-10 (send class routine, imessage, to
 * handle-sam and person-sam at the barbershop, no booking, question or copy, no versions read), each checked at version
 * 2 with a plan of formats text and one line, 'Notice N of 10.' (role first; no question, page type or thread), and
 * final parts of one words send of those words (no calendar file, option, link, fixed line or slot).
 */
function noticeRows(): SeedRow[] {
  const bundle = seedBundle();
  const { turnId, handleId, personId, eventId, traceId, businessId, channel, at, count } = NOTICES_TURN;
  const notice = (place: number): SeedRow => {
    const id = noticeIdOf(place);
    const words = noticeWordsOf(place);
    return {
      table: "outbox_rows",
      values: {
        id,
        turn_id: turnId,
        recipient_handle_id: handleId,
        recipient_person_id: personId,
        business_id: businessId,
        booking_id: null,
        channel,
        send_class: "routine",
        versions_read: [],
        open_question_id: null,
        plan: {
          row: id,
          channel,
          copyOf: null,
          plan: {
            formats: ["text"],
            lines: [{ role: "first", text: words }],
            question: null,
            pageType: null,
            threadReplyTo: null,
          },
        },
        final_parts: {
          row: id,
          channel,
          sends: [{ kind: "words", text: words, calendarFile: "none", options: [], link: null }],
          fixedLines: [],
          slotValues: [],
          threadReplyTo: null,
        },
        copy_of_row_id: null,
        state: "checked",
        bundle_hash: bundle.hash,
        bundle_build: bundle.build,
        trace_id: traceId,
        version: 2,
      },
    };
  };
  return [
    {
      table: "turns",
      values: {
        id: turnId,
        handle_id: handleId,
        event_ids: [eventId],
        state: "committed",
        bundle_hash: bundle.hash,
        bundle_build: bundle.build,
        trace_id: traceId,
        joined_trace_ids: [],
        tries: 1,
        committed_at: at,
        version: 1,
      },
    },
    ...Array.from({ length: count }, (_, at0) => notice(at0 + 1)),
  ];
}

/**
 * A v1.14 fixture's noted rows, in its note's order: for claim-safety-past-ten-checked-rows the ten notices and their
 * turn first, committed before the danger line, then, as for every v1.14 claim, its danger line's turn and row.
 */
function safetyClaimRows(file: string): SeedRow[] {
  const line = must(DANGER_LINES[file], `${file}'s danger line`);
  return [...(file === PAST_TEN_NOTICES ? noticeRows() : []), ...dangerLineRows(line)];
}

/**
 * How a v1.14 note lists a danger line's turn, and the ten notices' turn: "the turn <id> (<handle>, event <event>,
 * trace <trace>, committed at <time of day>)".
 */
const turnPhrase = (turn: Pick<DangerLine, "turnId" | "handleId" | "eventId" | "traceId" | "at">): string =>
  `the turn ${turn.turnId} (${turn.handleId}, event ${turn.eventId}, trace ${turn.traceId}, committed at ${turn.at.slice(11)})`;

/** K-01's fixed line every danger line is, word for word (write-plan-alex-safety's note; arch 07 line 361). */
const FIXED_LINE = "safetyEmergency";
/** How a v1.14 note says a danger line is written, and how it leaves its row: checked, with the fixed line. */
const AS_FIRST_LINE = "as commit-alex-safety's and write-plan-alex-safety's requests write";
const CHECKED_WITH_FIXED_LINE = `checked at version 2 with the fixed line ${FIXED_LINE} as its plan and final parts, its own row id in both`;
/** How claim-safety-past-ten-checked-rows's note lists the danger line's row after the ten notices' own. */
const SAME_AS_NOTICES = "the same recipient, business and channel";

/**
 * Each way a v1.14 note fails to list a danger line's two rows as they are written, none when it lists them: that its
 * database side writes them itself, as v1.1's two requests write Alex's first; the turn, by its phrase (turnPhrase);
 * after it the row, by its id, its send class, and its channel, recipient and business, spelled out or, after the ten
 * notices' own, as "the same"; and after that, that it is checked at version 2 with the fixed line; and the rows hold
 * what the phrases say (a committed turn at version 1 at the note's time on the claim's day; a checked row at version
 * 2 with no booking, question or copy and no versions read).
 */
export function dangerNoteProblems(note: string, line: DangerLine, rows: readonly SeedRow[]): string[] {
  const problems: string[] = [];
  const [turn, row] = rows;
  if (rows.length !== 2 || turn?.table !== "turns" || row?.table !== "outbox_rows") {
    return ["a danger line is a turn and its one outbox row"];
  }
  if (!note.includes("this exchange's database side writes")) {
    problems.push("the note does not say its database side writes the rows");
  }
  if (!note.includes(AS_FIRST_LINE)) problems.push("the note does not name the two requests");
  const { values } = row;
  const spelledOut = `${spelled(values.channel ?? null)}, to ${spelled(values.recipient_handle_id ?? null)} and ${spelled(values.recipient_person_id ?? null)} at ${spelled(values.business_id ?? null)}, no booking, question or copy, no versions read`;
  const rowPhrase = (rest: string): string =>
    `its one row ${line.rowId} (send class ${spelled(values.send_class ?? null)}, ${rest}`;
  const phrases = [turnPhrase(line), rowPhrase(spelledOut), CHECKED_WITH_FIXED_LINE];
  let from = 0;
  for (const [at, phrase] of phrases.entries()) {
    let place = note.indexOf(phrase, from);
    if (place < 0 && at === 1) place = note.indexOf(rowPhrase(SAME_AS_NOTICES), from);
    if (place < 0) problems.push(`"${phrase}" is not listed${note.includes(phrase) ? " in this order" : ""}`);
    else from = place + 1;
  }
  const held = {
    turn: [turn.values.id, turn.values.state, turn.values.committed_at, turn.values.version],
    row: [
      values.id,
      values.turn_id,
      values.state,
      values.version,
      values.booking_id,
      values.open_question_id,
      values.copy_of_row_id,
      values.versions_read,
      valueAt(values.plan, "row"),
      valueAt(values.final_parts, "row"),
      valueAt(values.final_parts, "fixedLines"),
    ],
  };
  const said = {
    turn: [line.turnId, "committed", line.at, 1],
    row: [line.rowId, line.turnId, "checked", 2, null, null, null, [], line.rowId, line.rowId, [FIXED_LINE]],
  };
  for (const place of differences(held, said))
    problems.push(`the rows do not hold what the note says at ${place}`);
  return problems;
}

/** By fixture, the rows its note says its database side writes itself before the read: no frozen seed holds them. */
const NOTED_ROWS: Readonly<Record<string, () => SeedRow[]>> = {
  [PRACTICE]: practiceRows,
  [CHAT_OF_TURN_1]: chatThreadRows,
  ...Object.fromEntries(Object.keys(PARTY_NOTES).map((file) => [file, (): SeedRow[] => partyRows(file)])),
  ...Object.fromEntries(
    Object.keys(DANGER_LINES).map((file) => [file, (): SeedRow[] => safetyClaimRows(file)]),
  ),
};

/**
 * The rows written before a fixture's exchange, after its chain: those its own note lists (NOTED_ROWS), and for a
 * refused exchange, whose given is its twin's but for its note (EXCHANGE_TWINS, REQUEST_TWINS), those its twin's note
 * lists: v1.11's refuse-turn-party-caller-business reads test owner 1's first text "with its rows written as that
 * fixture's note lists them", and each of v1.14's four refused claims is its twin's claim, whose danger line (and ten
 * notices) its note lists. None for every other fixture.
 */
function notedRowsOf(file: string): SeedRow[] {
  const twin = EXCHANGE_TWINS[file]?.twin ?? REQUEST_TWINS[file]?.twin;
  const rows = NOTED_ROWS[file] ?? (twin === undefined ? undefined : NOTED_ROWS[twin]);
  return rows?.() ?? [];
}

/** A row value as a note spells it: a text or a number as it stands, and null as "null"; any other is a broken test. */
function spelled(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error("a note spells a text, a number or null, and no other value");
}

/** How a note that lists a row column by column writes it: "<table> <column> <value>, <column> <value>, ...". */
const spelledAs = (row: SeedRow): string =>
  `${row.table} ${Object.entries(row.values)
    .map(([column, value]) => `${column} ${spelled(value)}`)
    .join(", ")}`;

/** How a note names a row it lists: "<table> <id>", and a kind of work "company_kinds <company> and <kind>". */
const notedAs = (row: SeedRow): string =>
  row.table === "company_kinds"
    ? `${row.table} ${textOf(row.values.company_id, "a kind's company")} and ${textOf(row.values.kind_id, "a kind")}`
    : `${row.table} ${textOf(row.values.id, `a ${row.table} row's id`)}`;

/** Every text a row value holds, in a list's items too. */
const textsIn = (value: Json): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(textsIn) : [];

/**
 * The columns a v1.11 note states of a row, by table (README "Fixtures", v1.11): every column the row is written with,
 * but for a kind of work, which the note lists by its two keys alone, its other values being T-1148's seed's.
 */
const PARTY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  businesses: [
    "id",
    "name",
    "display_name",
    "status",
    "time_zone",
    "text_hours_start",
    "text_hours_end",
    "version",
  ],
  persons: ["id", "name", "language", "version"],
  handles: ["id", "kind", "address"],
  person_handles: ["person_id", "handle_id"],
  companies: ["id", "owner_person_id", "name", "business_id", "version"],
  company_kinds: ["company_id", "kind_id"],
  person_roles: ["id", "person_id", "business_id", "role", "ended_at", "version"],
};

/**
 * How a v1.11 note lists a row after its table's name: its id, then its values in parentheses, in the note's own words
 * for each table (a name in single quotes, or in double quotes when it holds one; a business's one name for both its
 * names, its zone and its text hours); a link and a kind of work, which have no id, by their two keys. A table no
 * v1.11 note lists, a column the row lacks, and a business whose two names differ are broken tests.
 */
function partyPhrase(row: SeedRow): string {
  const { table, values } = row;
  const value = (column: string): string => {
    if (!Object.hasOwn(values, column)) throw new Error(`a ${table} row with no ${column}`);
    return spelled(values[column] as Json);
  };
  const name = (): string => (value("name").includes("'") ? `"${value("name")}"` : `'${value("name")}'`);
  switch (table) {
    case "businesses":
      if (values.name !== values.display_name) throw new Error("a business whose two names differ");
      return `${value("id")} (name and display name ${name()}, status ${value("status")}, ${value("time_zone")}, text hours ${value("text_hours_start")} to ${value("text_hours_end")}, version ${value("version")})`;
    case "persons":
      return `${value("id")} (name ${name()}, language ${value("language")}, version ${value("version")})`;
    case "handles":
      return `${value("id")} (${value("kind")}, ${value("address")})`;
    case "person_handles":
      return `(${value("person_id")}, ${value("handle_id")})`;
    case "companies":
      return `${value("id")} (owner_person_id ${value("owner_person_id")}, name ${name()}, business_id ${value("business_id")}, version ${value("version")})`;
    case "company_kinds":
      return `(${value("company_id")}, ${value("kind_id")})`;
    case "person_roles":
      return `${value("id")} (${value("person_id")}, ${value("business_id")}, ${value("role")}, ended_at ${value("ended_at")}, version ${value("version")})`;
    default:
      throw new Error(`no v1.11 note lists a ${table} row`);
  }
}

/** A row's table and key: its id, or for a link and a kind of work, which have none, their two key columns. */
function rowKey(row: SeedRow): string {
  const keys =
    row.table === "person_handles"
      ? ["person_id", "handle_id"]
      : row.table === "company_kinds"
        ? ["company_id", "kind_id"]
        : ["id"];
  return `${row.table} ${keys.map((column) => spelled(row.values[column] ?? null)).join(" and ")}`;
}

/** How a v1.11 note lists a person's link beside the person and the handle it has just listed, without its keys. */
const THEIR_LINK = "and their person_handles row";

/**
 * Each way a v1.11 note fails to list `rows` as they are written, none when it lists them: each row by its table's name
 * and its phrase (partyPhrase), a second row of one table after "and" with its table named once, each after the one
 * before it, so in the rows' order; a link whose person and handle are the two rows before it may be listed as "their
 * person_handles row"; and no row holds a column its note does not state (PARTY_COLUMNS), but a kind of work.
 */
export function partyNoteProblems(note: string, rows: readonly SeedRow[]): string[] {
  const problems: string[] = [];
  let from = 0;
  for (const [at, row] of rows.entries()) {
    const stated = must(PARTY_COLUMNS[row.table], `the columns a note states of a ${row.table} row`);
    const unstated = Object.keys(row.values).filter((column) => !stated.includes(column));
    if (row.table !== "company_kinds" && unstated.length > 0) {
      problems.push(`the ${row.table} row holds ${unstated.join(", ")}, which no note states`);
    }
    const before = rows[at - 1];
    const person = rows[at - 2];
    const phrase = partyPhrase(row);
    const listed = before?.table === row.table ? `and ${phrase}` : `${row.table} ${phrase}`;
    const theirs =
      row.table === "person_handles" &&
      person?.table === "persons" &&
      person.values.id === row.values.person_id &&
      before?.table === "handles" &&
      before.values.id === row.values.handle_id;
    let place = note.indexOf(listed, from);
    if (place < 0 && theirs) place = note.indexOf(THEIR_LINK, from);
    if (place < 0) {
      problems.push(`${listed} is not listed${note.includes(listed) ? " in this order" : ""}`);
    } else {
      from = place + 1;
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The database: one fresh schema for this file, in a database of its own (T-1251), the tables' owner for seeds, and a
// client per role

let db: TestDatabase;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first. */
let job: Sql;
let typedColumns: Map<string, string>;
/** Every statement the two role clients sent, in order (postgres.js debug: the text, never the values). */
const sent: string[] = [];

function roleClient(role: string, applicationName: string): Sql {
  return db.connect({
    max: 2,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: { application_name: applicationName, search_path: `${db.schema}, public`, role },
  });
}

const clientOf = (role: Role): Sql => (role === "app" ? app : job);

beforeAll(async () => {
  db = await createTestDatabase({ name: "data_access_db_side", client: { max: 2 }, database: "own" });
  app = roleClient("rosie_app", "rosie-t1169-app");
  job = roleClient("rosie_job", "rosie-t1169-job");
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 120_000);

afterAll(async () => {
  await app.end({ timeout: 5 });
  await job.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table and restarts its identity (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
}

type Row = Record<string, unknown>;

/** What a writer writes (item 46: a phone row and its entry), as the tables' owner reads it, each in a fixed order. */
interface Written {
  phones: Row[];
  log: Row[];
}

async function written(): Promise<Written> {
  const phones = await db.sql<Row[]>`select * from phones order by handle_id collate "C"`;
  const log = await db.sql<Row[]>`select * from event_log order by id collate "C"`;
  return { phones: [...phones], log: [...log] };
}

/** A stored time as an answer gives it (common/formats.v1 utc): in UTC, with no fraction where it has none. */
const utcOf = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString().replace(/\.000Z$/, "Z") : value;

/**
 * README item 46 step 4 and "The entry": an answer gives the phone row as the call leaves it and the entry it appended,
 * or none. Each way the tables after the call differ from that, none when they hold it: with no entry (an error, or
 * event null), nothing is written; with one, that entry alone is appended, in K-04's column names the answer's, with no
 * turn, the text's event id as its job id, its trace and no bundle, at the call's now (given.now); the handle's phone
 * row is the answer's; and every other row is as it was.
 */
export function writtenProblems(
  before: Written,
  after: Written,
  exchange: Exchange,
  answer: unknown,
): string[] {
  const event = isRecord(answer) && isRecord(answer.event) ? answer.event : null;
  if (event === null)
    return isDeepStrictEqual(after, before) ? [] : ["an answer that appends no entry wrote"];
  const problems: string[] = [];
  const kept = new Set(before.log.map((row) => row.id));
  if (
    !isDeepStrictEqual(
      after.log.filter((row) => kept.has(row.id)),
      before.log,
    )
  ) {
    problems.push("an entry that was there changed");
  }
  const added = after.log.filter((row) => !kept.has(row.id));
  const [entry] = added;
  if (added.length !== 1 || entry === undefined) {
    problems.push(`${String(added.length)} entries were appended, not one`);
  } else {
    const { request, given: state } = exchange;
    const stated: Row = {
      id: event.id,
      at: state.now,
      zone: event.zone,
      turn_id: null,
      job_id: request.eventId,
      trace_id: request.traceId,
      bundle_hash: null,
      bundle_build: null,
      business_id: event.businessId,
      actor_kind: event.actorKind,
      actor_person_id: event.actorPersonId,
      actor_role: event.actorRole,
      kind: event.kind,
      table_name: event.tableName,
      row_id: event.rowId,
      old_values: event.oldValues,
      new_values: event.newValues,
      sealed_values: event.sealed,
      sealed_for_person_id: null,
      why: event.why,
      approved_by: event.approvedBy,
      proofs: event.proofs,
    };
    for (const place of differences(stated, { ...entry, at: utcOf(entry.at) })) {
      problems.push(`the entry appended is not the answer's at ${place}`);
    }
  }
  const handleId = isRecord(answer) ? answer.handleId : undefined;
  const others = (rows: Row[]): Row[] => rows.filter((row) => row.handle_id !== handleId);
  if (!isDeepStrictEqual(others(after.phones), others(before.phones)))
    problems.push("another phone row changed");
  const row = after.phones.find((phone) => phone.handle_id === handleId);
  const phone =
    row === undefined
      ? undefined
      : {
          chatOpen: row.chat_open,
          chatOpenAt: utcOf(row.chat_open_at),
          chatWay: row.chat_way,
          stopped: row.stopped,
          version: row.version,
        };
  if (!isRecord(answer) || !isDeepStrictEqual(phone, answer.phone)) {
    problems.push("the handle's phone row is not the answer's");
  }
  return problems;
}

/**
 * What a mark could write, as the tables' owner reads it, each in a fixed order (MARKS): the outbox rows, their part
 * tries and their claims (v1 item 4, v1.1 item 15), and beside them the clock rows and the log, which no mark writes
 * (the caller arms the clock: v1 item 5; item 48 "It writes nothing").
 */
interface Marks {
  rows: Row[];
  parts: Row[];
  claims: Row[];
  clocks: Row[];
  log: Row[];
}

async function marks(): Promise<Marks> {
  const rows = await db.sql<Row[]>`select * from outbox_rows order by id collate "C"`;
  const parts = await db.sql<Row[]>`select * from outbox_parts order by idempotency_key collate "C"`;
  const claims = await db.sql<Row[]>`select * from outbox_claims order by outbox_row_id collate "C"`;
  const clocks = await db.sql<Row[]>`select * from clock_rows order by id collate "C"`;
  const log = await db.sql<Row[]>`select * from event_log order by id collate "C"`;
  return { rows: [...rows], parts: [...parts], claims: [...claims], clocks: [...clocks], log: [...log] };
}

/**
 * README items 4, 15 and 48, read from the tables (MARKS). Each way the tables after a mark differ from what its answer
 * gives, none when they hold it: an error and a repeat wrote nothing (no row, part, claim, clock row or entry changed);
 * the row the tables hold is the answer's row, its state and version; a delivery receipt that is recorded leaves the
 * part try the answer names (by item 3's key, <row>/<part>/<try>) delivered at the receipt's at; and the delivery a
 * repeat names is that part try's delivered_at as stored (default 86), the row's first when no other part try of the
 * row holds an earlier one, a tie counting as first (default 85).
 */
export function markProblems(before: Marks, after: Marks, exchange: Exchange, answer: unknown): string[] {
  if (!isRecord(answer) || isError(answer)) {
    return isDeepStrictEqual(after, before) ? [] : ["an answer that marks nothing wrote"];
  }
  const problems: string[] = [];
  if (answer.repeated === true && !isDeepStrictEqual(after, before)) problems.push("a repeat wrote");
  const stored = after.rows.find((row) => row.id === answer.outboxRowId);
  const row = stored === undefined ? undefined : { state: stored.state, version: stored.version };
  if (!isDeepStrictEqual(row, answer.row)) problems.push("the row the tables hold is not the answer's");
  const key = `${String(answer.outboxRowId)}/${String(answer.partNo)}/${String(answer.tryNo)}`;
  const tries = after.parts.filter((part) => part.outbox_row_id === answer.outboxRowId);
  const deliveredAt = tries.find((part) => part.idempotency_key === key)?.delivered_at;
  const repeats = answer[REPEAT.field];
  if (isRecord(repeats)) {
    if (utcOf(deliveredAt) !== repeats.deliveredAt) {
      problems.push(
        `the part try holds delivered_at ${String(utcOf(deliveredAt))}, not the answer's ${String(repeats.deliveredAt)}`,
      );
    }
    const first =
      deliveredAt instanceof Date &&
      tries.every(
        (part) =>
          !(part.delivered_at instanceof Date) || part.delivered_at.getTime() >= deliveredAt.getTime(),
      );
    if (repeats.firstOfRow !== first) {
      problems.push(
        `the answer says firstOfRow ${String(repeats.firstOfRow)}, and by the times the tables hold it is ${String(first)}`,
      );
    }
  } else if (
    exchange.request.outcome === "delivered" &&
    answer.repeated === false &&
    utcOf(deliveredAt) !== exchange.request.at
  ) {
    problems.push("the part try is not delivered at the receipt's at");
  }
  return problems;
}

/** A claim row as an answer's claimed row states it (v1.1 item 13), or none for a row with no claim row. */
const claimOf = (claim: Row | undefined): Record<string, unknown> | undefined =>
  claim === undefined
    ? undefined
    : {
        claimer: claim.claimer,
        claimedAt: utcOf(claim.claimed_at),
        lapsesAt: utcOf(claim.lapses_at),
        claimNo: claim.claim_no,
        firstTryAt: utcOf(claim.first_try_at),
        nextTryNotBefore: utcOf(claim.next_try_not_before),
      };

/**
 * README items 3, 13 and 67, read from the tables (as MARKS reads them). Each way the tables after a claim differ from
 * what its answer gives, none when they hold it: an error claimed nothing, so nothing changed; every row the answer does
 * not claim, with its part tries and its claim, is as it was, and so are the clock rows and the log, which no claim
 * writes; each claimed row is sending at the answer's version, under the claim the answer states, each part it lists
 * under its key with its attempts. For a safety claim (sendClass safety), what the schema cannot hold (item 67.4: "the
 * recipient and the limit are rules the schema cannot hold, which ... QA's database side hold"): each claimed row is
 * the named recipient's, and of send class safety as the tables hold it, at most `limit` are claimed, and passedHeld
 * is empty.
 */
export function claimProblems(before: Marks, after: Marks, exchange: Exchange, answer: unknown): string[] {
  if (!isRecord(answer) || isError(answer)) {
    return isDeepStrictEqual(after, before) ? [] : ["an answer that claims nothing wrote"];
  }
  const problems: string[] = [];
  const claimed = (Array.isArray(answer.claimed) ? answer.claimed : []).filter(isRecord);
  const ids = new Set(claimed.map((row) => row.outboxRowId));
  const others = (held: Marks): Marks => ({
    rows: held.rows.filter((row) => !ids.has(row.id)),
    parts: held.parts.filter((part) => !ids.has(part.outbox_row_id)),
    claims: held.claims.filter((claim) => !ids.has(claim.outbox_row_id)),
    clocks: held.clocks,
    log: held.log,
  });
  if (!isDeepStrictEqual(others(after), others(before))) {
    problems.push("a row the answer does not claim, a clock row or an entry changed");
  }
  const { request } = exchange;
  const safetyOnly = request[SAFETY_CLAIM.field] === SAFETY_CLAIM.value;
  if (safetyOnly) {
    if (typeof request.limit !== "number" || claimed.length > request.limit) {
      problems.push(`${String(claimed.length)} rows are claimed, past the limit`);
    }
    if (!Array.isArray(answer.passedHeld) || answer.passedHeld.length > 0) {
      problems.push("a safety claim lists a held row");
    }
  }
  for (const row of claimed) {
    const id = String(row.outboxRowId);
    const stored = after.rows.find((each) => each.id === id);
    if (stored?.state !== "sending" || stored.version !== row.version) {
      problems.push(`${id} is not sending at the answer's version`);
    }
    if (safetyOnly && stored?.send_class !== SAFETY_CLAIM.value) {
      problems.push(`${id}, which a safety claim took, is of send class ${String(stored?.send_class)}`);
    }
    if (safetyOnly && stored?.recipient_handle_id !== request.recipientHandleId) {
      problems.push(`${id} is not the named recipient's`);
    }
    const claim = claimOf(after.claims.find((each) => each.outbox_row_id === id));
    if (!isDeepStrictEqual(claim, row.claim)) problems.push(`${id}'s claim is not the answer's`);
    for (const part of (Array.isArray(row.parts) ? row.parts : []).filter(isRecord)) {
      const tried = after.parts.find((each) => each.idempotency_key === part.idempotencyKey);
      if (tried?.outbox_row_id !== id || tried.attempts !== part.attempts) {
        problems.push(`${id}'s part ${String(part.idempotencyKey)} is not the answer's`);
      }
    }
  }
  return problems;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** One seed row, its jsonb values as JSON and its bytea values as the bytes their hex names. */
async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) converted = sql.json(value);
    else if (type === "bytea" && typeof value === "string") converted = fromHex(value.replace(/^\\x/, ""));
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it. */
function seedRows(file: string, seen: Set<string>): SeedRow[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const seed = readJson(file) as SeedFile;
  return [
    ...seed.after.flatMap((before) => seedRows(path.join(path.dirname(file), before), seen)),
    ...seed.rows,
  ];
}

/** `<part>/<file>`, a seed of another database part (README "Fixtures", given.partSeeds), in that part's fixtures. */
function partSeedFile(name: string): string {
  const slash = name.indexOf("/");
  if (slash < 1) throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  return path.join(DB_SCHEMA_DIR, name.slice(0, slash), "fixtures", ...name.slice(slash + 1).split("/"));
}

/** A fixture's chain: the seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: string[]; steps: string[] } {
  const { given } = exchangeOf(file);
  const seeds = [
    ...given.k04Seeds.map((seed) => path.join(CORE_SEEDS_DIR, seed)),
    ...(given.partSeeds ?? []).map(partSeedFile),
  ];
  const steps: string[] = [];
  for (const before of given.after) {
    if (seen.has(before)) continue;
    seen.add(before);
    const inner = chainOf(before, seen);
    seeds.push(...inner.seeds);
    steps.push(...inner.steps, before);
  }
  return { seeds, steps };
}

/**
 * README v1 item 8: a held time gets its saved-time clock row, `<reservation id>/saved-time`, kind saved_time, armed and
 * due at its held_until in its business's zone (CQ-05's default), owned by the mobile's handle (by the sweep, with no
 * handle, for an agent token or a booking), firing its release as expired; the commit that books the time cancels it
 * (item 1: commit-first's answer names that row at version 2). db/repo's reserve writes none yet
 * (db/repo/reservations.ts: "reserve() writes no clock row yet: the answer names its id"), so after a held time a chain
 * runs first, this test writes that one row as the tables' owner, as db/repo/commit-turn.int.test.ts does, from the
 * reservation reserve wrote and its answer, once it has checked that reserve wrote none: when reserve writes it, that
 * check fails and this step goes.
 */
const SAVED_TIME = { call: "reserve", result: "held", kind: "saved_time" } as const;

/** Whether a chain step holds a time: a reserve whose answer (checked first to be its outcome) is held (SAVED_TIME). */
const holdsTime = (exchange: Exchange): boolean =>
  exchange.call === SAVED_TIME.call && exchange.outcome.result === SAVED_TIME.result;

/** The saved-time clock row of a held time a chain ran first (SAVED_TIME), as the tables' owner. */
async function writeSavedTimeClock(exchange: Exchange): Promise<void> {
  const { request, outcome } = exchange;
  const reservationId = textOf(outcome.reservationId, "a held time's reservation id");
  const clockId = textOf(outcome.savedTimeClockId, "a held time's clock row id");
  const [there] = await db.sql<{ rows: number }[]>`
    select count(*)::int as rows from clock_rows where id = ${clockId}
  `;
  expect(there?.rows, `${clockId}: db/repo's reserve writes no saved-time clock row yet`).toBe(0);
  const [held] = await db.sql<
    { business_id: string; booking_id: string | null; handle_id: string | null; zone: string }[]
  >`
    select r.business_id, r.booking_id, p.handle_id, b.time_zone as zone
    from reservations r
    join businesses b on b.id = r.business_id
    left join phones p on p.number = r.for_phone_number
    where r.id = ${reservationId}
  `;
  const row = must(held, `the held reservation ${reservationId}`);
  await insertRow(db.sql, "clock_rows", {
    id: clockId,
    kind: SAVED_TIME.kind,
    reservation_id: reservationId,
    handle_id: row.handle_id,
    business_id: row.business_id,
    booking_id: row.booking_id,
    due_at: textOf(outcome.heldUntil, "a held time's end"),
    due_zone: row.zone,
    state: "armed",
    armed_at: textOf(request.at, "a reserve's time"),
    fires: { release: reservationId, why: "expired" },
  });
}

const nowOf = (exchange: Exchange): { now: Date } => ({ now: new Date(exchange.given.now) });

/** The exchange's request through its db/repo call (a side entry's own, unless a chain step's is given), in its role. */
async function runExchange(exchange: Exchange, call = callOf(exchange.call)): Promise<unknown> {
  return call.run(
    clientOf(call.role(exchange.request)),
    structuredClone(exchange.request) as never,
    nowOf(exchange),
  );
}

/**
 * What db/repo answers an exchange in its world: the fixture's outcome, compared whole; where it adds the port
 * (addsPort), that outcome with each claimed row's port and nothing else changed; where it adds what a mark repeats
 * (addsRepeat), that outcome with repeatedDelivery null and nothing else changed; where it adds the switch
 * (addsSwitch), that outcome with businessSensitive null and nothing else changed, never with the field dropped from
 * db/repo's answer. Null is item 45's answer for a business with no kinds of work, and the world of such an exchange
 * holds none (K-04's seeds hold no company_kinds row), which is checked here, as the tables' owner, whom no policy binds.
 */
async function answerOf(entry: FixtureEntry, exchange: Exchange): Promise<Record<string, Json>> {
  if (addsPort(entry, exchange)) {
    const claimed = exchange.outcome.claimed;
    expect(
      Array.isArray(claimed) && claimed.every((row) => isRecord(row) && !Object.hasOwn(row, PORT.field)),
      `${entry.file}'s outcome states no port`,
    ).toBe(true);
    return withPorts(exchange.outcome);
  }
  if (addsRepeat(entry, exchange)) {
    expect(
      Object.hasOwn(exchange.outcome, REPEAT.field),
      `${entry.file}'s outcome states no repeatedDelivery`,
    ).toBe(false);
    return withRepeat(exchange);
  }
  if (!addsSwitch(entry, exchange)) return exchange.outcome;
  expect(Object.hasOwn(exchange.outcome, SWITCH.field), `${entry.file}'s outcome states no switch`).toBe(
    false,
  );
  const [world] = await db.sql<{ kinds: number }[]>`select count(*)::int as kinds from company_kinds`;
  expect(world?.kinds, `${entry.file}: its world holds no kind of work`).toBe(0);
  return withSwitch(exchange.outcome);
}

/**
 * Loads a fixture's given into the emptied schema: its seeds and their chains as the tables' owner, in one
 * transaction, then the exchanges of its after chain through db/repo (stepCallOf), each answering its own fixture's
 * outcome (as answerOf reads it; a claim answered as v1.2 does valid at v1.2, one answered by K-05 v1's own call
 * valid at v1, and an earlier mark answered as v1.9 does valid at v1.9), a held time followed by its saved-time clock
 * row (SAVED_TIME), then the rows its note lists, or for a refused exchange its twin's note (notedRowsOf), as the
 * tables' owner, in one transaction.
 */
async function given(file: string): Promise<Exchange> {
  const chain = chainOf(file);
  await reset();
  const seen = new Set<string>();
  const rows = chain.seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) await insertRow(tx, row.table, row.values);
  });
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    const expected = await answerOf(entryOf(step), before);
    const answer = await runExchange(before, stepCallOf(step));
    expect(answer, `${file}: ${step}, run first`).toEqual(expected);
    if (addsPort(entryOf(step), before)) {
      expect(answerErrors(PORT.version, before.call, answer), `${step}, answered at v1.2`).toEqual([]);
    }
    if (runsAtV1(step)) {
      expect(answerErrors(V1, before.call, answer), `${step}, answered at v1`).toEqual([]);
    }
    if (addsRepeat(entryOf(step), before)) {
      expect(answerErrors(REPEAT.version, before.call, answer), `${step}, answered at v1.9`).toEqual([]);
    }
    if (holdsTime(before)) await writeSavedTimeClock(before);
  }
  const noted = notedRowsOf(file);
  await db.sql.begin(async (tx) => {
    for (const row of noted) await insertRow(tx, row.table, row.values);
  });
  return exchangeOf(file);
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

describe("data-access database side: the versions with one, each entry selected by its version", () => {
  it("runs every entry of v1.3, v1.4, v1.6, v1.7, v1.8, v1.9, v1.10, v1.11 and v1.14, accepted and refused, each against a db/repo call the README names", () => {
    for (const version of DB_SIDE_VERSIONS) {
      const ofVersion = sideEntries.filter((entry) => entry.version === version);
      expect(
        ofVersion.filter((entry) => entry.expect === "accept").length,
        `${version}: accepted`,
      ).toBeGreaterThan(0);
      expect(
        ofVersion.filter((entry) => entry.expect === "refuse").length,
        `${version}: refused`,
      ).toBeGreaterThan(0);
    }
    expect(sideAccepted.length + sideRefused.length).toBe(sideEntries.length);
    const calls = new Set(sideEntries.map((entry) => defOf(entry).call));
    for (const call of calls) expect(Object.keys(DB_CALLS), call).toContain(call);
    for (const call of Object.keys(DB_CALLS)) expect([...calls], `${call} is run`).toContain(call);
    for (const entry of sideAccepted) {
      expect(defOf(entry).part, entry.file).toBe("exchange");
      expect(exchangeOf(entry.file).call, entry.file).toBe(defOf(entry).call);
    }
  });

  it("runs each exchange a chain runs first through db/repo: a call of DB_CALLS, else K-05 v1's own for a v1 step (V1_CHAIN_CALLS), else of CHAIN_CALLS, which no side entry names, but for the claim, v1.14's own from v1.14 and a chain's before it", () => {
    const sideCalls = new Set(sideEntries.map((entry) => defOf(entry).call));
    const runFirst = [
      ...sideAccepted.map((entry) => entry.file),
      ...Object.values(RESPONSE_TWINS).map((twin) => twin.twin),
      ...Object.values(EXCHANGE_TWINS).map((twin) => twin.twin),
      ...Object.keys(EXCHANGE_TWINS),
      ...Object.values(REQUEST_TWINS).map((twin) => twin.twin),
      ...Object.keys(REQUEST_TWINS),
    ].flatMap((file) => chainOf(file).steps);
    const stepCalls = new Set(runFirst.map((step) => exchangeOf(step).call));
    for (const call of stepCalls) {
      expect([...Object.keys(DB_CALLS), ...Object.keys(CHAIN_CALLS)], `${call}, run first`).toContain(call);
    }
    // A chain's call answers no side entry: no side entry names it, but the claim, which v1.14's entries name and
    // DB_CALLS' claimOutboxV114 answers, while a chain's claim answers the claims before v1.14 alone (SAFETY_CLAIM).
    for (const call of Object.keys(CHAIN_CALLS)) {
      expect([...stepCalls], `${call} is run first`).toContain(call);
      expect(
        runFirst.filter((step) => stepCallOf(step) === CHAIN_CALLS[call]).length,
        `${call}: a step runs through the chain's call`,
      ).toBeGreaterThan(0);
      expect(sideEntriesOfChainCall(call), `${call} is no side entry's call`).toEqual([]);
      if (call !== SAFETY_CLAIM.call)
        expect([...sideCalls], `${call} is no side entry's call`).not.toContain(call);
    }
    // K-05 v1's own calls run the v1 steps of theirs, and no other step.
    const v1Calls = new Set(runFirst.filter(runsAtV1).map((step) => exchangeOf(step).call));
    for (const call of Object.keys(V1_CHAIN_CALLS)) {
      expect([...v1Calls], `${call} runs a v1 step first`).toContain(call);
      expect(sideEntriesOfChainCall(call), `${call} is no side entry's call`).toEqual([]);
      if (call !== SAFETY_CLAIM.call)
        expect([...sideCalls], `${call} is no side entry's call`).not.toContain(call);
    }
    for (const step of runFirst) {
      const v1Call = V1_CHAIN_CALLS[exchangeOf(step).call];
      expect(stepCallOf(step) === v1Call, `${step}: through K-05 v1's own call`).toBe(runsAtV1(step));
    }
    for (const call of WRITERS) expect(Object.keys(DB_CALLS), call).toContain(call);
    // The claim is the one call both lists name (SAFETY_CLAIM): every side entry of it is of v1.14, a safety claim
    // with its sendClass, and runs through claimOutboxV114; every claim a chain runs first is of an earlier version,
    // states no sendClass, and runs through the claim of its own version, never through v1.14's.
    const sideClaims = sideEntries.filter((entry) => defOf(entry).call === SAFETY_CLAIM.call);
    expect(sideClaims.length, "v1.14's claims").toBeGreaterThan(0);
    for (const entry of sideClaims) {
      expect(entry.version, entry.file).toBe(SAFETY_CLAIM.version);
      expect(claimsBefore(entry), entry.file).toBe(false);
    }
    expect(callOf(SAFETY_CLAIM.call).run, "a v1.14 claim runs through db/repo's v1.14 claim").toBe(
      claimOutboxV114,
    );
    const claimSteps = [...new Set(runFirst)].filter((step) => exchangeOf(step).call === SAFETY_CLAIM.call);
    expect(claimSteps.filter(runsAtV1).length, "v1 claims run first").toBeGreaterThan(0);
    expect(
      claimSteps.filter((step) => !runsAtV1(step)).length,
      "v1.1 and v1.2 claims run first",
    ).toBeGreaterThan(0);
    for (const step of claimSteps) {
      expect(claimsBefore(entryOf(step)), `${step}: a claim before v1.14`).toBe(true);
      expect(Object.hasOwn(exchangeOf(step).request, SAFETY_CLAIM.field), `${step}: no sendClass`).toBe(
        false,
      );
      expect(stepCallOf(step).run, `${step}: through the claim of its own version`).toBe(
        runsAtV1(step) ? claimOutbox : claimOutboxV12,
      );
    }
  });

  it("has a twin for every refused answer, and none for a refused request", () => {
    const answers = sideRefused.filter(isAnswerDef);
    expect(Object.keys(RESPONSE_TWINS).sort()).toEqual(answers.map((entry) => entry.file).sort());
    for (const entry of sideRefused) {
      // A refused exchange has a twin of its own (EXCHANGE_TWINS, the next test).
      expect(["request", "exchange", ...ANSWER_PARTS], entry.file).toContain(defOf(entry).part);
    }
    expect(
      answers.filter((entry) => entry.def === SWITCH.answerDef).map((entry) => entry.file),
      "v1.6's answer refused by its own definition",
    ).toEqual(["invalid/refuse-outbox-row-switch-left-out.json"]);
    expect(
      answers
        .filter((entry) => entry.def === CONSENT_SOURCE.answerDef)
        .map((entry) => entry.file)
        .sort(),
      "v1.8's answers refused by its own definition",
    ).toEqual([
      "invalid/refuse-send-state-booking-left-out.json",
      "invalid/refuse-send-state-yes-source-left-out.json",
    ]);
    expect(
      answers.filter((entry) => entry.def === REPEAT.answerDef).map((entry) => entry.file),
      "v1.9's answer refused by its own definition",
    ).toEqual(["invalid/refuse-mark-repeat-delivery-left-out.json"]);
    for (const [file, { twin }] of Object.entries(RESPONSE_TWINS)) {
      expect(entryOf(twin).expect, `${file}'s twin`).toBe("accept");
      expect(exchangeOf(twin).call, `${file}'s twin`).toBe(defOf(entryOf(file)).call);
    }
  });

  it("has a twin for every refused exchange: an accepted exchange of its call with its given (but its note) and request", () => {
    const exchanges = sideRefused.filter((entry) => defOf(entry).part === "exchange");
    // Each refused exchange has one twin, by where its one fault is: its outcome (EXCHANGE_TWINS, checked here) or its
    // request (REQUEST_TWINS, the next test); a file in both lists would be counted twice.
    expect([...Object.keys(EXCHANGE_TWINS), ...Object.keys(REQUEST_TWINS)].sort()).toEqual(
      exchanges.map((entry) => entry.file).sort(),
    );
    expect(exchanges.length, "v1.7's refused exchange").toBeGreaterThan(0);
    expect(
      Object.keys(EXCHANGE_TWINS).length,
      "a refused exchange whose fault is its outcome",
    ).toBeGreaterThan(0);
    for (const [file, { twin, faults }] of Object.entries(EXCHANGE_TWINS)) {
      const refused = exchangeOf(file);
      const accepted = exchangeOf(twin);
      expect([entryOf(twin).expect, entryOf(twin).def], `${file}'s twin`).toEqual([
        "accept",
        entryOf(file).def,
      ]);
      expect(accepted.call, `${file}'s twin`).toBe(refused.call);
      expect({ ...refused.given, note: null }, `${file}: its twin's given`).toEqual({
        ...accepted.given,
        note: null,
      });
      expect(refused.request, `${file}: its twin's request`).toEqual(accepted.request);
      expect(twinProblems(refused.outcome, accepted.outcome, { faults }), `${file}: its fault`).toEqual([]);
    }
  });

  it("has a twin for every refused exchange whose fault is its request: an accepted exchange of its call with its given (but its note) and outcome, and its request but for the fault", () => {
    expect(Object.keys(REQUEST_TWINS).length, "v1.10's refused request, held in an exchange").toBeGreaterThan(
      0,
    );
    for (const [file, { twin, faults }] of Object.entries(REQUEST_TWINS)) {
      const entry = entryOf(file);
      const refused = exchangeOf(file);
      const accepted = exchangeOf(twin);
      expect([entry.expect, defOf(entry).part, DB_SIDE_VERSIONS.includes(entry.version)], file).toEqual([
        "refuse",
        "exchange",
        true,
      ]);
      expect([entryOf(twin).expect, entryOf(twin).def], `${file}'s twin`).toEqual(["accept", entry.def]);
      expect(accepted.call, `${file}'s twin`).toBe(refused.call);
      expect({ ...refused.given, note: null }, `${file}: its twin's given`).toEqual({
        ...accepted.given,
        note: null,
      });
      expect(refused.outcome, `${file}: its twin's outcome`).toEqual(accepted.outcome);
      expect(twinProblems(refused.request, accepted.request, { faults }), `${file}: its fault`).toEqual([]);
      // The exchange is refused for its request alone: its call's own request definition refuses it, and takes its
      // twin's.
      const request = validatorOf(entry.version, `${refused.call}.request`);
      expect(errorsOf(request, refused.request), `${file}: its request, refused`).not.toEqual([]);
      expect(errorsOf(request, accepted.request), `${file}: its twin's request`).toEqual([]);
      const outcome = validatorOf(entry.version, answerDefOf(entry.version, refused.call, refused.outcome));
      expect(errorsOf(outcome, refused.outcome), `${file}: its outcome, which is no fault`).toEqual([]);
    }
  });

  it("answers a v1.1 claim a chain runs first as v1.2 does: its outcome and each claimed row's port, valid at v1.2 alone", () => {
    const steps = [...new Set(sideAccepted.flatMap((entry) => chainOf(entry.file).steps))];
    const claims = steps.filter((step) => addsPort(entryOf(step), exchangeOf(step)));
    expect(claims.length, "v1.1 claims run first").toBeGreaterThan(0);
    for (const step of claims) {
      const { call, outcome } = exchangeOf(step);
      const answer = withPorts(outcome);
      const rows = (outcome.claimed as Json[]).map((_, at) => `claimed.${String(at)}.${PORT.field}`);
      expect(rows.length, step).toBeGreaterThan(0);
      expect(differences(outcome, answer), `${step}: one field more on each row, none fewer`).toEqual(rows);
      expect(answerErrors(PORT.version, call, answer), `${step} at v1.2`).toEqual([]);
      expect(
        answerErrors(entryOf(step).version, call, answer),
        `${step} at v1.1, whose claimed row is closed`,
      ).not.toEqual([]);
      const swapped = (answer.claimed as Record<string, Json>[]).map((row) => ({
        ...row,
        [PORT.field]: row[PORT.field] === "linq" ? "email" : "linq",
      }));
      expect(
        answerErrors(PORT.version, call, { ...answer, claimed: swapped }),
        `${step}: a port its channel does not take`,
      ).not.toEqual([]);
    }
  });

  it("answers a v1 claim a chain runs first through K-05 v1's own claimOutbox: its outcome whole, valid at v1, whose claimed row takes no claim, claimedFrom or port", () => {
    const steps = [...new Set(sideAccepted.flatMap((entry) => chainOf(entry.file).steps))];
    const claims = steps.filter((step) => exchangeOf(step).call === PORT.call && runsAtV1(step));
    expect(claims.length, "v1 claims run first").toBeGreaterThan(0);
    for (const step of claims) {
      const exchange = exchangeOf(step);
      expect(stepCallOf(step), step).toBe(V1_CHAIN_CALLS[PORT.call]);
      expect(addsPort(entryOf(step), exchange), `${step}: answered whole, nothing added`).toBe(false);
      expect(answerErrors(V1, exchange.call, exchange.outcome), `${step} at v1`).toEqual([]);
      const rows = exchange.outcome.claimed as Record<string, Json>[];
      expect(rows.length, step).toBeGreaterThan(0);
      for (const row of rows) {
        for (const field of ["claim", "claimedFrom", PORT.field]) {
          expect(Object.hasOwn(row, field), `${step}: a claimed row with ${field}`).toBe(false);
        }
      }
      expect(
        answerErrors(V1, exchange.call, withPorts(exchange.outcome)),
        `${step}: v1's claimed row is closed, so a v1.2 claim's answer is not its`,
      ).not.toEqual([]);
    }
  });

  it("writes after each held time a chain runs first its saved-time clock row, which a commit after it in that chain books (SAVED_TIME)", () => {
    /** Whether a commit's answer names a row among those it wrote. */
    const commitWrites = (exchange: Exchange, table: string, rowId: string): boolean => {
      const committed: Record<string, unknown> = isRecord(exchange.outcome.committed)
        ? exchange.outcome.committed
        : {};
      const rows = Array.isArray(committed.written) ? committed.written : [];
      return (
        exchange.call === "commitTurn" &&
        rows.some((row) => isRecord(row) && row.table === table && row.rowId === rowId)
      );
    };
    const chains = [
      ...sideAccepted.map((entry) => entry.file),
      ...Object.values(RESPONSE_TWINS).map((twin) => twin.twin),
    ].map((file) => chainOf(file).steps);
    let held = 0;
    for (const steps of chains) {
      for (const [at, step] of steps.entries()) {
        if (!holdsTime(exchangeOf(step))) continue;
        held += 1;
        const { outcome } = exchangeOf(step);
        const clockId = `${textOf(outcome.reservationId, `${step}'s reservation`)}/saved-time`;
        expect(outcome.savedTimeClockId, `${step}: its clock row, by item 8's rule`).toBe(clockId);
        const booking = steps
          .slice(at + 1)
          .filter((later) => commitWrites(exchangeOf(later), "clock_rows", clockId));
        expect(booking.length, `${step}: a commit after it writes ${clockId}`).toBeGreaterThan(0);
      }
    }
    expect(held, "held times run first").toBeGreaterThan(0);
  });

  it("judges each v1.8 sendState answer by sendState.v1dot8Response, which refuses one with fromContact or bookingId left out", () => {
    const reads = sideAccepted.filter((entry) => exchangeOf(entry.file).call === CONSENT_SOURCE.call);
    expect(reads.length, "v1.8's sendState reads").toBeGreaterThan(0);
    const withRow = reads.filter((entry) => isRecord(exchangeOf(entry.file).outcome.textsConsent));
    expect(withRow.length, "reads that give a texts consent row").toBeGreaterThan(0);
    for (const entry of reads) {
      const { outcome } = exchangeOf(entry.file);
      expect(entry.version, entry.file).toBe(CONSENT_SOURCE.version);
      expect(answerDefOf(entry.version, CONSENT_SOURCE.call, outcome), entry.file).toBe(
        CONSENT_SOURCE.answerDef,
      );
      expect(answerErrors(entry.version, CONSENT_SOURCE.call, outcome), entry.file).toEqual([]);
    }
    const response = validatorOf(CONSENT_SOURCE.version, `${CONSENT_SOURCE.call}.response`);
    for (const entry of withRow) {
      const { outcome } = exchangeOf(entry.file);
      const consent = outcome.textsConsent as Record<string, Json>;
      for (const field of CONSENT_SOURCE.fields) {
        expect(Object.hasOwn(consent, field), `${entry.file}: ${field} stated`).toBe(true);
        const leftOut = { ...consent };
        Reflect.deleteProperty(leftOut, field);
        const answer = { ...outcome, textsConsent: leftOut };
        expect(
          answerErrors(entry.version, CONSENT_SOURCE.call, answer),
          `${entry.file} with ${field} left out`,
        ).not.toEqual([]);
        expect(
          errorsOf(response, answer),
          `${entry.file} with ${field} left out, as an earlier answer`,
        ).toEqual([]);
      }
    }
    // Before v1.8 a sendState answer is judged by its response, which has neither field.
    expect(answerDefOf("v1.7", CONSENT_SOURCE.call, {})).toBe(`${CONSENT_SOURCE.call}.response`);
  });

  it("judges each v1.9 markPart answer by markPart.v1dot9Response, which refuses one with repeatedDelivery or its row left out", () => {
    const side = sideAccepted.filter((entry) => exchangeOf(entry.file).call === REPEAT.call);
    expect(side.length, "v1.9's marks").toBeGreaterThan(0);
    const response = validatorOf(REPEAT.version, `${REPEAT.call}.response`);
    for (const entry of side) {
      const exchange = exchangeOf(entry.file);
      const { outcome } = exchange;
      expect(entry.version, entry.file).toBe(REPEAT.version);
      expect(answerDefOf(entry.version, REPEAT.call, outcome), entry.file).toBe(REPEAT.answerDef);
      expect(answerErrors(entry.version, REPEAT.call, outcome), entry.file).toEqual([]);
      // Item 48: an object exactly on a delivery receipt answered repeated, and null on every other answer.
      expect(Object.hasOwn(outcome, REPEAT.field), `${entry.file}: ${REPEAT.field} stated`).toBe(true);
      expect(isRecord(outcome[REPEAT.field]), `${entry.file}: what it repeats`).toBe(
        repeatsDelivery(exchange),
      );
      if (!repeatsDelivery(exchange)) expect(outcome[REPEAT.field], entry.file).toBeNull();
      for (const field of [REPEAT.field, "row"]) {
        const leftOut = { ...outcome };
        Reflect.deleteProperty(leftOut, field);
        expect(
          answerErrors(entry.version, REPEAT.call, leftOut),
          `${entry.file} with ${field} left out`,
        ).not.toEqual([]);
        expect(
          errorsOf(response, leftOut),
          `${entry.file} with ${field} left out, as an earlier answer`,
        ).toEqual([]);
      }
    }
    // Each kind of answer is shown: a repeat of the row's first delivery, one of a later part's, and a mark that repeats
    // none.
    const repeats = side.map((entry) => exchangeOf(entry.file)).filter(repeatsDelivery);
    expect(
      repeats.map((exchange) => String(valueAt(exchange.outcome, `${REPEAT.field}.firstOfRow`))).sort(),
      "the repeats' firstOfRow",
    ).toEqual(["false", "true"]);
    expect(side.length, "a mark that repeats no delivery").toBeGreaterThan(repeats.length);
    // Before v1.9 a markPart answer is judged by its response, which has no such field.
    expect(answerDefOf("v1.8", REPEAT.call, {})).toBe(`${REPEAT.call}.response`);
  });

  it("answers an earlier mark a chain runs first as v1.9 does: its outcome and repeatedDelivery null, valid at v1.9 alone", () => {
    const steps = [...new Set(sideAccepted.flatMap((entry) => chainOf(entry.file).steps))];
    const earlier = steps.filter((step) => addsRepeat(entryOf(step), exchangeOf(step)));
    expect(earlier.length, "earlier marks run first").toBeGreaterThan(0);
    const asExchange = validatorOf(REPEAT.version, `${REPEAT.call}.exchange`);
    for (const step of earlier) {
      const exchange = exchangeOf(step);
      expect(repeatsDelivery(exchange), `${step}: it repeats no delivery`).toBe(false);
      expect(isRecord(exchange.outcome.row), `${step}: its row stated`).toBe(true);
      const answer = withRepeat(exchange);
      expect(differences(exchange.outcome, answer), `${step}: one field more, none fewer`).toEqual([
        REPEAT.field,
      ]);
      expect(answer[REPEAT.field], step).toBeNull();
      expect(answerErrors(REPEAT.version, exchange.call, answer), `${step} at v1.9`).toEqual([]);
      expect(
        errorsOf(asExchange, { ...exchange, outcome: answer }),
        `${step}: the exchange with db/repo's answer, at v1.9`,
      ).toEqual([]);
      expect(
        answerErrors(entryOf(step).version, exchange.call, answer),
        `${step} at ${entryOf(step).version}, whose answer is closed`,
      ).not.toEqual([]);
      expect(
        answerErrors(REPEAT.version, exchange.call, exchange.outcome),
        `${step}: v1.9's answer refuses its outcome with the field left out`,
      ).not.toEqual([]);
    }
    // A repeated delivery is never answered null: its outcome with null is refused as an exchange, and withRepeat
    // refuses to build it.
    const repeat = exchangeOf("mark-a7-03-delivered-repeat.json");
    expect(repeatsDelivery(repeat)).toBe(true);
    expect(
      errorsOf(asExchange, { ...repeat, outcome: { ...repeat.outcome, [REPEAT.field]: null } }),
      "a repeated delivery answered null",
    ).not.toEqual([]);
    expect(() => withRepeat(repeat)).toThrow("never null");
  });

  it("answers an earlier readOutboxRow exchange as v1.6 does: its outcome and businessSensitive null, valid at v1.6 alone", () => {
    const earlier = sideAccepted.filter((entry) => addsSwitch(entry, exchangeOf(entry.file)));
    expect(earlier.length, "earlier readOutboxRow answers").toBeGreaterThan(0);
    for (const entry of earlier) {
      const exchange = exchangeOf(entry.file);
      const answer = withSwitch(exchange.outcome);
      expect([exchange.call, answeredAt(entry, exchange)], entry.file).toEqual([SWITCH.call, SWITCH.version]);
      expect(differences(exchange.outcome, answer), `${entry.file}: one field more, none fewer`).toEqual([
        SWITCH.field,
      ]);
      expect(answer[SWITCH.field], entry.file).toBeNull();
      expect(answerErrors(SWITCH.version, exchange.call, answer), `${entry.file} at v1.6`).toEqual([]);
      expect(
        answerErrors(entry.version, exchange.call, answer),
        `${entry.file} at ${entry.version}, whose answer is closed`,
      ).not.toEqual([]);
      expect(
        answerErrors(SWITCH.version, exchange.call, exchange.outcome),
        `${entry.file}: v1.6 refuses its outcome with the switch left out`,
      ).not.toEqual([]);
    }
    // Every other exchange, an error of readOutboxRow and v1.6's own among them, is judged at its own version.
    const others = sideAccepted.filter((entry) => !earlier.includes(entry));
    for (const entry of others)
      expect(answeredAt(entry, exchangeOf(entry.file)), entry.file).toBe(entry.version);
    expect(others.filter((entry) => entry.version === SWITCH.version).length).toBeGreaterThan(0);
    expect(
      others.filter(
        (entry) => exchangeOf(entry.file).call === SWITCH.call && entry.version !== SWITCH.version,
      ).length,
      "an earlier readOutboxRow error",
    ).toBeGreaterThan(0);
  });

  it("writes the rows a fixture's note lists, each as the note names it, with its values and in its order", () => {
    expect(Object.keys(NOTED_ROWS)).toEqual([
      PRACTICE,
      CHAT_OF_TURN_1,
      PARTY_OF_TURN_1,
      PARTY_TWO_COMPANIES,
      PARTY_BEFORE_BUSINESS,
      PARTY_HANDED_OVER,
      PARTY_ROLE_ENDED,
      "claim-safety-past-live-safety-claim.json",
      "claim-safety-past-routine-live-claim.json",
      "claim-safety-past-planned-row.json",
      "claim-safety-past-held-row.json",
      PAST_TEN_NOTICES,
    ]);
    for (const file of Object.keys(NOTED_ROWS)) {
      expect(
        sideAccepted.map((entry) => entry.file),
        file,
      ).toContain(file);
      // Written after the chain: no exchange runs one whose rows are noted first.
      for (const entry of sideAccepted)
        expect(exchangeOf(entry.file).given.after, entry.file).not.toContain(file);
    }
    // v1.6's practice: five rows, each named "<table> <id> (" with its values after it. S1-01's thread, which its note
    // lists column by column, is the next test's, v1.11's five notes, each row in the note's own words, are the
    // tests' after it, and v1.14's five, each danger line and the ten notices, the tests' after those.
    const bundle = seedBundle();
    const file = PRACTICE;
    const note = must(exchangeOf(file).given.note, `${file}'s note`);
    expect(note, file).toContain("writes these five rows itself before the read, in this order");
    const rows = must(NOTED_ROWS[file], `${file}'s noted rows`)();
    expect(rows.map(notedAs), file).toHaveLength(5);
    const places = rows.map((row) => note.indexOf(`${notedAs(row)} (`));
    for (const [at, row] of rows.entries()) expect(places[at], notedAs(row)).toBeGreaterThanOrEqual(0);
    expect(
      [...places].sort((a, b) => a - b),
      `${file}: in the note's order`,
    ).toEqual(places);
    // Each text written is one the note states, but the bundle, which it names as K-04's seed's.
    for (const row of rows) {
      for (const text of Object.values(row.values).flatMap(textsIn)) {
        if (text !== bundle.hash) expect(note, `${notedAs(row)}: ${text}`).toContain(text);
      }
    }
    expect(note, file).toContain("the bundle of K-04's seed-bundle-registry.json");
  });

  it("writes read-chat-handle-sam's one noted row, S1-01's thread: as its note lists it column by column, and as K-09 v1.5's turn 1 commit writes it", () => {
    const file = CHAT_OF_TURN_1;
    const exchange = exchangeOf(file);
    const note = must(exchange.given.note, `${file}'s note`);
    const rows = must(NOTED_ROWS[file], `${file}'s noted rows`)();
    expect(
      rows.map((row) => row.table),
      "one row, a thread",
    ).toEqual(["threads"]);
    const thread = must(rows[0], `${file}'s thread`);
    // The note lists the one row column by column, with each value, in this order.
    expect(note, file).toContain(
      `this exchange's database side writes it itself before the read: ${spelledAs(thread)}.`,
    );
    // The check reads each column and value: a row with another value, or with a column left out, is not the note's.
    const emailThread = { ...thread, values: { ...thread.values, kind: "email" } };
    expect(note, "a thread of another kind").not.toContain(spelledAs(emailThread));
    const shorter = Object.fromEntries(
      Object.entries(thread.values).filter(([column]) => column !== "reply_address"),
    );
    expect(note, "a row with a column left out").not.toContain(
      `${spelledAs({ ...thread, values: shorter })}.`,
    );
    // The row is the exchange's own: the chat its request names, on the handle its outcome gives.
    expect(thread.values.linq_chat_id, "the request's chat id").toBe(exchange.request.linqChatId);
    expect(thread.values.handle_id, "the outcome's handle").toBe(exchange.outcome.handleId);
    // It is S1-01's thread as K-09 v1.5's turn 1 commit states it, field for field (its given.stated.writes, which the
    // note names), at the version that commit's answer lists.
    const toolApi = readJson(path.join(TOOL_API_FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
    const listed = must(
      toolApi.fixtures.find((entry) => entry.file === TURN_1_COMMIT),
      `K-09's index entry ${TURN_1_COMMIT}`,
    );
    expect([listed.version, listed.expect], `K-09's ${TURN_1_COMMIT}`).toEqual(["v1.5", "accept"]);
    expect(note, file).toContain(`K-09 v1.5 ${TURN_1_COMMIT} given.stated.writes`);
    const commit = readJson(path.join(TOOL_API_FIXTURES_DIR, TURN_1_COMMIT)) as StatedCommit;
    const { version, ...stated } = thread.values;
    expect(
      commit.given.stated.writes.state.filter((write) => write.table === thread.table),
      "the thread that commit states",
    ).toEqual([{ op: "insert", table: thread.table, values: stated }]);
    expect(
      commit.outcome.written.written.filter((row) => row.table === thread.table),
      "the thread that commit's answer lists",
    ).toEqual([{ table: thread.table, rowId: thread.values.id, version }]);
    // No K-05 exchange runs first, and no seed the fixture names holds the thread or its chat id: the row is written
    // here or nowhere (README "Fixtures", v1.10: "No frozen seed holds S1-01's thread").
    const chain = chainOf(file);
    expect(chain.steps, `${file}: no exchange runs first`).toEqual([]);
    const seen = new Set<string>();
    const seeded = chain.seeds.flatMap((seed) => seedRows(seed, seen));
    expect(seeded.length, `${file}: its seeds' rows`).toBeGreaterThan(0);
    expect(
      seeded.filter(
        (row) =>
          row.table === thread.table &&
          (row.values.id === thread.values.id || row.values.linq_chat_id === thread.values.linq_chat_id),
      ),
      `${file}: no seed holds the thread`,
    ).toEqual([]);
  });

  it("writes the rows v1.11's five notes list, each as its note lists it, with its values and in its order: test owner 1's first where the note has them, then the note's own", () => {
    // The five are the v1.11 exchanges whose notes say their database side writes rows, and no other (README "Fixtures",
    // v1.11: "five fixtures' notes list the rows their database side writes itself before the read").
    const noting = sideAccepted
      .filter((entry) => entry.version === "v1.11")
      .map((entry) => entry.file)
      .filter((file) => (exchangeOf(file).given.note ?? "").includes("database side writes"));
    expect(noting).toEqual([
      PARTY_OF_TURN_1,
      PARTY_TWO_COMPANIES,
      PARTY_BEFORE_BUSINESS,
      PARTY_HANDED_OVER,
      PARTY_ROLE_ENDED,
    ]);
    expect(Object.keys(PARTY_NOTES)).toEqual(noting);
    const testOwnerFirst =
      "writes test owner 1's rows as read-turn-party-test-owner-1's note lists them (T-1148's skeleton seed), then";
    for (const file of noting) {
      const { afterTestOwner, own } = must(PARTY_NOTES[file], `${file}'s noted rows`);
      const exchange = exchangeOf(file);
      const note = must(exchange.given.note, `${file}'s note`);
      // Each row the note lists itself is listed with its values, in the order it is written.
      const rows = own();
      expect(rows.length, `${file}: the rows its note lists itself`).toBeGreaterThan(0);
      expect(partyNoteProblems(note, rows), file).toEqual([]);
      // A note that has test owner 1's rows written first says so, before the rows it lists itself; they need the
      // barbershop's business head, which its given's seed holds.
      expect(note.includes(testOwnerFirst), `${file}: test owner 1's rows first`).toBe(afterTestOwner);
      if (afterTestOwner) {
        expect(partyNoteProblems(note.slice(note.indexOf(testOwnerFirst)), rows), file).toEqual([]);
        expect(exchange.given.k04Seeds, file).toEqual([BUSINESS_HEAD_SEED]);
      }
      const written = notedRowsOf(file);
      expect(written, file).toEqual([...(afterTestOwner ? testOwnerRows() : []), ...rows]);
      // The rows are the exchange's own: the handle its request names, and the handle and the person its answer gives.
      const handle = must(
        written.find((row) => row.table === "handles"),
        `${file}'s handle`,
      );
      expect([handle.values.kind, handle.values.address], `${file}: the request's handle`).toEqual([
        valueAt(exchange.request, "handle.kind"),
        valueAt(exchange.request, "handle.address"),
      ]);
      const link = must(
        written.find((row) => row.table === "person_handles"),
        `${file}'s link`,
      );
      expect(
        [link.values.handle_id, link.values.person_id],
        `${file}: the answer's handle and person`,
      ).toEqual([exchange.outcome.handleId, exchange.outcome.personId]);
      // No exchange runs first, and no seed the fixture names holds a row its database side writes: each is written
      // here or nowhere (README "Fixtures", v1.11: "No frozen seed holds test owner 1 without K-04's three owner
      // roles, or Sam's companies without K-23's owner role").
      const chain = chainOf(file);
      expect(chain.steps, `${file}: no exchange runs first`).toEqual([]);
      const seen = new Set<string>();
      const seeded = chain.seeds.flatMap((seed) => seedRows(seed, seen)).map(rowKey);
      for (const row of written) expect(seeded, `${file}: no seed holds it`).not.toContain(rowKey(row));
    }
  });

  it("writes test owner 1's rows as T-1148's seed writes them (its SKELETON_ROWS), all but the business head K-04's seed holds, and each other note's rows as the source its note names holds them", () => {
    const rows = testOwnerRows();
    const turn1 = exchangeOf(PARTY_OF_TURN_1);
    expect(must(turn1.given.note, `${PARTY_OF_TURN_1}'s note`)).toContain(
      "this exchange's database side writes its rows itself after K-04's seed-business-head.json, as that seed writes them (its SKELETON_ROWS): ",
    );
    // Five rows, in the note's order: every row of the seed's list but its business head.
    const tables = ["persons", "handles", "person_handles", "companies", "company_kinds"];
    expect(rows.map((row) => row.table)).toEqual(tables);
    expect(Object.keys(SKELETON_ROWS), "the seed's list, table by table").toEqual(["businesses", ...tables]);
    expect(
      Object.values(SKELETON_ROWS).map((list: readonly unknown[]) => list.length),
      "one row of each",
    ).toEqual([1, 1, 1, 1, 1, 1]);
    // The business head is K-04's seed-business-head.json's, value for value, which the given loads first: the seed's
    // list and the fixture's given make one state.
    expect(turn1.given.k04Seeds).toEqual([BUSINESS_HEAD_SEED]);
    const head = readJson(path.join(CORE_SEEDS_DIR, BUSINESS_HEAD_SEED)) as SeedFile;
    const [business] = SKELETON_ROWS.businesses;
    expect(
      head.rows
        .filter((row) => row.table === "businesses" && row.values.id === business?.id)
        .map((row) => row.values),
      "the barbershop's business head",
    ).toEqual([business]);
    // The company and its kind of work, whose values the note leaves to the seed, are K-23's seed-company-two-kinds.json
    // rows for the barbershop, value for value (db/seeds/skeleton.ts: "K-23 v1 seed-company-two-kinds.json's row for
    // tp-01's business"), and so are Sam's second company and its business, without that seed's owner role.
    const twoKinds = readJson(partSeedFile(TWO_KINDS_SEED)) as SeedFile;
    const inK23 = (row: SeedRow): SeedRow[] => twoKinds.rows.filter((held) => rowKey(held) === rowKey(row));
    for (const row of [...rows.filter((each) => !SAM_TABLES.includes(each.table)), ...secondCompanyRows()]) {
      expect(inK23(row), `K-23's ${rowKey(row)}`).toEqual([row]);
    }
    expect(must(exchangeOf(PARTY_TWO_COMPANIES).given.note, `${PARTY_TWO_COMPANIES}'s note`)).toContain(
      "as K-23's seed-company-two-kinds.json holds it, without that seed's owner role",
    );
    expect(twoKinds.rows.filter((row) => row.table === "person_roles").length, "that seed's owner role").toBe(
      1,
    );
    for (const file of Object.keys(PARTY_NOTES)) {
      const roles = notedRowsOf(file).filter((row) => row.table === "person_roles");
      const live = roles.filter(
        (row) => row.values.person_id === "person-sam" && row.values.ended_at === null,
      );
      expect(live, `${file}: Sam holds no live role`).toEqual([]);
    }
    // Sam's sign-up before S1-09: his own three rows as the seed writes them, then both companies with no business yet,
    // after no seed.
    const signUp = signUpRows();
    expect(signUp.map((row) => row.table)).toEqual([...SAM_TABLES, "companies", "companies"]);
    expect(signUp.slice(0, SAM_TABLES.length)).toEqual(rows.slice(0, SAM_TABLES.length));
    expect(signUp.slice(SAM_TABLES.length).map((row) => row.values.business_id)).toEqual([null, null]);
    expect(exchangeOf(PARTY_BEFORE_BUSINESS).given.k04Seeds).toEqual([]);
    // The hand-over: Hugo P.'s owner role is live, and Sam's ended at the handover time, before the read's now.
    expect(
      newOwnerRows()
        .filter((row) => row.table === "person_roles")
        .map((row) => [row.values.person_id, row.values.role, row.values.ended_at]),
      "Hugo P.'s live owner role",
    ).toEqual([["person-hugo", "owner", null]]);
    const [ended] = endedRoleRows();
    const endedAt = textOf(ended?.values.ended_at, "the time Sam's owner role ended");
    expect(Date.parse(endedAt)).toBeLessThan(Date.parse(exchangeOf(PARTY_ROLE_ENDED).given.now));
  });

  it("has the v1.11 note check fire: a value other than the note's, rows out of the note's order, a column no note states, a link apart from its person and handle", () => {
    const note = must(exchangeOf(PARTY_BEFORE_BUSINESS).given.note, `${PARTY_BEFORE_BUSINESS}'s note`);
    const rows = signUpRows();
    const at = (place: number): SeedRow => must(rows[place], `row ${String(place)} of the sign-up's`);
    const [sam, handle, link, homeServices, barbershop] = [at(0), at(1), at(2), at(3), at(4)];
    expect(partyNoteProblems(note, rows)).toEqual([]);
    const withBusiness: SeedRow = {
      ...homeServices,
      values: { ...homeServices.values, business_id: "biz-lees-barbershop" },
    };
    expect(partyNoteProblems(note, [sam, handle, link, withBusiness, barbershop])).toEqual([
      "companies company-lee-home-services (owner_person_id person-sam, name 'Lee Home Services LLC', business_id biz-lees-barbershop, version 1) is not listed",
    ]);
    // The same rows in another order: each is in the note, but not after the row before it.
    expect(partyNoteProblems(note, [handle, sam, homeServices, barbershop])).toEqual([
      "persons person-sam (name 'Sam Lee', language null, version 1) is not listed in this order",
    ]);
    const versioned: SeedRow = { ...handle, values: { ...handle.values, version: 1 } };
    expect(partyNoteProblems(note, [sam, versioned, link, homeServices, barbershop])).toEqual([
      "the handles row holds version, which no note states",
    ]);
    // "their person_handles row" lists a link only beside its own person and handle.
    expect(partyNoteProblems(note, [sam, link])).toEqual([
      "person_handles (person-sam, handle-sam) is not listed",
    ]);
    // Test owner 1's note spells the link out by its two keys, so there it is listed with no handle beside it.
    const turn1 = must(exchangeOf(PARTY_OF_TURN_1).given.note, `${PARTY_OF_TURN_1}'s note`);
    expect(partyNoteProblems(turn1, [sam, link])).toEqual([]);
    // A table no v1.11 note lists is a broken test, never a row passed over.
    expect(() => partyNoteProblems(note, [{ table: "threads", values: {} }])).toThrow("threads");
  });

  it("writes the rows v1.14's five notes list: each danger line's turn and its one row, as its note lists them and as its claim's answer gives the row, and before claim-safety-past-ten-checked-rows's the ten routine notices and their turn", () => {
    // Every accepted v1.14 exchange is a safety claim whose note lists its danger line (README "Fixtures", v1.14: "each
    // note lists the two rows its database side writes itself before the claim").
    const noting = sideAccepted
      .filter((entry) => entry.version === SAFETY_CLAIM.version)
      .map((entry) => entry.file);
    expect(Object.keys(DANGER_LINES)).toEqual(noting);
    for (const file of noting) {
      const line = must(DANGER_LINES[file], `${file}'s danger line`);
      const exchange = exchangeOf(file);
      const note = must(exchange.given.note, `${file}'s note`);
      const rows = dangerLineRows(line);
      expect(dangerNoteProblems(note, line, rows), file).toEqual([]);
      // Written last, after the chain and, for the ten notices, the rows its note lists before it.
      const written = notedRowsOf(file);
      expect(written.slice(-rows.length), file).toEqual(rows);
      expect(written.length, file).toBe(
        rows.length + (file === PAST_TEN_NOTICES ? NOTICES_TURN.count + 1 : 0),
      );
      // The line is committed on the claim's day, before the claim and after every exchange its chain runs first.
      expect(line.at.slice(0, 11), `${file}: on the claim's day`).toBe(exchange.given.now.slice(0, 11));
      expect(Date.parse(line.at), `${file}: before the claim`).toBeLessThan(Date.parse(exchange.given.now));
      const chain = chainOf(file);
      for (const step of chain.steps) {
        expect(Date.parse(exchangeOf(step).given.now), `${file}: after ${step}`).toBeLessThanOrEqual(
          Date.parse(line.at),
        );
      }
      // The row is the claim's own: the request names its recipient with sendClass safety, and the answer claims it
      // alone, from checked, one version on, with the row's person, business, channel, class, trace and final parts.
      const { values } = must(rows[1], `${file}'s danger row`);
      expect(
        [exchange.request.recipientHandleId, exchange.request[SAFETY_CLAIM.field]],
        `${file}: the request's recipient and class`,
      ).toEqual([line.handleId, SAFETY_CLAIM.value]);
      expect(exchange.outcome.claimed, `${file}: one row claimed`).toHaveLength(1);
      const claimed = valueAt(exchange.outcome, "claimed.0") as Record<string, Json>;
      expect(
        [
          claimed.outboxRowId,
          claimed.version,
          claimed.claimedFrom,
          claimed.recipientHandleId,
          claimed.recipientPersonId,
          claimed.businessId,
          claimed.bookingId,
          claimed.openQuestionId,
          claimed.channel,
          claimed.sendClass,
          claimed.versionsRead,
          claimed.finalParts,
          claimed.traceId,
        ],
        `${file}: the claimed row is the danger line's`,
      ).toEqual([
        values.id,
        (values.version as number) + 1,
        values.state,
        values.recipient_handle_id,
        values.recipient_person_id,
        values.business_id,
        values.booking_id,
        values.open_question_id,
        values.channel,
        SAFETY_CLAIM.value,
        values.versions_read,
        values.final_parts,
        values.trace_id,
      ]);
      // No seed the fixture names and no exchange its chain runs first holds the line: it is written here or nowhere.
      // Its recipient, handle and person, is the seeds'.
      const seen = new Set<string>();
      const seeded = JSON.stringify(chain.seeds.flatMap((seed) => seedRows(seed, seen)));
      const ranFirst = JSON.stringify(chain.steps.map((step) => exchangeOf(step)));
      for (const id of [line.turnId, line.rowId, line.eventId, line.traceId]) {
        expect(seeded, `${file}: no seed holds ${id}`).not.toContain(JSON.stringify(id));
        expect(ranFirst, `${file}: no exchange run first names ${id}`).not.toContain(JSON.stringify(id));
      }
      for (const id of [line.handleId, line.personId]) {
        expect(seeded, `${file}: a seed holds ${id}`).toContain(JSON.stringify(id));
      }
    }
    // The ten notices and their turn, which claim-safety-past-ten-checked-rows's note lists before its danger line, in
    // the note's own words and with its values.
    const file = PAST_TEN_NOTICES;
    const exchange = exchangeOf(file);
    const note = must(exchange.given.note, `${file}'s note`);
    const line = must(DANGER_LINES[file], `${file}'s danger line`);
    const notices = noticeRows();
    const { handleId, personId, businessId, channel, traceId, count } = NOTICES_TURN;
    expect(notices.map((row) => row.table)).toEqual([
      "turns",
      ...Array.from({ length: count }, () => "outbox_rows"),
    ]);
    expect(notedRowsOf(file).slice(0, notices.length), "written first, in the note's order").toEqual(notices);
    const listed = `${turnPhrase(NOTICES_TURN)} with its ten rows ${noticeIdOf(1)} to ${noticeIdOf(count)} (send class routine, ${channel}, to ${handleId} and ${personId} at ${businessId}, no booking, question or copy, no versions read), each checked at version 2 with a plan of formats text and one line, 'Notice N of ${String(count)}.' (role first; no question, page type or thread), and final parts of one words send of those words (no calendar file, option, link, fixed line or slot)`;
    expect(note, file).toContain(
      `this exchange's database side writes, before the claim and in this order: ${listed}; then Sam's danger line`,
    );
    expect(note.indexOf(listed), "the notices before the danger line").toBeLessThan(
      note.indexOf(turnPhrase(line)),
    );
    expect(exchange.given.after, `${file}: no chain writes them`).toEqual([]);
    expect(Date.parse(NOTICES_TURN.at), "committed before the danger line").toBeLessThan(Date.parse(line.at));
    // The note lists the danger line's row as of "the same recipient, business and channel": the notices' own.
    const danger = must(dangerLineRows(line)[1], "the danger line's row").values;
    expect(
      [danger.recipient_handle_id, danger.recipient_person_id, danger.business_id, danger.channel],
      "the danger line's recipient, business and channel",
    ).toEqual([handleId, personId, businessId, channel]);
    expect(note, file).toContain(`its one row ${line.rowId} (send class safety, ${SAME_AS_NOTICES})`);
    const plan = validatorOf(V1, "writePlan.request");
    for (const [at, row] of notices.slice(1).entries()) {
      const place = at + 1;
      const { values } = row;
      const words = noticeWordsOf(place);
      expect(
        [
          values.id,
          values.turn_id,
          values.send_class,
          values.channel,
          values.recipient_handle_id,
          values.recipient_person_id,
          values.business_id,
          values.booking_id,
          values.open_question_id,
          values.copy_of_row_id,
          values.versions_read,
          values.state,
          values.version,
          values.trace_id,
        ],
        `notice ${String(place)}`,
      ).toEqual([
        noticeIdOf(place),
        NOTICES_TURN.turnId,
        "routine",
        channel,
        handleId,
        personId,
        businessId,
        null,
        null,
        null,
        [],
        "checked",
        2,
        traceId,
      ]);
      // Its plan and final parts are a plan K-05's writePlan takes (K-03 v1 rowPlan and finalParts), with the note's
      // one line and its one words send, and nothing else.
      expect(
        errorsOf(plan, {
          outboxRowId: values.id,
          expectVersion: 1,
          plan: values.plan,
          finalParts: values.final_parts,
        }),
        `notice ${String(place)}: a plan writePlan takes`,
      ).toEqual([]);
      expect(valueAt(values.plan, "plan"), `notice ${String(place)}: its plan`).toEqual({
        formats: ["text"],
        lines: [{ role: "first", text: words }],
        question: null,
        pageType: null,
        threadReplyTo: null,
      });
      expect(
        [valueAt(values.final_parts, "sends"), valueAt(values.final_parts, "fixedLines")],
        `notice ${String(place)}: its final parts`,
      ).toEqual([[{ kind: "words", text: words, calendarFile: "none", options: [], link: null }], []]);
      expect(valueAt(values.final_parts, "slotValues"), `notice ${String(place)}: no slot`).toEqual([]);
    }
    // The first notice is the routine row refuse-safety-claim-takes-routine-row's answer claims: the frozen fixture
    // states its final parts, its trace and its place in commit order, and the danger line's place after the ten.
    const taken = valueAt(
      exchangeOf("invalid/refuse-safety-claim-takes-routine-row.json").outcome,
      "claimed.0",
    ) as Record<string, Json>;
    const firstNotice = must(notices[1], "the first notice").values;
    expect([taken.outboxRowId, taken.sendClass, taken.finalParts, taken.traceId, taken.commitSeq]).toEqual([
      firstNotice.id,
      firstNotice.send_class,
      firstNotice.final_parts,
      firstNotice.trace_id,
      1,
    ]);
    expect(valueAt(exchange.outcome, "claimed.0.commitSeq"), "the danger line, after the ten").toBe(
      count + 1,
    );
    expect(exchange.request.limit, "the limit the ten would fill").toBe(count);
  });

  it(
    "writes a danger line's rows as db/repo's commitTurn and writePlan write Alex's first: after v1.1's commit and plan through db/repo, the tables hold that line's turn and row as dangerLineRows builds them, column for column",
    SLOW,
    async () => {
      // claim-alex-safety's given runs v1.1's commit and plan of Alex's first line through db/repo, and not its claim.
      const claim = "claim-alex-safety.json";
      expect(chainOf(claim).steps).toEqual([FIRST_LINE_COMMIT, FIRST_LINE_PLAN]);
      await given(claim);
      const first = firstLine();
      const turns = await db.sql<Row[]>`select * from turns where id = ${first.turnId}`;
      const rows = await db.sql<Row[]>`select * from outbox_rows where id = ${first.rowId}`;
      /** A row's columns that hold a value, a time as an answer gives it; commit_seq is the database's own. */
      const stated = (row: Row): Row =>
        Object.fromEntries(
          Object.entries(row)
            .filter(([column, value]) => value !== null && column !== "commit_seq")
            .map(([column, value]) => [column, utcOf(value)]),
        );
      const [turn, row] = dangerLineRows(first);
      expect(turns.map(stated), "the turn db/repo's commit wrote").toEqual([
        stated(must(turn, "the first line's turn").values),
      ]);
      expect(rows.map(stated), "the row db/repo's commit and plan wrote").toEqual([
        stated(must(row, "the first line's row").values),
      ]);
      // The first line's own rows are the two requests', with no id swapped.
      expect(withIdsOf(exchangeOf(FIRST_LINE_COMMIT).request, first)).toEqual(
        exchangeOf(FIRST_LINE_COMMIT).request,
      );
    },
  );

  it("has the v1.14 note check fire: another commit time, a row not yet checked, another fixture's line, a row with no turn, a note that lists no rows", () => {
    const file = "claim-safety-past-held-row.json";
    const line = must(DANGER_LINES[file], `${file}'s danger line`);
    const note = must(exchangeOf(file).given.note, `${file}'s note`);
    const rows = dangerLineRows(line);
    const [turn, row] = [must(rows[0], "the turn"), must(rows[1], "the row")];
    expect(dangerNoteProblems(note, line, rows)).toEqual([]);
    const later = { ...line, at: "2026-11-08T01:31:01Z" };
    expect(dangerNoteProblems(note, later, dangerLineRows(later))).toEqual([
      '"the turn turn-sam-safety-0063 (handle-sam, event evt-sam-0063, trace trace-sam-0063, committed at 01:31:01Z)" is not listed',
    ]);
    const planned: SeedRow = { ...row, values: { ...row.values, state: "planned", version: 1 } };
    expect(dangerNoteProblems(note, line, [turn, planned])).toEqual([
      "the rows do not hold what the note says at row.2",
      "the rows do not hold what the note says at row.3",
    ]);
    const routine: SeedRow = { ...row, values: { ...row.values, send_class: "routine" } };
    expect(dangerNoteProblems(note, line, [turn, routine])).toEqual([
      '"its one row out-sam-safety-0063 (send class routine, imessage, to handle-sam and person-sam at biz-lees-barbershop, no booking, question or copy, no versions read" is not listed',
    ]);
    const other = must(DANGER_LINES["claim-safety-past-planned-row.json"], "another fixture's line");
    expect(dangerNoteProblems(note, other, dangerLineRows(other)).length).toBeGreaterThan(0);
    expect(dangerNoteProblems(note, line, [row])).toEqual(["a danger line is a turn and its one outbox row"]);
    expect(dangerNoteProblems("Limit 8 holds the row to 8am.", line, rows)).toHaveLength(5);
    // The ten notices' note lists its danger line's row after the notices' own, as "the same": a note with no such
    // row before it does not.
    const ten = must(DANGER_LINES[PAST_TEN_NOTICES], `${PAST_TEN_NOTICES}'s danger line`);
    const tenNote = must(exchangeOf(PAST_TEN_NOTICES).given.note, `${PAST_TEN_NOTICES}'s note`);
    expect(tenNote).toContain(SAME_AS_NOTICES);
    expect(note).not.toContain(SAME_AS_NOTICES);
    expect(dangerNoteProblems(tenNote, ten, dangerLineRows(ten))).toEqual([]);
  });

  it("writes before a refused exchange the rows its twin's note lists, as its own note says: v1.11's refuse-turn-party-caller-business, test owner 1's, and v1.14's four refused claims, their twins' danger lines", () => {
    const shared: string[] = [];
    for (const [file, { twin }] of [...Object.entries(EXCHANGE_TWINS), ...Object.entries(REQUEST_TWINS)]) {
      expect(Object.hasOwn(NOTED_ROWS, file), `${file}: a refused exchange lists no rows of its own`).toBe(
        false,
      );
      if (!Object.hasOwn(NOTED_ROWS, twin)) {
        expect(notedRowsOf(file), `${file}: its twin's note lists no row`).toEqual([]);
        continue;
      }
      shared.push(file);
      const note = must(exchangeOf(file).given.note, `${file}'s note`);
      const twinName = twin.replace(/\.json$/, "");
      if (Object.hasOwn(DANGER_LINES, twin)) {
        // A v1.14 refused claim's note opens with its twin's name, whose claim it is with one fault: "<twin>'s safety
        // claim made with no recipient", "<twin> answered with ..." (README "Fixtures", v1.14: "put right, each is its
        // accepted twin's"), so its given is its twin's, the danger line its twin's note lists with it.
        expect(
          note.startsWith(`${twinName}'s `) || note.startsWith(`${twinName} answered with `),
          `${file}: its note opens with its twin's claim`,
        ).toBe(true);
      } else {
        expect(note, file).toContain(
          `as ${twinName} reads it, with its rows written as that fixture's note lists them`,
        );
      }
      expect(notedRowsOf(file), file).toEqual(notedRowsOf(twin));
      expect(notedRowsOf(file).length, file).toBeGreaterThan(0);
    }
    expect(shared).toEqual([
      "invalid/refuse-safety-claim-takes-routine-row.json",
      "invalid/refuse-safety-claim-lists-held-row.json",
      "invalid/refuse-turn-party-caller-business.json",
      "invalid/refuse-claim-safety-no-recipient.json",
      "invalid/refuse-claim-safety-other-class.json",
    ]);
    // An accepted fixture's rows are its own note's, and a fixture whose note lists none has none.
    expect(notedRowsOf(PARTY_OF_TURN_1)).toEqual(testOwnerRows());
    expect(notedRowsOf("read-turn-party-one-role.json")).toEqual([]);
  });
});

describe("data-access database side: each accepted exchange of v1.3, v1.4, v1.6, v1.7, v1.8, v1.9, v1.10, v1.11 and v1.14 gives its outcome through db/repo", () => {
  for (const entry of sideAccepted) {
    it(
      `${entry.file} (${entry.version}): in its role and on its side, db/repo answers the fixture's outcome`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        const expected = await answerOf(entry, exchange);
        const version = answeredAt(entry, exchange);
        const before = WRITERS.includes(exchange.call) ? await written() : null;
        const marked = exchange.call === REPEAT.call ? await marks() : null;
        const unclaimed = exchange.call === SAFETY_CLAIM.call ? await marks() : null;
        sent.length = 0;
        const answer = await runExchange(exchange);
        expect(answer).toEqual(expected);
        expect(answerErrors(version, exchange.call, answer), `the answer, at ${version}`).toEqual([]);
        expect(
          errorsOf(validatorOf(version, must(entry.def)), { ...exchange, outcome: answer }),
          `the exchange with db/repo's answer, at ${version}`,
        ).toEqual([]);
        expect(sent.length, "the call reached the database").toBeGreaterThan(0);
        if (before !== null) {
          expect(
            writtenProblems(before, await written(), exchange, answer),
            "what the tables then hold",
          ).toEqual([]);
        }
        if (marked !== null) {
          expect(markProblems(marked, await marks(), exchange, answer), "what the outbox then holds").toEqual(
            [],
          );
        }
        if (unclaimed !== null) {
          // A v1.14 claim: the outbox holds the claims the answer gives, and every other row as it was (item 67).
          expect(
            claimProblems(unclaimed, await marks(), exchange, answer),
            "what the outbox then holds",
          ).toEqual([]);
        }
      },
    );
  }

  it(
    "has the claim check fire: a claim the tables do not hold, an error that wrote, a routine row a safety claim's answer names, a row past the limit, a held row listed",
    SLOW,
    async () => {
      const exchange = await given(PAST_TEN_NOTICES);
      const unclaimed = await marks();
      const answer = await runExchange(exchange);
      const claimedNow = await marks();
      expect(answer).toEqual(exchange.outcome);
      expect(claimedNow, "the claim wrote").not.toEqual(unclaimed);
      expect(claimProblems(unclaimed, claimedNow, exchange, answer)).toEqual([]);
      const line = must(DANGER_LINES[PAST_TEN_NOTICES], "the danger line").rowId;
      expect(claimProblems(unclaimed, unclaimed, exchange, answer)).toEqual([
        `${line} is not sending at the answer's version`,
        `${line}'s claim is not the answer's`,
        `${line}'s part ${line}/1/1 is not the answer's`,
      ]);
      const transient = { error: "transient", sqlstate: "55P03" };
      expect(claimProblems(unclaimed, unclaimed, exchange, transient)).toEqual([]);
      expect(claimProblems(unclaimed, claimedNow, exchange, transient)).toEqual([
        "an answer that claims nothing wrote",
      ]);
      // The refused answer, with Sam's first routine notice claimed too: the tables hold no such claim, and the
      // notice is no safety row.
      const refused = exchangeOf("invalid/refuse-safety-claim-takes-routine-row.json").outcome;
      const notice = noticeIdOf(1);
      expect(claimProblems(unclaimed, claimedNow, exchange, refused)).toEqual([
        `${notice} is not sending at the answer's version`,
        `${notice}, which a safety claim took, is of send class routine`,
        `${notice}'s claim is not the answer's`,
        `${notice}'s part ${notice}/1/1 is not the answer's`,
      ]);
      // An answer that names no row leaves the claim the tables hold unaccounted for; a limit the answer passes and a
      // held row it lists are a safety claim's faults.
      const none = { ...exchange.outcome, claimed: [] };
      expect(claimProblems(unclaimed, claimedNow, exchange, none)).toEqual([
        "a row the answer does not claim, a clock row or an entry changed",
      ]);
      const noRoom = { ...exchange, request: { ...exchange.request, limit: 0 } };
      expect(claimProblems(unclaimed, claimedNow, noRoom, answer)).toEqual([
        "1 rows are claimed, past the limit",
      ]);
      const listing = {
        ...exchange.outcome,
        passedHeld: [{ outboxRowId: notice, heldUntil: "2026-11-10T13:00:00Z" }],
      };
      expect(claimProblems(unclaimed, claimedNow, exchange, listing)).toEqual([
        "a safety claim lists a held row",
      ]);
    },
  );

  it(
    "has the mark check fire: a repeat or an error that wrote, a row, a stored time and a first delivery other than the answer's",
    SLOW,
    async () => {
      const delivery = await given("mark-a7-03-poll-delivered.json");
      const sentOnly = await marks();
      const recorded = await runExchange(delivery);
      const delivered = await marks();
      expect(recorded).toEqual(delivery.outcome);
      expect(delivered, "the poll's delivery was recorded").not.toEqual(sentOnly);
      expect(markProblems(sentOnly, delivered, delivery, recorded)).toEqual([]);
      const later = { ...delivery, request: { ...delivery.request, at: "2026-10-23T14:05:07Z" } };
      expect(markProblems(sentOnly, delivered, later, recorded)).toEqual([
        "the part try is not delivered at the receipt's at",
      ]);
      // The poll's receipt again, over the tables as the delivery left them: its fixture's answer, a repeat.
      const repeat = exchangeOf("mark-a7-03-poll-delivered-repeat.json");
      expect(repeat.given.after).toEqual(["mark-a7-03-poll-delivered.json"]);
      expect(markProblems(delivered, delivered, repeat, repeat.outcome)).toEqual([]);
      expect(markProblems(sentOnly, delivered, repeat, repeat.outcome)).toEqual(["a repeat wrote"]);
      const notFound = { error: "notFound", table: "outbox_parts", rowId: "linq-msg-demo-0302" };
      expect(markProblems(delivered, delivered, repeat, notFound)).toEqual([]);
      expect(markProblems(sentOnly, delivered, repeat, notFound)).toEqual([
        "an answer that marks nothing wrote",
      ]);
      expect(
        markProblems(delivered, delivered, repeat, {
          ...repeat.outcome,
          row: { state: "delivered", version: 8 },
        }),
      ).toEqual(["the row the tables hold is not the answer's"]);
      expect(
        markProblems(delivered, delivered, repeat, {
          ...repeat.outcome,
          [REPEAT.field]: { firstOfRow: true, deliveredAt: "2026-10-23T14:05:16Z" },
        }),
      ).toEqual([
        "the part try holds delivered_at 2026-10-23T14:05:06Z, not the answer's 2026-10-23T14:05:16Z",
        "the answer says firstOfRow true, and by the times the tables hold it is false",
      ]);
    },
  );

  it(
    "has the written check fire: a write no answer gives, an entry and a row other than the answer's",
    SLOW,
    async () => {
      const exchange = await given("open-chat-first-text-sam.json");
      const before = await written();
      const answer = await runExchange(exchange);
      const after = await written();
      expect(writtenProblems(before, after, exchange, answer)).toEqual([]);
      expect(writtenProblems(before, after, exchange, { ...exchange.outcome, event: null })).toEqual([
        "an answer that appends no entry wrote",
      ]);
      expect(writtenProblems(before, before, exchange, answer)).toEqual([
        "0 entries were appended, not one",
        "the handle's phone row is not the answer's",
      ]);
      const outcome = exchange.outcome as { phone: Record<string, Json>; event: Record<string, Json> };
      const other = {
        ...outcome,
        phone: { ...outcome.phone, version: 2 },
        event: { ...outcome.event, actorKind: "job" },
      };
      expect(writtenProblems(before, after, exchange, other)).toEqual([
        "the entry appended is not the answer's at actor_kind",
        "the handle's phone row is not the answer's",
      ]);
      const later = { ...exchange, given: { ...exchange.given, now: "2026-10-19T18:05:02Z" } };
      expect(writtenProblems(before, after, later, answer)).toEqual([
        "the entry appended is not the answer's at at",
      ]);
    },
  );
});

describe("data-access database side: each refused fixture of v1.3, v1.4, v1.6, v1.7, v1.8, v1.9, v1.10, v1.11 and v1.14 is refused by db/repo", () => {
  for (const entry of sideRefused.filter((refused) => defOf(refused).part === "request")) {
    it(
      `${entry.file} (${entry.version}): db/repo refuses the request before any statement reaches the database`,
      SLOW,
      async () => {
        const request = fixture(entry.file) as Record<string, Json>;
        const { call } = defOf(entry);
        expect(
          errorsOf(validatorOf(entry.version, must(entry.def)), request),
          "refused by its schema",
        ).not.toEqual([]);
        const dbCall = callOf(call);
        sent.length = 0;
        await expect(
          dbCall.run(clientOf(dbCall.role(request)), request as never, { now: new Date() }),
        ).rejects.toThrow(TypeError);
        expect(sent, "no statement was sent: nothing read or written").toEqual([]);
      },
    );
  }

  for (const entry of sideRefused.filter(isAnswerDef)) {
    it(
      `${entry.file} (${entry.version}): in its twin's state db/repo answers it put right, never as it stands`,
      SLOW,
      async () => {
        const twin = must(RESPONSE_TWINS[entry.file], `${entry.file}'s twin`);
        const def = must(entry.def);
        const refused = fixture(entry.file);
        expect(errorsOf(validatorOf(entry.version, def), refused), "refused by its definition").not.toEqual(
          [],
        );
        const twinEntry = entryOf(twin.twin);
        const exchange = await given(twin.twin);
        const expected = await answerOf(twinEntry, exchange);
        const version = laterOf(entry.version, answeredAt(twinEntry, exchange));
        const answer = await runExchange(exchange);
        expect(answer, "the twin's own outcome").toEqual(expected);
        const validate = validatorOf(version, def);
        expect(errorsOf(validate, refused), `refused by its definition at ${version}`).not.toEqual([]);
        expect(errorsOf(validate, answer), "db/repo's answer, by the refused fixture's definition").toEqual(
          [],
        );
        expect(answerErrors(version, exchange.call, answer), `db/repo's answer, at ${version}`).toEqual([]);
        const added = addsSwitch(twinEntry, exchange) ? [SWITCH.field] : [];
        expect(twinProblems(refused, answer, { ...twin, added })).toEqual([]);
      },
    );
  }

  for (const entry of sideRefused.filter((refused) => Object.hasOwn(REQUEST_TWINS, refused.file))) {
    it(
      `${entry.file} (${entry.version}): in its own given db/repo refuses its request before any statement reaches the database, and answers it put right as its twin`,
      SLOW,
      async () => {
        const twin = must(REQUEST_TWINS[entry.file], `${entry.file}'s twin`);
        const validate = validatorOf(entry.version, must(entry.def));
        expect(errorsOf(validate, exchangeOf(entry.file)), "refused by its definition").not.toEqual([]);
        // In its own given, where the question it names is there to be read: the request is refused as it stands.
        const exchange = await given(entry.file);
        sent.length = 0;
        await expect(runExchange(exchange)).rejects.toThrow(TypeError);
        expect(sent, "no statement was sent: nothing read or written").toEqual([]);
        // With its one fault taken out the request is its twin's, and db/repo answers it the outcome both state.
        const right: Exchange = { ...exchange, request: exchangeOf(twin.twin).request };
        const answer = await runExchange(right);
        expect(answer, "the twin's outcome, which the refused fixture states too").toEqual(exchange.outcome);
        expect(
          answerErrors(entry.version, exchange.call, answer),
          `db/repo's answer, at ${entry.version}`,
        ).toEqual([]);
        expect(errorsOf(validate, { ...right, outcome: answer }), "put right, with db/repo's answer").toEqual(
          [],
        );
        expect(sent.length, "the request put right reached the database").toBeGreaterThan(0);
      },
    );
  }

  for (const entry of sideRefused.filter(
    (refused) => defOf(refused).part === "exchange" && !Object.hasOwn(REQUEST_TWINS, refused.file),
  )) {
    // A text and a mark answered as their twins write nothing. A claim answered as its twin writes its twin's claim,
    // the danger line's alone (v1.14): the routine notice the refused answer claims and the held row it lists are
    // left as they were.
    const claims = defOf(entry).call === SAFETY_CLAIM.call;
    const writes = claims ? "claims the rows that outcome gives and no other" : "writes nothing";
    it(
      `${entry.file} (${entry.version}): in its own given db/repo answers its twin's outcome, never its own, and ${writes}`,
      SLOW,
      async () => {
        const twin = must(EXCHANGE_TWINS[entry.file], `${entry.file}'s twin`);
        const validate = validatorOf(entry.version, must(entry.def));
        const refused = exchangeOf(entry.file);
        expect(errorsOf(validate, refused), "refused by its definition").not.toEqual([]);
        const exchange = await given(entry.file);
        const before = await written();
        const marked = exchange.call === REPEAT.call ? await marks() : null;
        const unclaimed = claims ? await marks() : null;
        sent.length = 0;
        const answer = await runExchange(exchange);
        expect(answer, "the twin's outcome").toEqual(exchangeOf(twin.twin).outcome);
        expect(
          answerErrors(entry.version, exchange.call, answer),
          `db/repo's answer, at ${entry.version}`,
        ).toEqual([]);
        expect(
          errorsOf(validate, { ...refused, outcome: answer }),
          "put right with db/repo's answer",
        ).toEqual([]);
        expect(twinProblems(refused.outcome, answer, twin), "it differs at the fault alone").toEqual([]);
        expect(sent.length, "the call reached the database").toBeGreaterThan(0);
        expect(await written(), "nothing written").toEqual(before);
        if (marked !== null) {
          const after = await marks();
          expect(after, "nothing written to the outbox, its claims, the clock rows or the log").toEqual(
            marked,
          );
          expect(markProblems(marked, after, exchange, answer), "what the outbox holds").toEqual([]);
        }
        if (unclaimed !== null) {
          const after = await marks();
          expect(claimProblems(unclaimed, after, exchange, answer), "what the outbox holds").toEqual([]);
          // What the refused answer gives beside its twin's is not in the tables: a row it claims that the twin's
          // does not is as it was, unclaimed, and a row it lists as passed held was never read, so it too is as it was.
          const idOf = (row: Record<string, Json>): string => textOf(row.outboxRowId, "a row's id");
          const twins = new Set((exchangeOf(twin.twin).outcome.claimed as Record<string, Json>[]).map(idOf));
          const extra = [
            ...(refused.outcome.claimed as Record<string, Json>[]),
            ...(refused.outcome.passedHeld as Record<string, Json>[]),
          ]
            .map(idOf)
            .filter((id) => !twins.has(id));
          expect(extra.length, "the refused answer names a row its twin's does not").toBeGreaterThan(0);
          for (const id of extra) {
            const held = (state: Marks): unknown => ({
              row: state.rows.filter((row) => row.id === id),
              parts: state.parts.filter((part) => part.outbox_row_id === id),
              claims: state.claims.filter((claim) => claim.outbox_row_id === id),
            });
            expect(
              unclaimed.rows.filter((row) => row.id === id),
              `${id} is a row`,
            ).toHaveLength(1);
            expect(held(after), `${id} is as it was`).toEqual(held(unclaimed));
            expect(after.rows.find((row) => row.id === id)?.send_class, `${id} is of another class`).not.toBe(
              SAFETY_CLAIM.value,
            );
          }
        }
      },
    );
  }

  it("has the twin check fire: an answer as the refused one stands, a difference beside the fault, a fault not there", () => {
    const refused = fixture("invalid/refuse-business-zone-null.json");
    const right = exchangeOf("business-zone-barbershop.json").outcome;
    expect(twinProblems(refused, right, { faults: ["timeZone"] })).toEqual([]);
    expect(twinProblems(refused, refused, { faults: ["timeZone"] })).toEqual([
      "db/repo answers the refused fixture as it stands",
      "the fault timeZone is not where db/repo's answer differs",
    ]);
    expect(
      twinProblems(refused, { ...right, readAt: "2026-10-27T09:00:05Z" }, { faults: ["timeZone"] }),
    ).toEqual(["db/repo's answer differs at readAt, which is not the fault"]);
    expect(twinProblems(refused, right, { faults: ["timeZone", "businessId"] })).toEqual([
      "the fault businessId is not where db/repo's answer differs",
    ]);
    const holds = fixture("invalid/refuse-open-holds-hold-with-words.json");
    const open = exchangeOf("read-open-holds-alex.json").outcome;
    expect(twinProblems(holds, open, { part: "holds.0", faults: ["holds.0.sealedWords"] })).toEqual([]);
    expect(twinProblems(holds, open, { faults: ["holds.0.sealedWords"] })).toEqual([
      "db/repo's answer differs at holds, which is not the fault",
      "db/repo's answer differs at unreadEventIds, which is not the fault",
    ]);
  });

  it("has the twin check take v1.6's switch on an earlier twin's answer and nothing beside it: no other place, no switch the refused one states", () => {
    const address = fixture("invalid/refuse-outbox-row-returns-address.json") as Record<string, Json>;
    const asV16 = withSwitch(exchangeOf("read-outbox-row-s1-02.json").outcome);
    const twin = { faults: ["recipient.address"], added: [SWITCH.field] };
    expect(twinProblems(address, asV16, twin)).toEqual([]);
    expect(twinProblems(address, asV16, { faults: twin.faults }), "the switch not taken").toEqual([
      "db/repo's answer differs at businessSensitive, which is not the fault",
    ]);
    expect(twinProblems(address, { ...asV16, readAt: "2026-10-19T18:05:06Z" }, twin)).toEqual([
      "db/repo's answer differs at readAt, which is not the fault",
    ]);
    expect(twinProblems({ ...address, businessSensitive: true }, asV16, twin), "a stated switch").toEqual([
      "db/repo's answer differs at businessSensitive, which is not the fault",
    ]);
    expect(twinProblems(address, withSwitch(address), twin), "the switch alone puts nothing right").toEqual([
      "db/repo answers the refused fixture as it stands",
      "the fault recipient.address is not where db/repo's answer differs",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// v1.14's claim where no fixture shows it (the card's two lead notes, DL-698 and DL-761)

/**
 * Row S (T-1341; T-1353's security note c: "Row S's own case (a quick_reply outage row under a live claim) has no
 * fixture"): the outage line to Sam, K-01's fixed line outage in the words db/repo's own row S test gives it
 * (db/repo/outbox.int.test.ts), send class quick_reply, committed after his danger line of
 * claim-safety-past-ten-checked-rows and sending under dispatcher-1's live claim, its one part pending; and after it a
 * second danger line, so row S is ahead of a safety row in commit order. Every id, trace and time is an example.
 */
const ROW_S = {
  rowId: "out-sam-outage-s",
  turnId: "turn-sam-outage-s",
  eventId: "evt-sam-outage-s",
  traceId: "trace-sam-outage-s",
  fixedLine: "outage",
  words: "Rosie is down for a few minutes. If anyone is in danger, call 911.",
  committedAt: "2026-11-09T15:00:02Z",
  claimer: "dispatcher-1",
  claimedAt: "2026-11-09T15:00:03Z",
  lapsesAt: "2026-11-09T15:01:03Z",
} as const;

/** The danger line written after row S: Sam's next text reads as danger too. */
const LINE_AFTER_ROW_S: DangerLine = {
  turnId: "turn-sam-safety-0065",
  handleId: "handle-sam",
  personId: "person-sam",
  eventId: "evt-sam-0065",
  traceId: "trace-sam-0065",
  rowId: "out-sam-safety-0065",
  at: "2026-11-09T15:00:04Z",
};

/** Row S's four rows, as the tables' owner writes them: its turn, the row, its one part try and its live claim. */
function rowSRows(): SeedRow[] {
  const bundle = seedBundle();
  const { handleId, personId, businessId, channel } = NOTICES_TURN;
  const { rowId, turnId, eventId, traceId, fixedLine, words, committedAt, claimer, claimedAt, lapsesAt } =
    ROW_S;
  return [
    {
      table: "turns",
      values: {
        id: turnId,
        handle_id: handleId,
        event_ids: [eventId],
        state: "committed",
        bundle_hash: bundle.hash,
        bundle_build: bundle.build,
        trace_id: traceId,
        joined_trace_ids: [],
        tries: 1,
        committed_at: committedAt,
        version: 1,
      },
    },
    {
      table: "outbox_rows",
      values: {
        id: rowId,
        turn_id: turnId,
        recipient_handle_id: handleId,
        recipient_person_id: personId,
        business_id: businessId,
        booking_id: null,
        channel,
        send_class: "quick_reply",
        versions_read: [],
        open_question_id: null,
        plan: {
          row: rowId,
          channel,
          copyOf: null,
          plan: { formats: ["text"], lines: [], question: null, pageType: null, threadReplyTo: null },
        },
        final_parts: {
          row: rowId,
          channel,
          sends: [{ kind: "words", text: words, calendarFile: "none", options: [], link: null }],
          fixedLines: [fixedLine],
          slotValues: [],
          threadReplyTo: null,
        },
        copy_of_row_id: null,
        state: "sending",
        bundle_hash: bundle.hash,
        bundle_build: bundle.build,
        trace_id: traceId,
        version: 3,
      },
    },
    {
      table: "outbox_parts",
      values: {
        outbox_row_id: rowId,
        part_no: 1,
        try_no: 1,
        idempotency_key: `${rowId}/1/1`,
        attempts: 1,
        kind: "words",
        state: "pending",
        version: 1,
      },
    },
    {
      table: "outbox_claims",
      values: {
        outbox_row_id: rowId,
        claimer,
        claimed_at: claimedAt,
        lapses_at: lapsesAt,
        claim_no: 1,
        first_try_at: claimedAt,
        next_try_not_before: null,
        version: 1,
      },
    },
  ];
}

/** A claim's request and db/repo's answer as one claimOutbox.exchange of `version`: Ajv's errors, none when valid. */
function claimExchangeErrors(version: string, exchange: Exchange, answer: unknown): string[] {
  return errorsOf(validatorOf(version, `${SAFETY_CLAIM.call}.exchange`), { ...exchange, outcome: answer });
}

/** The outbox tables alone, which a claim writes: the rows, their part tries and their claims. */
const outboxOf = ({ rows, parts, claims }: Marks): Pick<Marks, "rows" | "parts" | "claims"> => ({
  rows,
  parts,
  claims,
});

describe("data-access database side: v1.14's claim where no fixture shows it, row S's case and a claim without sendClass", () => {
  it(
    "row S's case: a quick_reply outage row sending under a live claim, ahead of a safety row, is passed, never read and never locked by the safety claim, which takes the recipient's safety rows in commit order and no row of another class",
    SLOW,
    async () => {
      // Sam's world of claim-safety-past-ten-checked-rows: ten checked routine notices, then his danger line. After
      // them, as the tables' owner: row S, sending under a live claim, and a second danger line behind it.
      const base = await given(PAST_TEN_NOTICES);
      const first = must(DANGER_LINES[PAST_TEN_NOTICES], "Sam's first danger line");
      await db.sql.begin(async (tx) => {
        for (const row of [...rowSRows(), ...dangerLineRows(LINE_AFTER_ROW_S)]) {
          await insertRow(tx, row.table, row.values);
        }
      });
      const now = "2026-11-09T15:00:05Z";
      const exchange: Exchange = {
        ...base,
        given: { ...base.given, now },
        request: { ...base.request, claimer: "dispatcher-2", now },
      };
      expect(
        [exchange.request.recipientHandleId, exchange.request[SAFETY_CLAIM.field], exchange.request.limit],
        "a safety claim of Sam's rows, with limit 10",
      ).toEqual([first.handleId, SAFETY_CLAIM.value, NOTICES_TURN.count]);
      const before = await marks();
      // In commit order: the ten notices, the first danger line, row S, the second danger line; row S's claim is live.
      const order = before.rows
        .map((row) => ({ id: String(row.id), seq: Number(row.commit_seq), sendClass: row.send_class }))
        .sort((a, b) => a.seq - b.seq);
      expect(order.map((row) => row.id).slice(NOTICES_TURN.count)).toEqual([
        first.rowId,
        ROW_S.rowId,
        LINE_AFTER_ROW_S.rowId,
      ]);
      expect(order.slice(0, NOTICES_TURN.count).map((row) => row.sendClass)).toEqual(
        Array.from({ length: NOTICES_TURN.count }, () => "routine"),
      );
      expect(Date.parse(ROW_S.lapsesAt), "row S's claim is live at the claim").toBeGreaterThan(
        Date.parse(now),
      );
      // Another run holds every row of another class locked, row S with its part and its claim, as its renewal or its
      // mark does while it runs. A walk that read or locked one of them would wait here, past the claim's bounded lock
      // wait, and answer transient: the safety claim answers the two danger lines.
      let answer: unknown = null;
      sent.length = 0;
      await db.sql.begin(async (tx) => {
        const locked = await tx<{ id: string }[]>`
          select id from outbox_rows where send_class <> ${SAFETY_CLAIM.value} order by id for update
        `;
        expect(locked.length, "the ten notices and row S").toBe(NOTICES_TURN.count + 1);
        await tx`select outbox_row_id from outbox_claims where outbox_row_id = ${ROW_S.rowId} for update`;
        await tx`select idempotency_key from outbox_parts where outbox_row_id = ${ROW_S.rowId} for update`;
        answer = await runExchange(exchange);
      });
      const claimSent = [...sent];
      const after = await marks();
      expect(isError(answer), "the claim did not wait on a row of another class").toBe(false);
      const claimed = (answer as { claimed: Record<string, Json>[]; passedHeld: Json[] }).claimed;
      expect(
        claimed.map((row) => [row.outboxRowId, row.sendClass, row.claimedFrom, row.version]),
        "the safety rows, in commit order",
      ).toEqual([
        [first.rowId, SAFETY_CLAIM.value, "checked", 3],
        [LINE_AFTER_ROW_S.rowId, SAFETY_CLAIM.value, "checked", 3],
      ]);
      const seqs = claimed.map((row) => Number(row.commitSeq));
      const seqOf = (id: string): number => must(order.find((row) => row.id === id)).seq;
      expect(seqs, "each claimed row's place in commit order").toEqual([
        seqOf(first.rowId),
        seqOf(LINE_AFTER_ROW_S.rowId),
      ]);
      expect(seqOf(ROW_S.rowId), "row S is between them").toBeGreaterThan(must(seqs[0]));
      expect(seqOf(ROW_S.rowId), "row S is ahead of a safety row").toBeLessThan(must(seqs[1]));
      // The answer is a v1.14 safety claim's: in v1.13's full form, passedHeld empty, valid as an exchange.
      expect(answerErrors(SAFETY_CLAIM.version, exchange.call, answer)).toEqual([]);
      expect(claimExchangeErrors(SAFETY_CLAIM.version, exchange, answer)).toEqual([]);
      // The tables hold the two claims and nothing else changed: row S, its part and its claim, and the ten notices.
      expect(claimProblems(before, after, exchange, answer)).toEqual([]);
      const rowS = (state: Marks): unknown => ({
        rows: state.rows.filter((row) => row.id === ROW_S.rowId),
        parts: state.parts.filter((part) => part.outbox_row_id === ROW_S.rowId),
        claims: state.claims.filter((claim) => claim.outbox_row_id === ROW_S.rowId),
      });
      expect(rowS(after), "row S as it was").toEqual(rowS(before));
      expect(
        after.rows.filter((row) => row.id === ROW_S.rowId).map((row) => [row.state, row.version]),
        "row S still sending under its own claim",
      ).toEqual([["sending", 3]]);
      // Never read: each statement the claim sent that reads outbox_rows asks for one send class.
      const reads = claimSent.filter((query) => /\bfrom\s+outbox_rows\b/i.test(query));
      expect(reads.length, "the claim's read of outbox_rows").toBeGreaterThan(0);
      for (const query of reads) expect(query, "a read of one send class").toMatch(/send_class\s*=\s*\$\d+/);
    },
  );

  // DL-761: the routine claim the first text's send binds (T-1401) is a claim without sendClass through
  // claimOutboxV114. In each of two worlds, a sweep that claims two recipients' rows (v1.2's
  // claim-in-order-with-port) and a named recipient's claim (v1.1's claim-alex-safety), it answers as
  // claimOutboxV113 does.
  for (const file of ["claim-in-order-with-port.json", "claim-alex-safety.json"]) {
    it(
      `a claim without sendClass through claimOutboxV114 is answered in v1.13 item 64's form, with the rows and fields claimOutboxV113 gives and the same rows written: ${file}'s claim`,
      SLOW,
      async () => {
        const entry = entryOf(file);
        expect([entry.expect, defOf(entry).call, claimsBefore(entry)], file).toEqual([
          "accept",
          SAFETY_CLAIM.call,
          true,
        ]);
        // First through v1.13's own claim, in the fixture's given.
        const exchange = await given(file);
        expect(Object.hasOwn(exchange.request, SAFETY_CLAIM.field), `${file}: no sendClass`).toBe(false);
        const unclaimed = await marks();
        const byV113 = await claimOutboxV113(job, structuredClone(exchange.request) as never);
        const afterV113 = await marks();
        // Then through v1.14's, in the same given, built again.
        await given(file);
        expect(outboxOf(await marks()), "the same world again").toEqual(outboxOf(unclaimed));
        sent.length = 0;
        const answer = await runExchange(exchange);
        const after = await marks();
        expect(sent.length, "the call reached the database").toBeGreaterThan(0);
        expect(answer, "the answer claimOutboxV113 gives").toEqual(byV113);
        expect(outboxOf(after), "the rows claimOutboxV113 writes").toEqual(outboxOf(afterV113));
        expect(outboxOf(after), "the claim wrote").not.toEqual(outboxOf(unclaimed));
        expect(claimProblems(unclaimed, after, exchange, answer), "what the outbox then holds").toEqual([]);
        // v1.13 item 64's form: valid as v1.13's answer and exchange, and as v1.14's, each claimed row stating its
        // claim, claimedFrom and port and item 64's emailPurpose and notAfter, null for a row with a turn.
        const form = SAFETY_CLAIM.form;
        expect(answerErrors(form, exchange.call, answer), `the answer, at ${form}`).toEqual([]);
        expect(claimExchangeErrors(form, exchange, answer), `the exchange, at ${form}`).toEqual([]);
        expect(claimExchangeErrors(SAFETY_CLAIM.version, exchange, answer), "the exchange, at v1.14").toEqual(
          [],
        );
        const claimed = (answer as { claimed: Record<string, Json>[] }).claimed;
        expect(claimed.length, `${file}: rows claimed`).toBeGreaterThan(0);
        for (const row of claimed) {
          for (const field of ["claim", "claimedFrom", PORT.field, "emailPurpose", "notAfter"]) {
            expect(Object.hasOwn(row, field), `${textOf(row.outboxRowId, "a row")}: ${field} stated`).toBe(
              true,
            );
          }
          expect([row.emailPurpose, row.notAfter]).toEqual([null, null]);
        }
        // The same rows and fields: the fixture's own outcome (a v1.1 claim's with each row's port, as v1.2 answers
        // it), with item 64's two fields on each claimed row and nothing else changed.
        const stated = addsPort(entry, exchange) ? withPorts(exchange.outcome) : exchange.outcome;
        expect(answer, "the fixture's outcome, with item 64's fields").toEqual({
          ...stated,
          claimed: (stated.claimed as Record<string, Json>[]).map((row) => ({
            ...row,
            emailPurpose: null,
            notAfter: null,
          })),
        });
      },
    );
  }

  it("runs the two cases through DB_CALLS' claim, db/repo's claimOutboxV114, as every v1.14 claim runs", () => {
    expect(callOf(SAFETY_CLAIM.call).run).toBe(claimOutboxV114);
    expect(SAFETY_CLAIM.form, "the form a claim without sendClass is answered in").toBe("v1.13");
    expect(isBefore(SAFETY_CLAIM.form, SAFETY_CLAIM.version)).toBe(true);
  });
});
