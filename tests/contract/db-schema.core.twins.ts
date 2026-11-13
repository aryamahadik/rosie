// K-04 v1.1's refused fixtures, each put right (T-1290; contracts/db-schema/core/README.md section "v1.1", its table
// "Refused rows (v1.1)", and the "shows" of each v1.1 entry of fixtures/index.json): each twin's one fault, what refuses
// it, and the one value that puts it right. The model (db-schema.core.v1.test.ts) and PostgreSQL with every migration
// applied (db-schema.core.v1.db-side.test.ts) both take the ways to put each twin right from here, so the same action
// passes in both. Not a test file: the two tests import it.
//
// And the edges of the CHECKs v1.1 adds (T-1290 round 2, DL-618; README section "v1.1", "What changes", defaults 12 and
// 15): each a twin's action with one value changed, or the tour row's own update, with what must happen. Both sides run
// every edge from here too.

import { readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACTS_ROOT } from "./_harness";

/** A value a fixture holds: what one column of a refused action takes. */
export type FixtureValue = string | number | boolean | null;

/** A fixture's JSON: a column value, or a jsonb column's array or object. */
export type FixtureJson = FixtureValue | FixtureJson[] | { [key: string]: FixtureJson };

/** How one refused fixture is put right: one value of its refused action changed, nothing else. */
export interface PutRight {
  /** Its one fault and the constraint that refuses it (README "Refused rows (v1.1)"). */
  reason: string;
  /** How the README puts it right. */
  putRight: string;
  /** The one path of the refused action that changes: `values.<column>` for an insert, `set.<column>` for an update. */
  at: string;
  /** The value put at that path. */
  value: FixtureValue;
}

/** The part of a refused action that a way to put it right changes. */
export interface Puttable {
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

const SEED_OUTBOX_ROW = path.join(CONTRACTS_ROOT, "db-schema", "core", "fixtures", "seed-outbox-row.json");
const WORDS_PART_KEY = "out-a7-03-alex/1/1";

/**
 * The delivery time seed-outbox-row.json gives the tour's words part (out-a7-03-alex/1/1), which
 * refuse-delivered-part-without-time's update drops: put right, the same update keeps it.
 */
function wordsPartDeliveredAt(): string {
  const seed = JSON.parse(readFileSync(SEED_OUTBOX_ROW, "utf8")) as {
    rows: { table: string; values: Record<string, unknown> }[];
  };
  const part = seed.rows.find(
    (row) => row.table === "outbox_parts" && row.values.idempotency_key === WORDS_PART_KEY,
  );
  const deliveredAt = part?.values.delivered_at;
  if (typeof deliveredAt !== "string")
    throw new Error(`seed-outbox-row.json delivers no ${WORDS_PART_KEY} with its time`);
  return deliveredAt;
}

/**
 * The five v1.1 refused fixtures (README "Refused rows (v1.1)"), each put right as the README and its index entry put
 * it: four are the email row of Sam's sign-in code with one fault each, the fifth the tour's delivered words part.
 */
export const PUT_RIGHT_V1_1: Readonly<Record<string, PutRight>> = {
  "invalid/refuse-outbox-row-with-no-turn-or-job.json": {
    reason: "Sam's code row names neither a turn id nor a job id (CHECK outbox_rows_turn_or_job, 23514)",
    putRight: "its attempt's job id, sign-in-attempt-sam-1",
    at: "values.job_id",
    value: "sign-in-attempt-sam-1",
  },
  "invalid/refuse-email-purpose-on-text-row.json": {
    reason:
      "the code row sent as a text to Sam's mobile (imessage) still names the email purpose code (CHECK outbox_rows_email_purpose_is_email, 23514)",
    putRight: "the same text row naming no purpose",
    at: "values.email_purpose",
    value: null,
  },
  "invalid/refuse-email-purpose-unknown.json": {
    reason:
      "Sam's code email row names signIn, K-09's sendProofCode purpose, which is none of K-12 v1's six (CHECK outbox_rows_email_purpose_known, 23514)",
    putRight: "purpose code",
    at: "values.email_purpose",
    value: "code",
  },
  "invalid/refuse-code-row-without-not-after.json": {
    reason:
      "Sam's code email row (purpose code) holds no not_after (CHECK outbox_rows_code_has_not_after, 23514)",
    putRight: "not_after at its code's expiry, 13:10Z",
    at: "values.not_after",
    value: "2026-10-26T13:10:00Z",
  },
  "invalid/refuse-delivered-part-without-time.json": {
    reason:
      "the tour's delivered words part, updated to version 4, loses its delivery time (CHECK outbox_parts_delivered_has_time, 23514)",
    putRight: "the same update keeping its time",
    at: "set.delivered_at",
    value: wordsPartDeliveredAt(),
  },
};

const PATH = /^(values|set)[.]([a-z_][a-z0-9_]*)$/;

/**
 * A copy of an action with the one value at `at` (values.<column> or set.<column>) set to `value`, nothing else
 * changed.
 */
function withValue<A extends Puttable>(action: A, at: string, value: FixtureValue): A {
  const match = PATH.exec(at);
  if (match === null) throw new Error(`a way to put right names no values.<column> or set.<column>: ${at}`);
  const [, part, column = ""] = match;
  const copy = structuredClone(action);
  const holder = part === "values" ? copy.values : copy.set;
  if (holder === undefined) throw new Error(`the action has no ${part ?? ""} to put right at ${at}`);
  holder[column] = value;
  return copy;
}

/** A copy of a refused action put right: the one value at `fix.at` set to `fix.value`, nothing else changed. */
export function putRight<A extends Puttable>(action: A, fix: PutRight): A {
  return withValue(action, fix.at, fix.value);
}

// ---------------------------------------------------------------------------------------------------------------
// The edges of the CHECKs v1.1 adds (T-1290 round 2, DL-618)

const FIXTURES_DIR = path.join(CONTRACTS_ROOT, "db-schema", "core", "fixtures");

/** The enum of one definition of a contract's schema. */
function enumOf(file: string, definition: string): string[] {
  const schema = JSON.parse(readFileSync(path.join(CONTRACTS_ROOT, ...file.split("/")), "utf8")) as {
    $defs: Record<string, { enum?: unknown }>;
  };
  const values = schema.$defs[definition]?.enum;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string"))
    throw new Error(`${file} lists no ${definition} enum`);
  return values;
}

/**
 * K-12 v1's email purposes (port-email.v1.schema.json, $defs.purpose), which outbox_rows.email_purpose holds as K-12
 * spells them (README line 105, defaults 11 and 12).
 */
export const K12_PURPOSES: readonly string[] = enumOf("port-email/port-email.v1.schema.json", "purpose");

/** K-07 v1's part states (outbox-effects.v1.schema.json, $defs.partState), which outbox_parts.state holds as text. */
export const K07_PART_STATES: readonly string[] = enumOf(
  "outbox-effects/outbox-effects.v1.schema.json",
  "partState",
);

/**
 * Purposes outside K-12's six, beside the twin's signIn: marketing, which no email may carry (RULES 4.4; K-12 README:
 * "there is no purpose a marketing email could carry"), and email_way, K-12's emailWay in v1's snake case, which
 * README default 11 rules out.
 */
export const OUTSIDE_PURPOSES: readonly string[] = ["marketing", "email_way"];

/** What an edge must meet, in a refused action's `expect` form (README "Seed and refused-row fixtures"). */
export type EdgeExpect = { rows: number } | { sqlstate: string; constraintOneOf: string[] };

/** One action of an edge, as the runtime side (README rule 4: rosie_job with no business scope). */
export interface EdgeAction {
  role: "runtime";
  scope: null;
  action: "insert" | "update";
  table: string;
  values?: Record<string, FixtureJson>;
  set?: Record<string, FixtureJson>;
  where?: Record<string, FixtureJson>;
  expect: EdgeExpect;
}

/** A case at the edge of one CHECK v1.1 adds, and what must happen. */
export interface Edge {
  /** The CHECK it pins. */
  constraint: string;
  /** The case, in plain words. */
  case: string;
  /** The fixture loaded first, with its `after` chain. */
  base: string;
  /**
   * The paths of `base`'s refused action that the case changes (none: the twin itself); null when its action is no
   * twin's.
   */
  changed: readonly string[] | null;
  /** Its one action, with what must happen: it passes and writes one row, or 23514 by `constraint`. */
  action: EdgeAction;
}

export const PURPOSE_KNOWN = "outbox_rows_email_purpose_known";
export const CODE_HAS_NOT_AFTER = "outbox_rows_code_has_not_after";
export const DELIVERED_HAS_TIME = "outbox_parts_delivered_has_time";
export const TURN_OR_JOB = "outbox_rows_turn_or_job";

const UNKNOWN_PURPOSE_TWIN = "invalid/refuse-email-purpose-unknown.json";
const CODE_ROW_TWIN = "invalid/refuse-code-row-without-not-after.json";
const DELIVERED_PART_TWIN = "invalid/refuse-delivered-part-without-time.json";
const TOUR_ROW = "out-a7-03-alex";

const PASSES: EdgeExpect = { rows: 1 };
const refusedBy = (constraint: string): EdgeExpect => ({ sqlstate: "23514", constraintOneOf: [constraint] });

interface Fixture {
  rows: { table: string; values: Record<string, FixtureJson> }[];
  refused?: EdgeAction;
}
const fixture = (file: string): Fixture =>
  JSON.parse(readFileSync(path.join(FIXTURES_DIR, ...file.split("/")), "utf8")) as Fixture;

/** A twin's refused action with `changes` made (values.<column> or set.<column>), and what must happen. */
function twinEdge(
  constraint: string,
  kase: string,
  twin: string,
  changes: Readonly<Record<string, FixtureValue>>,
  passes: boolean,
): Edge {
  const refused = fixture(twin).refused;
  if (refused === undefined) throw new Error(`${twin} holds no refused action`);
  let action = refused;
  for (const [at, value] of Object.entries(changes)) action = withValue(action, at, value);
  return {
    constraint,
    case: kase,
    base: twin,
    changed: Object.keys(changes),
    action: { ...action, expect: passes ? PASSES : refusedBy(constraint) },
  };
}

/** The code row twin with its not_after, as round 1 puts it right (PUT_RIGHT_V1_1: its code's expiry, 13:10Z). */
function codeRowWithNotAfterEdge(): Edge {
  const fix = PUT_RIGHT_V1_1[CODE_ROW_TWIN];
  if (fix === undefined) throw new Error(`no way to put right ${CODE_ROW_TWIN}`);
  return twinEdge(
    CODE_HAS_NOT_AFTER,
    `Sam's code row with its not_after, ${String(fix.value)}`,
    CODE_ROW_TWIN,
    { [fix.at]: fix.value },
    true,
  );
}

/**
 * The tour row's update giving it a job id beside its turn id (README default 15: "A row may carry both ids"). The job
 * id is the minute sweep's of seed-event-log.json's write with no turn (evlog-0003), as the model's row with no turn
 * id takes it; the update raises the row's version by one (rule 2).
 */
function bothIdsEdge(): Edge {
  const row = fixture("seed-outbox-row.json").rows.find(
    (each) => each.table === "outbox_rows" && each.values.id === TOUR_ROW,
  );
  const sweep = fixture("seed-event-log.json").rows.find((each) => each.values.id === "evlog-0003");
  const [turnId, version, jobId] = [row?.values.turn_id, row?.values.version, sweep?.values.job_id];
  if (typeof turnId !== "string" || typeof version !== "number" || typeof jobId !== "string")
    throw new Error(
      `seed-outbox-row.json's ${TOUR_ROW} with its turn and version, or evlog-0003's job id, is missing`,
    );
  return {
    constraint: TURN_OR_JOB,
    case: `the tour's row, keeping its turn id ${turnId}, given the job id ${jobId} as well`,
    base: "seed-outbox-row.json",
    changed: null,
    action: {
      role: "runtime",
      scope: null,
      action: "update",
      table: "outbox_rows",
      set: { job_id: jobId, version: version + 1 },
      where: { id: TOUR_ROW, version },
      expect: PASSES,
    },
  };
}

/**
 * The edges of the CHECKs v1.1 adds, as the lead's round-2 note lists them (DL-618):
 *   - outbox_rows_email_purpose_known (README line 105, default 12): Sam's code email row (its not_after held) naming
 *     each of K-12 v1's six purposes passes, naming none passes, and naming one outside them is refused;
 *   - outbox_rows_code_has_not_after (README line 106): the code row with no not_after passes naming no purpose or any
 *     purpose but code, passes as a code row with its not_after (13:10Z), and is refused as a code row without one;
 *   - outbox_parts_delivered_has_time (README line 108): the tour's words part with no delivery time passes in every
 *     K-07 part state but delivered;
 *   - outbox_rows_turn_or_job (README default 15): a row carrying both a turn id and a job id passes.
 */
export const EDGES_V1_1: readonly Edge[] = [
  ...K12_PURPOSES.map((purpose) =>
    twinEdge(
      PURPOSE_KNOWN,
      `Sam's code email row naming purpose ${purpose}`,
      UNKNOWN_PURPOSE_TWIN,
      { "values.email_purpose": purpose },
      true,
    ),
  ),
  twinEdge(
    PURPOSE_KNOWN,
    "Sam's code email row naming no purpose",
    UNKNOWN_PURPOSE_TWIN,
    { "values.email_purpose": null },
    true,
  ),
  ...OUTSIDE_PURPOSES.map((purpose) =>
    twinEdge(
      PURPOSE_KNOWN,
      `Sam's code email row naming purpose ${purpose}, none of K-12's six`,
      UNKNOWN_PURPOSE_TWIN,
      { "values.email_purpose": purpose },
      false,
    ),
  ),
  twinEdge(
    CODE_HAS_NOT_AFTER,
    "Sam's email row with no not_after, naming no purpose",
    CODE_ROW_TWIN,
    { "values.email_purpose": null },
    true,
  ),
  ...K12_PURPOSES.filter((purpose) => purpose !== "code").map((purpose) =>
    twinEdge(
      CODE_HAS_NOT_AFTER,
      `Sam's email row with no not_after, naming purpose ${purpose}`,
      CODE_ROW_TWIN,
      { "values.email_purpose": purpose },
      true,
    ),
  ),
  codeRowWithNotAfterEdge(),
  twinEdge(CODE_HAS_NOT_AFTER, "Sam's code row with no not_after (the twin)", CODE_ROW_TWIN, {}, false),
  ...K07_PART_STATES.filter((state) => state !== "delivered").map((state) =>
    twinEdge(
      DELIVERED_HAS_TIME,
      `the tour's words part in state ${state} with no delivery time`,
      DELIVERED_PART_TWIN,
      { "set.state": state },
      true,
    ),
  ),
  bothIdsEdge(),
];
