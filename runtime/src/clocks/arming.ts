// Clock arming at the first delivery receipt (T-255; C-055; arch 02 step 9 'Wait', line 127; K-05 v1 item 5).
//
// The receipt path calls it: a delivery receipt (K-06 delivered.json) goes from the gateway to the dispatcher's receipt
// handler (runtime/src/dispatch `handleDeliveryReceipt`), which marks the part delivered through K-05 markPart and hands
// each part it newly marked to clock arming (`ClockArming.partDelivered`). It hands a receipt that repeats the row's
// first delivery on again, as that first delivery at its stored time (K-05 v1.9 item 48; T-1228), so one part can be
// handed on more than once: step 1 keeps its clock armed once. `clockArming(options)` is that ClockArming; D-017 joins
// it. For the row's first delivery (markPart's `firstDelivery`) of a row that asks a question:
//
//   1. This isolate's memory, keyed by the message part (<row>/<part>/<try>): a second receipt for a part already armed
//      makes no call, and two receipts for one part at once share one arming. Across isolates, K-05 armClock's own repeat
//      answer: a later receipt never moves the row, and a repeat returns the first arming. An arming that ended failed is
//      not remembered, so the receipt sent again arms anew.
//   2. The question's facts (a port: the Clock line as it applies, the visit's start and flow, the business's zone, a
//      flow B visit address and its zone, its never-delivered row).
//   3. The zone (./due.ts `zoneFor`): flow A the business's; flow B the visit address's, as stored with the visit or else
//      from the geo port (K-17 geocode; CQ-08), else the business's (CQ-05); neither, UTC.
//   4. The due time by step 9's rule (./due.ts `dueOf`).
//   5. K-05 armClock, named by the question (arm-clock.json), which arms the row and opens the question in one
//      transaction. `repeated`: armed before, nothing more is done. `clockClosed`: answered or withdrawn first.
//   6. On a new arming: the question's never-delivered row is cancelled (K-05 cancelClock, compared on the version read),
//      since a delivered question no longer takes the never-delivered path; then the handle's actor is told
//      (`syncClocks`, ./actors.ts), which fires what is due and keeps its one alarm at its earliest row (T-254). An actor
//      it cannot reach is no failure of the arming: the minute sweep fires the row once it is missed.
//   7. One clockArmed span on the receipt's own trace (one trace id from the webhook to the receipt; K-08), or one JSON
//      log line when it has none: labels and counts only.
//
// A question never delivered gets no receipt, so this never runs for it and its clock row stays waiting: no clock runs
// (RULES 4.1b; K-07 dropped_stopped and waiting_chat). It takes the never-delivered path at the time
// `neverDeliveredDueOf` gives, the visit or 8pm the day after the send, through its never-delivered row (K-04 kind
// never_delivered), which the commit that opens the question makes armed at that time (K-05 clockNew with `due`; armClock
// cannot arm it, since armClock also opens the question). No commit writes that row yet: the action layer's join.
//
// `armAtDelivery` never throws: its report says how the arming ended. `clockArming`'s partDelivered rejects
// (`ArmingNotDone`) when the arming ended failed: a call that answered transient, or not at all, to its last try, an
// answer it cannot read, or a read the arming needs that threw (T-1244). The receipt is then not done: the dispatcher's
// receipt handler rejects, the gateway answers the provider 503, and the provider sends the receipt again (Linq retries
// for 30 minutes: arch 02 line 109), a repeat of the row's first delivery that comes back here and arms the clock once.
// Every other end resolves, since the receipt sent again could not change it: armed (also when the never-delivered row's
// cancel or the actor's sync then failed: a repeat would find the clock armed and do neither, and the minute sweep fires
// a row its actor missed), repeated, closed, not found, refused, or no clock to arm (not the row's first delivery, or no
// question).
//
// Never logged, put in a span or returned: the due time, the zone, the Clock line's words, an address.

import { isLabel, type LogContext, type Outcome, type SpanFacts, type TraceContext } from "../trace";
import type { RowRef } from "../trace/types";
import { actorOf } from "./actors";
import { dueOf, zoneFor, type Due } from "./due";
import type {
  ArmedClock,
  ArmingData,
  ArmOutcome,
  ArmReport,
  ClockActors,
  ClockDirectory,
  GeoPort,
  QuestionFacts,
  QuestionFactsReader,
} from "./types";
import { isZone } from "./zone";

/** How many times a call that answers transient (or not at all) is made before the arming gives up: K-05's calls are safe to repeat. */
export const ARMING_TRIES = 3;
/** How many armed parts one isolate remembers; the oldest is forgotten first, and K-05's repeat answer still holds. */
export const PART_MEMORY = 1024;

/**
 * One part as the dispatcher's receipt handler hands it on (runtime/src/dispatch `PartDelivered`, from K-05 markPart's
 * answer and the receipt's time): newly marked delivered, or a repeat of the row's first delivery (T-1228).
 */
export interface DeliveredPart {
  outboxRowId: string;
  partNo: 1 | 2;
  tryNo: number;
  /**
   * K-05 markPart: true on the row's first delivery receipt, when the question's clock arms (arch 02 line 127), and on a
   * repeat of it that the dispatcher hands on (K-05 v1.9 item 48).
   */
  firstDelivery: boolean;
  openQuestionId: string | null;
  /** When the receipt says it was delivered (K-06 `status.at`), UTC; for a repeat, the first delivery's stored time. */
  deliveredAt: string;
}

/**
 * The receipt path's door to clock arming: the same shape as the dispatcher's ClockArming. Its partDelivered rejects
 * when the arming is not done (the file's header).
 */
export interface ClockArmingPort {
  partDelivered(delivered: DeliveredPart): Promise<void>;
}

/**
 * The arming of a part handed on ended failed (T-1244): the receipt is not done, so the receipt path's port rejects with
 * this and the provider is answered 503. Its message is fixed, with no id, time or code in it (the clockArmed span holds
 * the code), and the gateway logs its name alone.
 */
export class ArmingNotDone extends Error {
  constructor() {
    super("the clock arming of a delivered part ended failed");
    this.name = "ArmingNotDone";
  }
}

interface Remembered {
  openQuestionId: string;
  clockRowId: string | null;
}

/** One isolate's memory of the parts it armed, and of the armings in flight, by message part. */
export class ArmingMemory {
  private readonly done = new Map<string, Remembered>();
  private readonly running = new Map<string, Promise<ArmReport>>();

  constructor(private readonly limit: number = PART_MEMORY) {}

  /** What an earlier arming of this part left, or null when this isolate armed nothing for it. */
  known(part: string): Remembered | null {
    return this.done.get(part) ?? null;
  }

  remember(part: string, remembered: Remembered): void {
    this.done.delete(part);
    this.done.set(part, remembered);
    while (this.done.size > this.limit) {
      const oldest = this.done.keys().next().value;
      if (oldest === undefined) break;
      this.done.delete(oldest);
    }
  }

  /** Runs one arming per part at a time: a second call for a part while one runs is handed the first one's result. */
  run(part: string, arm: () => Promise<ArmReport>): Promise<ArmReport> {
    const known = this.running.get(part);
    if (known !== undefined) return known;
    const started = arm().finally(() => {
      this.running.delete(part);
    });
    this.running.set(part, started);
    return started;
  }
}

/** This isolate's memory (a Worker isolate serves many receipts in turn). */
export const isolateArmings = new ArmingMemory();

export interface ArmingOptions {
  /** K-05 v1 armClock and cancelClock (T-197 builds them; D-017 joins them). */
  data: ArmingData;
  /** The question's facts the due rule reads. */
  facts: QuestionFactsReader;
  /** K-17 v1 geocode, for a flow B address whose zone is not stored; null: none joined, so the business's zone stands. */
  geo: GeoPort | null;
  /** Where a handle's actor lives (the clocks' directory port, T-254). */
  directory: ClockDirectory;
  /** The HandleActor namespace, or null where none is bound (env.staging until T-566). */
  actors: ClockActors | null;
  /** The environment and build every log line carries (ADR-009). */
  log: LogContext;
  /** The receipt's own trace (the dispatcher's receipt handler's), which the clockArmed span goes on. */
  trace?: TraceContext;
  /** The memory of armed parts: this isolate's when left out. */
  memory?: ArmingMemory;
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUtc = (value: unknown): value is string =>
  typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));

const isCount = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum;

const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

/** True when a part can be armed and logged: its ids are labels, its numbers counts, its time an instant in UTC. */
function isDeliveredPart(value: unknown): value is DeliveredPart {
  if (!isRecord(value)) return false;
  return (
    isLabel(value.outboxRowId) &&
    (value.partNo === 1 || value.partNo === 2) &&
    isCount(value.tryNo, 1) &&
    typeof value.firstDelivery === "boolean" &&
    (value.openQuestionId === null || isLabel(value.openQuestionId)) &&
    isUtc(value.deliveredAt)
  );
}

/** The part's key in the memory: K-07's part key, <row>/<part>/<try>. */
const partKeyOf = (part: DeliveredPart): string =>
  `${part.outboxRowId}/${String(part.partNo)}/${String(part.tryNo)}`;

/** An instant as K-05 writes it: UTC to the whole second (the receipt's own second). */
const wholeSecondOf = (utc: string): string =>
  new Date(Math.floor(Date.parse(utc) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");

/** The question's facts, checked; null when the answer is not facts the due rule can read. */
function factsOf(value: unknown, openQuestionId: string): QuestionFacts | null {
  if (!isRecord(value) || value.openQuestionId !== openQuestionId) return null;
  if (!isTextOrNull(value.clockLine) || !isTextOrNull(value.businessZone)) return null;
  const visit = value.visit;
  if (visit !== null) {
    if (!isRecord(visit) || !isUtc(visit.startsAt) || (visit.flow !== "A" && visit.flow !== "B")) return null;
    if (!isTextOrNull(visit.addressZone) || !isTextOrNull(visit.address)) return null;
  }
  const never = value.neverDelivered;
  if (never !== null && !(isRecord(never) && isLabel(never.clockRowId) && isCount(never.version, 1))) {
    return null;
  }
  return value as unknown as QuestionFacts;
}

/** K-05's armed answer for this question, checked; null when the answer is not one. */
function armedOf(value: unknown): { repeated: boolean; clock: ArmedClock } | null {
  if (!isRecord(value) || value.result !== "armed" || typeof value.repeated !== "boolean") return null;
  const clock = value.clock;
  if (!isRecord(clock) || !isLabel(clock.clockRowId) || !isCount(clock.version, 1)) return null;
  if (clock.handleId !== null && !isLabel(clock.handleId)) return null;
  return { repeated: value.repeated, clock: clock as unknown as ArmedClock };
}

/** The error code an answer carries, when it is a label; else badAnswer. */
const codeOf = (answer: unknown): string =>
  isRecord(answer) && isLabel(answer.error) ? answer.error : "badAnswer";

const isRetryable = (answer: unknown): boolean =>
  isRecord(answer) && (answer.error === "transient" || answer.error === "noAnswer");

/** A call made up to ARMING_TRIES times while it answers transient or throws (each K-05 call here is safe to repeat). */
async function withTries(call: () => Promise<unknown>): Promise<unknown> {
  let answer: unknown = { error: "noAnswer" };
  for (let tries = 0; tries < ARMING_TRIES; tries += 1) {
    try {
      answer = await call();
    } catch {
      answer = { error: "noAnswer" };
    }
    if (!isRetryable(answer)) return answer;
  }
  return answer;
}

/** A flow B visit address's zone from the geo port: the first match's zone, or null (none joined, not found, an error). */
async function geocodedZone(geo: GeoPort | null, address: string): Promise<string | null> {
  if (geo === null || address.trim() === "") return null;
  try {
    const answer: unknown = await geo.geocode({ kind: "streetAddress", text: address });
    if (!isRecord(answer) || answer.result !== "found" || !Array.isArray(answer.matches)) return null;
    const first: unknown = answer.matches[0];
    return isRecord(first) && isZone(first.timeZone) ? first.timeZone : null;
  } catch {
    return null;
  }
}

/** The zone the deadline is set in (CQ-05, CQ-08; S13-03), and where it came from. */
async function zoneOf(facts: QuestionFacts, geo: GeoPort | null): Promise<ReturnType<typeof zoneFor>> {
  const visit = facts.visit;
  let visitAddressZone: string | null = null;
  if (visit !== null && visit.flow === "B") {
    visitAddressZone = isZone(visit.addressZone)
      ? visit.addressZone
      : visit.address === null
        ? null
        : await geocodedZone(geo, visit.address);
  }
  return zoneFor({ flow: visit?.flow ?? null, businessZone: facts.businessZone, visitAddressZone });
}

/** Cancels the question's never-delivered row once it is delivered: how that ended, in a label. */
async function cancelNeverDelivered(
  options: ArmingOptions,
  row: QuestionFacts["neverDelivered"],
  at: string,
): Promise<NonNullable<ArmReport["neverDelivered"]>> {
  if (row === null) return "none";
  const answer = await withTries(() =>
    options.data.cancelClock({
      clockRowId: row.clockRowId,
      expectVersion: row.version,
      withdrawQuestion: null,
      at,
    }),
  );
  if (isRecord(answer) && answer.result === "cancelled") return "cancelled";
  if (isRecord(answer) && answer.error === "alreadyFired") return "alreadyFired";
  return "failed";
}

/** Tells the handle's actor of its newly armed row: null when it was told, else why not (a label). */
async function syncActor(options: ArmingOptions, handleId: string | null): Promise<string | null> {
  // A row no handle owns is the minute sweep's: no actor keeps an alarm for it.
  if (handleId === null) return "sweepRow";
  const actor = await actorOf({ directory: options.directory }, options.actors, handleId);
  if (actor === null) return "noActor";
  try {
    await actor.syncClocks(handleId);
    return null;
  } catch {
    return "syncFailed";
  }
}

const SPAN_OUTCOME: Readonly<Record<ArmOutcome, Outcome>> = {
  armed: "ok",
  repeated: "ok",
  notFirst: "dropped",
  noQuestion: "dropped",
  closed: "dropped",
  notFound: "dropped",
  refused: "refused",
  failed: "failed",
};

function reportOf(outcome: ArmOutcome, rest: Partial<ArmReport> = {}): ArmReport {
  return {
    outcome,
    openQuestionId: null,
    clockRowId: null,
    branch: null,
    zoneFrom: null,
    clockLineUnread: false,
    neverDelivered: null,
    synced: false,
    errorCode: null,
    ...rest,
  };
}

/** The arming of one question's clock row, once its part is known to be a first delivery of a question (steps 2 to 6). */
async function armQuestion(
  part: DeliveredPart,
  openQuestionId: string,
  options: ArmingOptions,
  memory: ArmingMemory,
  key: string,
): Promise<ArmReport> {
  const asked = { openQuestionId };
  const factsAnswer = await withTries(() => options.facts.questionFacts(openQuestionId));
  if (isRecord(factsAnswer) && factsAnswer.error === "notFound") {
    memory.remember(key, { openQuestionId, clockRowId: null });
    return reportOf("notFound", { ...asked, errorCode: "questionNotFound" });
  }
  const facts = factsOf(factsAnswer, openQuestionId);
  if (facts === null) {
    const code = isRecord(factsAnswer) && "error" in factsAnswer ? codeOf(factsAnswer) : "badFacts";
    return reportOf("failed", { ...asked, errorCode: code });
  }

  const { zone, from } = await zoneOf(facts, options.geo);
  // K-04 armed_at is the receipt's second; the due rule counts from the receipt's own time ("at least" 1 hour).
  const deliveredAt = wholeSecondOf(part.deliveredAt);
  let due: Due;
  try {
    due = dueOf({
      deliveredAt: part.deliveredAt,
      clockLine: facts.clockLine,
      visitStartsAt: facts.visit?.startsAt ?? null,
      zone,
    });
  } catch {
    return reportOf("refused", { ...asked, zoneFrom: from, errorCode: "badDue" });
  }
  const ruled = {
    ...asked,
    branch: due.branch,
    zoneFrom: from,
    clockLineUnread: due.clockLineUnread,
  };

  const answer = await withTries(() =>
    options.data.armClock({ openQuestionId, deliveredAt, dueAt: due.dueAt, dueZone: due.dueZone }),
  );
  const armed = armedOf(answer);
  if (armed !== null) {
    const clockRowId = armed.clock.clockRowId;
    memory.remember(key, { openQuestionId, clockRowId });
    if (armed.repeated) return reportOf("repeated", { ...ruled, clockRowId });
    const neverDelivered = await cancelNeverDelivered(options, facts.neverDelivered, deliveredAt);
    const notSynced = await syncActor(options, armed.clock.handleId);
    return reportOf("armed", {
      ...ruled,
      clockRowId,
      neverDelivered,
      synced: notSynced === null,
      errorCode: notSynced,
    });
  }
  if (isRecord(answer) && answer.error === "clockClosed") {
    const clockRowId = isLabel(answer.clockRowId) ? answer.clockRowId : null;
    memory.remember(key, { openQuestionId, clockRowId });
    return reportOf("closed", { ...ruled, clockRowId, errorCode: "clockClosed" });
  }
  if (isRecord(answer) && answer.error === "notFound") {
    memory.remember(key, { openQuestionId, clockRowId: null });
    return reportOf("notFound", { ...ruled, errorCode: "clockNotFound" });
  }
  return reportOf("failed", { ...ruled, errorCode: codeOf(answer) });
}

/** Steps 1 to 6 (the file's header), before the span. */
async function armOnce(part: unknown, options: ArmingOptions): Promise<ArmReport> {
  if (!isDeliveredPart(part)) return reportOf("refused", { errorCode: "badPart" });
  if (!part.firstDelivery) return reportOf("notFirst", { openQuestionId: part.openQuestionId });
  const openQuestionId = part.openQuestionId;
  if (openQuestionId === null) return reportOf("noQuestion");
  const memory = options.memory ?? isolateArmings;
  const key = partKeyOf(part);
  const known = memory.known(key);
  if (known !== null) {
    return reportOf("repeated", { openQuestionId: known.openQuestionId, clockRowId: known.clockRowId });
  }
  return memory.run(key, () => armQuestion(part, openQuestionId, options, memory, key));
}

/** What the span and the log line say: labels, yes or no, counts. */
function decidedOf(report: ArmReport): SpanFacts {
  return {
    result: report.outcome,
    branch: report.branch,
    zoneFrom: report.zoneFrom,
    clockLineUnread: report.clockLineUnread,
    neverDelivered: report.neverDelivered,
    synced: report.synced,
  };
}

/** One JSON log line for an arming with no trace to put its span on (ADR-009), with its own trace id. */
function logLine(options: ArmingOptions, report: ArmReport): void {
  try {
    console.log(
      JSON.stringify({
        level: report.outcome === "failed" ? "warn" : "info",
        msg: "clockArming",
        trace_id: crypto.randomUUID(),
        outcome: report.outcome,
        branch: report.branch,
        zone_from: report.zoneFrom,
        clock_line_unread: report.clockLineUnread,
        never_delivered: report.neverDelivered,
        synced: report.synced,
        clock_row_id: report.clockRowId,
        error_code: report.errorCode,
        environment: options.log.environment,
        version: options.log.version,
      }),
    );
  } catch {
    // No line; the report says it.
  }
}

/**
 * Arms the question's clock row for one part handed on (the file's header) and says how it ended. Never throws: a failed
 * end is in the report, and `clockArming` rejects for it.
 */
export async function armAtDelivery(part: DeliveredPart, options: ArmingOptions): Promise<ArmReport> {
  const timer = options.trace?.start("clockArmed");
  const report = await armOnce(part, options).catch(() => reportOf("failed", { errorCode: "noAnswer" }));
  const valid = isDeliveredPart(part);
  const rows: RowRef[] =
    report.outcome === "armed" && report.clockRowId !== null
      ? [{ table: "clock_rows", id: report.clockRowId }]
      : [];
  if (timer === undefined) {
    logLine(options, report);
    return report;
  }
  try {
    timer.finish({
      outcome: SPAN_OUTCOME[report.outcome],
      got: valid ? { firstDelivery: part.firstDelivery, partNo: part.partNo, tryNo: part.tryNo } : {},
      decided: decidedOf(report),
      ...(rows.length > 0 ? { rows } : {}),
      errorCode: report.errorCode,
    });
  } catch {
    // A span the contract refuses is not kept: the plain line says it instead.
    logLine(options, report);
  }
  return report;
}

/**
 * The receipt path's ClockArming (runtime/src/dispatch ReceiptDeps.clockArming), joined at D-017: resolves once the
 * arming ended any way but failed, and rejects with ArmingNotDone when it ended failed, so the receipt is answered 503
 * and the provider's retry arms the clock (T-1244; the file's header).
 */
export function clockArming(options: ArmingOptions): ClockArmingPort {
  return {
    async partDelivered(delivered) {
      const report = await armAtDelivery(delivered, options);
      if (report.outcome === "failed") throw new ArmingNotDone();
    },
  };
}
