// K-04 v1.1's refused fixtures, each put right (T-1290; contracts/db-schema/core/README.md section "v1.1", its table
// "Refused rows (v1.1)", and the "shows" of each v1.1 entry of fixtures/index.json): each twin's one fault, what refuses
// it, and the one value that puts it right. The model (db-schema.core.v1.test.ts) and PostgreSQL with every migration
// applied (db-schema.core.v1.db-side.test.ts) both take the ways to put each twin right from here, so the same action
// passes in both. Not a test file: the two tests import it.

import { readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACTS_ROOT } from "./_harness";

/** A value a fixture holds: what one column of a refused action takes. */
export type FixtureValue = string | number | boolean | null;

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

/** A copy of a refused action put right: the one value at `fix.at` set to `fix.value`, nothing else changed. */
export function putRight<A extends Puttable>(action: A, fix: PutRight): A {
  const match = PATH.exec(fix.at);
  if (match === null)
    throw new Error(`a way to put right names no values.<column> or set.<column>: ${fix.at}`);
  const [, part, column = ""] = match;
  const copy = structuredClone(action);
  const holder = part === "values" ? copy.values : copy.set;
  if (holder === undefined) throw new Error(`the action has no ${part ?? ""} to put right at ${fix.at}`);
  holder[column] = fix.value;
  return copy;
}
