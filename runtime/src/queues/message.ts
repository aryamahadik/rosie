// The retry message's rules (T-256; C-056): its numbers, how a message is read and checked, when a next try goes, and the
// error label a try leaves (its name and a label only: STATE note 3, never a message's words, a number, a name or
// PostgresError.detail).

import { isLabel } from "../trace";
import { SEND_KIND, type FailedTry, type JobBody, type RetryJob, type RetryMessage } from "./types";

/** A job's tries in all, the first one included; the fifth failed, the job is a dead-letter row (arch 10 line 540). */
export const JOB_TRIES = 5;
/**
 * Without a Retry-After, a job's next try goes this long after the last: no source gives it, so it keeps the effects'
 * rhythm (QUESTIONS.md M2-action-adapters.4: every 2 minutes, at 0, 2, 4, 6 and 8 minutes).
 */
export const JOB_SPACING_S = 120;
/** Without a Retry-After, a send's next try goes this long after the last: K-07 rule 3's 10 s, the one spacing given. */
export const SEND_SPACING_S = 10;
/**
 * The most tries the queue carries for one send retry. Step 8 ends a send after 15 minutes of tries (the dispatcher's
 * `done`); this guard only stops a chain the dispatcher never ends: 15 minutes at 10 s apart is 90 tries. Never a dead
 * letter: sends never land there (K-37 dead_letters).
 */
export const SEND_TRIES_GUARD = 120;
/** The longest delay Cloudflare Queues takes, in seconds (12 hours); a longer Retry-After is held to it. */
export const MAX_DELAY_S = 43_200;
/** A try begun this long ago and never ended counts as a run that died: a queue consumer runs 15 minutes at most. */
export const RUN_LAPSE_MS = 15 * 60_000;
/** A message whose next step could not be handed on (queue, ledger or store down) comes back after this long. */
export const HAND_OFF_DELAY_S = 60;
/** The largest job body the producer takes, as JSON (a Cloudflare Queues message holds 128 KB at most). */
export const MAX_BODY_BYTES = 64_000;
/** A label in an error label is at most this long. */
const LABEL_MAX = 64;

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;
/** An error's name: a word in PascalCase (TypeError, PostgresError, AbortError), never free text. */
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/u;
/** A PostgreSQL SQLSTATE: five digits or capitals. */
const SQLSTATE = /^[0-9A-Z]{5}$/u;
/** A PostgreSQL constraint name as the schema spells it. */
const CONSTRAINT = /^[a-z_][a-z0-9_]{0,62}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A label short enough for an error label or a job's kind. */
export const isShortLabel = (value: unknown): value is string => isLabel(value) && value.length <= LABEL_MAX;

/** An instant in UTC as the message holds it (RFC 3339, ending in Z). */
export const isUtc = (value: unknown): value is string =>
  typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));

/** The instant `ms` as the message holds it. */
export const utcOf = (ms: number): string => new Date(ms).toISOString();

/** An error label: `<Name>:<label>`, a PascalCase name and a label (letters, digits and _ . : / # - only). */
export function isErrorLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  if (colon <= 0) return false;
  return ERROR_NAME.test(value.slice(0, colon)) && isShortLabel(value.slice(colon + 1));
}

/**
 * The errors that carry a refused PostgreSQL write, by name, with the field each keeps its constraint's name in (each
 * keeps the SQLSTATE in `code`): postgres.js's PostgresError, and the two db/repo throws in its place, scrubbed of
 * every value (T-1322): clocks.ts's DataAccessDatabaseError and commit-turn.ts's CommitTurnDatabaseError. Read by name
 * and field alone: the runtime is handed db/repo's calls and imports none of its code.
 */
const REFUSAL_CONSTRAINT_FIELD: ReadonlyMap<string, string> = new Map([
  ["PostgresError", "constraint_name"],
  ["DataAccessDatabaseError", "constraint"],
  ["CommitTurnDatabaseError", "constraint"],
]);

/**
 * The label a thrown value leaves: the error's name, then `threw`; for a refused PostgreSQL write, its SQLSTATE and
 * constraint (STATE note 3), `<Name>:<SQLSTATE>[:<constraint>]`, whether postgres.js's PostgresError carries it or
 * db/repo's DataAccessDatabaseError or CommitTurnDatabaseError carries it scrubbed (T-1340). A code that is no SQLSTATE
 * gives `<Name>:threw`, as any other error does, and a constraint that is no constraint's name is left out. So is one
 * the label has no room for (T-1347): where `<SQLSTATE>:<constraint>` would be longer than LABEL_MAX (a name of 59
 * to 63 characters), which isErrorLabel refuses, the label is `<Name>:<SQLSTATE>`, so the next retry message still
 * runs. Each field is read once, so the label is built from the very values checked. Never the error's message,
 * detail, call, table or any other field.
 */
export function errorLabelOf(thrown: unknown): string {
  if (!isRecord(thrown)) return "Thrown:threw";
  const thrownName = thrown.name;
  const name = typeof thrownName === "string" && ERROR_NAME.test(thrownName) ? thrownName : "Error";
  const constraintField = REFUSAL_CONSTRAINT_FIELD.get(name);
  if (constraintField === undefined) return `${name}:threw`;
  const code = thrown.code;
  if (typeof code !== "string" || !SQLSTATE.test(code)) return `${name}:threw`;
  const constraint = thrown[constraintField];
  if (typeof constraint !== "string" || !CONSTRAINT.test(constraint)) return `${name}:${code}`;
  const withConstraint = `${code}:${constraint}`;
  return isShortLabel(withConstraint) ? `${name}:${withConstraint}` : `${name}:${code}`;
}

/** The label a failure answered with a code leaves: `<name>:<code>`, or `<name>:badCode` when the code is no label. */
export function codeLabelOf(name: "JobFailed" | "SendFailed", code: unknown): string {
  return `${name}:${isShortLabel(code) ? code : "badCode"}`;
}

/** A provider's Retry-After as the queue honours it: whole seconds from 0, or null when there is none. */
export function retryAfterOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** How long after a failed try the next one waits, in milliseconds: any Retry-After (to 12 hours), else the spacing. */
export function waitMsOf(kind: string, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null)
    return Math.min(MAX_DELAY_S, Math.max(1, Math.ceil(retryAfterSeconds))) * 1000;
  return (kind === SEND_KIND ? SEND_SPACING_S : JOB_SPACING_S) * 1000;
}

/**
 * The whole seconds from `now` until `notBefore`, as a queue delay: 0 when it has passed, at most 12 hours. A time that
 * cannot be read gives 0: the message goes now, and the consumer, which checks notBefore itself, holds it if early.
 */
export function secondsUntil(notBefore: string, now: number): number {
  const ms = Date.parse(notBefore) - now;
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_DELAY_S, Math.max(0, Math.ceil(ms / 1000)));
}

/** True when the value is a JSON object that survives a round trip unchanged (no undefined, function or NaN inside). */
function isJsonBody(value: unknown): value is JobBody {
  if (!isRecord(value)) return false;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  return (
    new TextEncoder().encode(text).length <= MAX_BODY_BYTES && isJsonEqual(value, JSON.parse(text) as unknown)
  );
}

function isJsonEqual(a: unknown, b: unknown): boolean {
  if (a === null || typeof a !== "object") return a === b && (typeof a !== "number" || Number.isFinite(a));
  if (b === null || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, index) => isJsonEqual(item, b[index]));
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => isJsonEqual(left[key], right[key]));
}

/**
 * True when every name and every string in a JSON value is a label (K-37 rule 4: "jobs carry ids, not values"), so no
 * phone number, address or sentence can ride the queue or reach a dead letter. Numbers, yes or no and null pass.
 */
function holdsIdsOnly(value: unknown): boolean {
  if (typeof value === "string") return isLabel(value);
  if (Array.isArray(value)) return value.every(holdsIdsOnly);
  if (isRecord(value))
    return Object.entries(value).every(([key, item]) => isLabel(key) && holdsIdsOnly(item));
  return true;
}

/** Why a job cannot ride the queue (a label), or null when it can. */
export function jobProblem(job: unknown): string | null {
  if (!isRecord(job)) return "jobNotObject";
  if (!isLabel(job.key)) return "keyNotLabel";
  if (!isShortLabel(job.kind)) return "kindNotLabel";
  if (job.businessId !== null && !isLabel(job.businessId)) return "businessNotLabel";
  if (!isLabel(job.traceId)) return "traceNotLabel";
  if (!isJsonBody(job.body)) return "bodyNotJson";
  if (!holdsIdsOnly(job.body)) return "bodyNotIds";
  return null;
}

/** The most a message of this kind may carry: a job's fifth try, or the send guard. */
export const lastTryOf = (kind: string): number => (kind === SEND_KIND ? SEND_TRIES_GUARD : JOB_TRIES);

/** Why a delivered body is not a retry message (a label), or the message. */
export function readRetryMessage(body: unknown): { message: RetryMessage } | { problem: string } {
  if (!isRecord(body)) return { problem: "notObject" };
  if (body.v !== 1) return { problem: "unknownVersion" };
  const problem = jobProblem(body.job);
  if (problem !== null) return { problem };
  const job = body.job as RetryJob;
  const tryNo = body.try;
  if (typeof tryNo !== "number" || !Number.isInteger(tryNo) || tryNo < 2 || tryNo > lastTryOf(job.kind)) {
    return { problem: "tryOutOfRange" };
  }
  if (!isUtc(body.firstTriedAt) || !isUtc(body.notBefore)) return { problem: "timeNotUtc" };
  if (!isErrorLabel(body.lastError)) return { problem: "lastErrorNotLabel" };
  return {
    message: {
      v: 1,
      job: {
        key: job.key,
        kind: job.kind,
        businessId: job.businessId,
        traceId: job.traceId,
        body: job.body,
      },
      try: tryNo,
      firstTriedAt: body.firstTriedAt,
      notBefore: body.notBefore,
      lastError: body.lastError,
    },
  };
}

/** The message that carries the try after `failed`, which was try `failedTry` of the job. */
export function nextMessageOf(
  job: RetryJob,
  failedTry: number,
  firstTriedAt: string,
  failed: FailedTry,
): RetryMessage {
  return {
    v: 1,
    job: {
      key: job.key,
      kind: job.kind,
      businessId: job.businessId,
      traceId: job.traceId,
      body: job.body,
    },
    try: failedTry + 1,
    firstTriedAt,
    notBefore: utcOf(failed.at + waitMsOf(job.kind, retryAfterOf(failed.retryAfterSeconds))),
    lastError: failed.error,
  };
}
