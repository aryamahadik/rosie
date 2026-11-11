// Contract test for K-05, the data-access calls: the database side of v1.3, v1.4, v1.6 and v1.7 (T-1169; T-1199 for
// v1.6; T-1214 for v1.7; DL-348, DL-373, DL-398, DL-444; contracts/data-access/README.md sections "v1.3", "v1.4", "v1.6"
// and "v1.7", their "Consumers of" lists, "Fixtures", and "Producers and consumers").
//
// The fixture part, data-access.v1.test.ts, checks every fixture against the schema of its version. This part is the
// producer's side (C-152) for the versions whose calls the database engineer built: v1.3's three turn-face reads
// (T-1138, db/repo/turn-face-reads.ts), v1.4's seven safety reads (T-1161, db/repo/safety-reads.ts), v1.6's
// businessSensitive on readOutboxRow (T-1197, db/repo/turn-face-reads.ts: the row's business's sensitive switch, read
// from K-23's company_kinds; README item 45) and v1.7's openChatOnText (T-1212, db/repo/chat-open.ts: a number's text
// opens its chat, writing its phone row and one phone.chat_opened entry; README item 46). v1.5 adds no database call
// (README "v1.5": rowReader is the consumers' mapping), so it has no database side. Every entry of fixtures/index.json
// whose version is one of DB_SIDE_VERSIONS runs here, selected by its version, never by a pinned list or count (DL-124,
// DL-125), against local PostgreSQL with every migration applied to a fresh schema (db/repo/test-db.ts):
//   - each accepted exchange: its given is loaded (its k04Seeds and partSeeds, each with its own after chain, and the
//     exchanges its after chain names, run first through db/repo, each answering its own fixture's outcome, a call no
//     side entry names through CHAIN_CALLS; then the rows its note says its database side writes itself, where no frozen
//     seed holds them: NOTED_ROWS); then its request goes through the db/repo call it names, in the role and on the side
//     the README gives that call (items 34 to 43 and 46; commitTurn per write, as rosie_job). The answer is the fixture's
//     outcome, and the answer and the exchange that holds it are valid against the schema of the entry's own version. For
//     a call that writes (WRITERS: v1.7's openChatOnText), the tables then hold what the answer gives: the row as the
//     call leaves it and the one entry it appends, or nothing written. Two answers are compared otherwise, each with a
//     field a later version adds, never with one dropped: db/repo answers a readOutboxRow exchange of a version before
//     v1.6 as v1.6 does, which always states businessSensitive (SWITCH), so its answer is the fixture's outcome, whole,
//     with businessSensitive null and nothing else changed (the exchange's world holds no kind of work, checked before the
//     read), valid at v1.6, whose readOutboxRow.v1dot6Response is a v1.6 answer; and a v1.1 claim a chain runs first is
//     answered as v1.2 does, each claimed row naming its port (PORT), valid at v1.2;
//   - each refused request: the db/repo call refuses it before any statement reaches the database, so nothing is read or
//     written;
//   - each refused answer (its definition a call's response, or v1.6's readOutboxRow.v1dot6Response): in the state of
//     the accepted exchange that answers the same read (its twin), db/repo's answer is valid against the refused entry's
//     own definition, at the version db/repo answers the twin, which refuses the fixture too, and it differs from the
//     refused fixture only at the fault the fixture carries (and at businessSensitive alone where db/repo answers an
//     earlier twin as v1.6): the repo answers it put right, never as it stands;
//   - each refused exchange (v1.7's refuse-open-chat-stopped-number): in its own given, its twin's but for its note,
//     db/repo answers its request with the twin's outcome, which differs from the refused one only at its fault, the
//     exchange with that answer is accepted, and nothing is written.
// So a call of db/repo that drifts from the frozen contract fails this test. The repo's own tests (db/repo/*.int.test.ts)
// hold the rest of the producer's side for these calls: other businesses' rows, the column lists, the roles refused,
// and for openChatOnText parallel texts, a STOP and a START around the call, and its transient answers.
//
// It needs PostgreSQL: `npm run db:up` locally (DATABASE_URL, else the local Docker database when CI is unset), and the
// merge check's service database (DATABASE_URL) in CI.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openChatOnText } from "../../db/repo/chat-open";
import { resolvePrimaryUrl } from "../../db/repo/client";
import { commitTurn } from "../../db/repo/commit-turn";
import { claimOutboxV12, markRowV12, writePlan } from "../../db/repo/outbox";
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
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { readFixedLineFacts, readOpenHolds, readOutboxRow } from "../../db/repo/turn-face-reads";
import { CONTRACTS_ROOT, REPO_ROOT, type FixtureEntry } from "./_harness";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
const DB_SCHEMA_DIR = path.join(CONTRACTS_ROOT, "db-schema");
const CORE_SEEDS_DIR = path.join(DB_SCHEMA_DIR, "core", "fixtures");
/** Fixture set v1's demo shops (rule 9): a kind of work a note lists takes its facts from its shop. */
const SHOPS_DIR = path.join(REPO_ROOT, "fixtures", "v1", "test-kit", "shops");
const SLOW = { timeout: 60_000 };

/**
 * The versions with a database side here: v1.3 (T-1138), v1.4 (T-1161), v1.6 (T-1197) and v1.7 (T-1212). v1 to v1.2's
 * database sides are tasks of their own (README: T-116, T-478), and v1.5 has none.
 */
const DB_SIDE_VERSIONS = ["v1.3", "v1.4", "v1.6", "v1.7"];

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
 * The parts of a definition that name an answer: a call's response, and v1.6's readOutboxRow.v1dot6Response, the answer
 * a v1.6 call gives (README item 45), which refuses refuse-outbox-row-switch-left-out.
 */
const ANSWER_PARTS: readonly string[] = ["response", "v1dot6Response"];
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
 * for imessage, rcs and sms), never with the field dropped from db/repo's answer, and that answer is valid at v1.2.
 */
const PORT = { call: "claimOutbox", version: "v1.2", field: "port" } as const;

/** Whether db/repo answers an exchange with the port its version leaves out: a claim before v1.2. */
const addsPort = (entry: FixtureEntry, exchange: Exchange): boolean =>
  exchange.call === PORT.call && !isError(exchange.outcome) && isBefore(entry.version, PORT.version);

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
 * there, which from v1.6 on is readOutboxRow.v1dot6Response for readOutboxRow (README item 45), and else its response.
 */
function answerDefOf(version: string, call: string, answer: unknown): string {
  if (isError(answer)) return `${call}.errors`;
  if (call === SWITCH.call && !isBefore(version, SWITCH.version)) return SWITCH.answerDef;
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
 * The calls v1.3, v1.4 and v1.7 add, and the commit their chains run: items 34 to 36 (v1.3), 37 to 43 (v1.4) and 46
 * (v1.7), each in the role its row of the README's table names; commitTurn per write, on the runtime side as rosie_job
 * (README "Scope"). v1.6 adds no call: businessSensitive is readOutboxRow's own (item 45, in item 35's transaction).
 * openChatOnText runs on the runtime side, as rosie_job with no business scope (item 46's table: phones and handles are
 * scoped none).
 */
const DB_CALLS: Readonly<Record<string, DbCall>> = {
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
};

/**
 * The calls a chain runs first that no entry of a version with a database side names: v1.1's plan, claim and limit-8
 * mark, which Dee W.'s waiting notice runs before open-chat-dee-closed-chat (README "Fixtures", v1.7), each on the
 * runtime side as rosie_job (v1 items 2 to 4; v1.1 items 13 and 16): the claim and the mark through v1.2's calls, which
 * answer v1.1's claim (PORT) and its waitingChat mark.
 */
const CHAIN_CALLS: Readonly<Record<string, DbCall>> = {
  writePlan: { role: () => "job", run: writePlan },
  claimOutbox: { role: () => "job", run: claimOutboxV12 },
  markRow: { role: () => "job", run: markRowV12 },
};

/** The calls that write: an answer gives the row it leaves and the entry it appends (item 46 step 4), or none. */
const WRITERS: readonly string[] = ["openChatOnText"];

const callOf = (call: string): DbCall => must(DB_CALLS[call], `a db/repo call for ${call}`);
/** A call a chain runs first: one of DB_CALLS, or else one of CHAIN_CALLS. */
const stepCallOf = (call: string): DbCall =>
  must(DB_CALLS[call] ?? CHAIN_CALLS[call], `a db/repo call for ${call}, run first`);

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
};

/**
 * Each refused exchange of a version with a database side, with its twin: the accepted exchange whose given (but its
 * note) and request it shares, whose outcome db/repo answers in the refused fixture's own given (README "Fixtures": put
 * right, each is its accepted twin's); and `faults`, the places of the refused outcome that carry its one fault.
 */
const EXCHANGE_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // v1.7: a text that opens Ben T.'s stopped chat by clearing his stop, which is its answer, its row and its entry; the
  // handle is the same (README "Consumers of v1.7": twin open-chat-ben-stopped, its outcome, nothing written)
  "invalid/refuse-open-chat-stopped-number.json": {
    twin: "open-chat-ben-stopped.json",
    faults: ["result", "phone", "event"],
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

/** By fixture, the rows its note says its database side writes itself before the read: no frozen seed holds them. */
const NOTED_ROWS: Readonly<Record<string, () => SeedRow[]>> = {
  "read-outbox-row-practice-sensitive.json": practiceRows,
};

/** How a note names a row it lists: "<table> <id>", and a kind of work "company_kinds <company> and <kind>". */
const notedAs = (row: SeedRow): string =>
  row.table === "company_kinds"
    ? `${row.table} ${textOf(row.values.company_id, "a kind's company")} and ${textOf(row.values.kind_id, "a kind")}`
    : `${row.table} ${textOf(row.values.id, `a ${row.table} row's id`)}`;

/** Every text a row value holds, in a list's items too. */
const textsIn = (value: Json): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(textsIn) : [];

// ---------------------------------------------------------------------------------------------------------------
// The database: one fresh schema for this file, the tables' owner for seeds, and a client per role

let db: TestDatabase;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first. */
let job: Sql;
let typedColumns: Map<string, string>;
/** Every statement the two role clients sent, in order (postgres.js debug: the text, never the values). */
const sent: string[] = [];

function roleClient(role: string, applicationName: string): Sql {
  return postgres(resolvePrimaryUrl(), {
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
  db = await createTestDatabase({ name: "data_access_db_side", client: { max: 2 } });
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
 * (addsPort), that outcome with each claimed row's port and nothing else changed; where it adds the switch
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
 * outcome (as answerOf reads it; a claim answered as v1.2 does valid at v1.2), then the rows its note lists
 * (NOTED_ROWS), as the tables' owner, in one transaction.
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
    const answer = await runExchange(before, stepCallOf(before.call));
    expect(answer, `${file}: ${step}, run first`).toEqual(expected);
    if (addsPort(entryOf(step), before)) {
      expect(answerErrors(PORT.version, before.call, answer), `${step}, answered at v1.2`).toEqual([]);
    }
  }
  const noted = NOTED_ROWS[file]?.() ?? [];
  await db.sql.begin(async (tx) => {
    for (const row of noted) await insertRow(tx, row.table, row.values);
  });
  return exchangeOf(file);
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

describe("data-access database side: the versions with one, each entry selected by its version", () => {
  it("runs every entry of v1.3, v1.4, v1.6 and v1.7, accepted and refused, each against a db/repo call the README names", () => {
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

  it("runs each exchange a chain runs first through db/repo: a call of DB_CALLS, else of CHAIN_CALLS, which no side entry names", () => {
    const sideCalls = new Set(sideEntries.map((entry) => defOf(entry).call));
    const runFirst = [
      ...sideAccepted.map((entry) => entry.file),
      ...Object.values(RESPONSE_TWINS).map((twin) => twin.twin),
      ...Object.values(EXCHANGE_TWINS).map((twin) => twin.twin),
      ...Object.keys(EXCHANGE_TWINS),
    ].flatMap((file) => chainOf(file).steps);
    const stepCalls = new Set(runFirst.map((step) => exchangeOf(step).call));
    for (const call of stepCalls) {
      expect([...Object.keys(DB_CALLS), ...Object.keys(CHAIN_CALLS)], `${call}, run first`).toContain(call);
    }
    for (const call of Object.keys(CHAIN_CALLS)) {
      expect([...stepCalls], `${call} is run first`).toContain(call);
      expect([...sideCalls], `${call} is no side entry's call`).not.toContain(call);
    }
    for (const call of WRITERS) expect(Object.keys(DB_CALLS), call).toContain(call);
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
    for (const [file, { twin }] of Object.entries(RESPONSE_TWINS)) {
      expect(entryOf(twin).expect, `${file}'s twin`).toBe("accept");
      expect(exchangeOf(twin).call, `${file}'s twin`).toBe(defOf(entryOf(file)).call);
    }
  });

  it("has a twin for every refused exchange: an accepted exchange of its call with its given (but its note) and request", () => {
    const exchanges = sideRefused.filter((entry) => defOf(entry).part === "exchange");
    expect(Object.keys(EXCHANGE_TWINS).sort()).toEqual(exchanges.map((entry) => entry.file).sort());
    expect(exchanges.length, "v1.7's refused exchange").toBeGreaterThan(0);
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
    expect(Object.keys(NOTED_ROWS)).toEqual(["read-outbox-row-practice-sensitive.json"]);
    const bundle = seedBundle();
    for (const [file, rowsOf] of Object.entries(NOTED_ROWS)) {
      expect(
        sideAccepted.map((entry) => entry.file),
        file,
      ).toContain(file);
      const note = must(exchangeOf(file).given.note, `${file}'s note`);
      expect(note, file).toContain("writes these five rows itself before the read, in this order");
      const rows = rowsOf();
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
      // Written after the chain: no exchange runs one whose rows are noted first.
      for (const entry of sideAccepted)
        expect(exchangeOf(entry.file).given.after, entry.file).not.toContain(file);
    }
  });
});

describe("data-access database side: each accepted exchange of v1.3, v1.4, v1.6 and v1.7 gives its outcome through db/repo", () => {
  for (const entry of sideAccepted) {
    it(
      `${entry.file} (${entry.version}): in its role and on its side, db/repo answers the fixture's outcome`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        const expected = await answerOf(entry, exchange);
        const version = answeredAt(entry, exchange);
        const before = WRITERS.includes(exchange.call) ? await written() : null;
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
      },
    );
  }

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

describe("data-access database side: each refused fixture of v1.3, v1.4, v1.6 and v1.7 is refused by db/repo", () => {
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

  for (const entry of sideRefused.filter((refused) => defOf(refused).part === "exchange")) {
    it(
      `${entry.file} (${entry.version}): in its own given db/repo answers its twin's outcome, never its own, and writes nothing`,
      SLOW,
      async () => {
        const twin = must(EXCHANGE_TWINS[entry.file], `${entry.file}'s twin`);
        const validate = validatorOf(entry.version, must(entry.def));
        const refused = exchangeOf(entry.file);
        expect(errorsOf(validate, refused), "refused by its definition").not.toEqual([]);
        const exchange = await given(entry.file);
        const before = await written();
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
