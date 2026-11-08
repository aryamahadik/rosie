// Doubles for the effects runner's tests (T-323), never imported by the runner itself:
//   - FakeClock: the time, moved only by the test or by `drive`, so a run's 10 minutes take no real time;
//   - FakeEffectRepo: K-05 v1.1's claimEffects and recordEffectResult with their semantics (items 20 and 21) over rows
//     in memory: a claim takes pending rows and running rows whose claim lapsed, oldest first, skipping rows another
//     open claim holds (SKIP LOCKED) and handing each row to one claimer by compare and set; a result checks the state,
//     the claim and the version, counts the try and moves the row to outage on the run's 5th; every request and answer is
//     held to K-05 v1.1's schema, and each row keeps its K-07 v1 life (its moves);
//   - FakeKindPort: a kind's port that records each call and answers from a script, and counts calls that overlap;
//   - the contract checks: K-05 v1.1, K-07 v1 (effectLife and its named rule lifeChain) and K-08 v1 (span), one strict
//     Ajv 2020-12 setup (contracts/README.md convention 8);
//   - effect rows from K-05's and K-07's own fixtures (the master's sample cast and the demo barber shop: rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { openTrace, type BundleId, type Span } from "../../../../runtime/src/trace";
import { CONTRACTS_DIR, formatProblems, loadToolApiSchemas } from "../../tool-api/validator";
import type { EffectKind, EffectRow, KindAnswer, KindCall, KindPort } from "../kinds";
import { epochOf, utc } from "./clock";
import { CLAIM_MS, EFFECT_TRIES } from "./schedule";
import type {
  ClaimEffectsError,
  ClaimEffectsRequest,
  ClaimEffectsResponse,
  ClaimedEffect,
  EffectRepo,
  EffectResultRequest,
  EffectSpans,
  EventEntry,
  RecordEffectResultError,
  RecordEffectResultResponse,
  RunnerClock,
} from "./types";

// ---- contracts on disk ---------------------------------------------------------------------------------------------

export function readContractJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as unknown;
}

const ID_BASE = "https://rosie.invalid/contracts/";
const K05_V1_1 = `${ID_BASE}data-access/data-access.v1.1.schema.json`;
const K07_V1 = `${ID_BASE}outbox-effects/outbox-effects.v1.schema.json`;
const K08_V1 = `${ID_BASE}event-trace/event-trace.v1.schema.json`;

export interface ContractChecks {
  /** Problems K-05 v1.1 finds in `value` against `$defs/<definition>`; empty when it is accepted. */
  k05(definition: string, value: unknown): string[];
  /** Problems K-07 v1 finds in `value` against `$defs/<definition>`. */
  k07(definition: string, value: unknown): string[];
  /** Problems K-08 v1 finds in a span. */
  span(value: unknown): string[];
}

let checks: ContractChecks | undefined;

/** One strict Ajv 2020-12 instance holding K-05 v1.1 and every frozen file its $refs reach (the Tool API's list, and it). */
export function contractChecks(): ContractChecks {
  if (checks !== undefined) return checks;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const schema of loadToolApiSchemas()) ajv.addSchema(schema);
  ajv.addSchema(readContractJson("data-access/data-access.v1.1.schema.json") as object);
  const problemsOf = (schemaId: string, definition: string, value: unknown): string[] => {
    const validate = ajv.getSchema(`${schemaId}#/$defs/${definition}`);
    if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
    return validate(value) ? [] : formatProblems(validate.errors);
  };
  checks = {
    k05: (definition, value) => problemsOf(K05_V1_1, definition, value),
    k07: (definition, value) => problemsOf(K07_V1, definition, value),
    span: (value) => problemsOf(K08_V1, "span", value),
  };
  return checks;
}

/** Throws when a K-05 v1.1 request or answer breaks its schema, so a runner that sends a wrong one fails its test. */
function mustPass(definition: string, value: unknown): void {
  const problems = contractChecks().k05(definition, value);
  if (problems.length > 0) throw new Error(`K-05 v1.1 ${definition} refused: ${problems.join("; ")}`);
}

/** K-07 v1's named rules and constants (outbox-effects.rules.mjs), as its own contract test reads them. */
export interface K07Rules {
  lifeChain: (record: unknown) => string[];
  EFFECT_TRIES: number;
  EFFECT_WINDOW_MS: number;
}

export async function k07Rules(): Promise<K07Rules> {
  const file = path.join(CONTRACTS_DIR, "outbox-effects", "outbox-effects.rules.mjs");
  return (await import(pathToFileURL(file).href)) as K07Rules;
}

// ---- the fake clock ------------------------------------------------------------------------------------------------

interface Wait {
  readonly at: number;
  readonly seq: number;
  readonly wake: () => void;
}

/** Lets every promise chain that can move, move: several turns of the event loop, each after all microtasks. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export class FakeClock implements RunnerClock {
  private nowMs: number;
  private seq = 0;
  private readonly waits: Wait[] = [];

  constructor(start: string) {
    this.nowMs = epochOf(start);
  }

  now(): number {
    return this.nowMs;
  }

  /** The time now, as the contracts write it. */
  nowUtc(): string {
    return utc(this.nowMs);
  }

  /** Waits still asleep. */
  get sleeping(): number {
    return this.waits.length;
  }

  sleepUntil(at: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true || at <= this.nowMs) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wait: Wait = {
        at,
        seq: this.seq,
        wake: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.seq += 1;
      const onAbort = (): void => {
        this.remove(wait);
        resolve();
      };
      this.waits.push(wait);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Moves the clock forward to `at` (never back), waking every wait due by then, in order. */
  async advanceTo(at: number): Promise<void> {
    for (let next = this.earliest(); next !== undefined && next.at <= at; next = this.earliest()) {
      this.nowMs = Math.max(this.nowMs, next.at);
      this.remove(next);
      next.wake();
      await settle();
    }
    this.nowMs = Math.max(this.nowMs, at);
    await settle();
  }

  /**
   * Runs `work` to its end: whenever nothing else can move, the clock jumps to the earliest wait and wakes it. Throws
   * when the work waits on nothing (it could never end), or takes more than `maxWaits` waits.
   */
  async drive<T>(work: Promise<T>, maxWaits = 10_000): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    work.then(
      (value) => {
        outcome = { ok: true, value };
      },
      (error: unknown) => {
        outcome = { ok: false, error };
      },
    );
    for (let waits = 0; waits <= maxWaits; waits += 1) {
      await settle();
      if (outcome !== undefined) {
        if (outcome.ok) return outcome.value;
        throw outcome.error;
      }
      const next = this.earliest();
      if (next === undefined) throw new Error("the work waits on nothing: it can never end");
      this.nowMs = Math.max(this.nowMs, next.at);
      this.remove(next);
      next.wake();
    }
    throw new Error(`the work did not end within ${String(maxWaits)} waits`);
  }

  private earliest(): Wait | undefined {
    let best: Wait | undefined;
    for (const wait of this.waits) {
      if (best === undefined || wait.at < best.at || (wait.at === best.at && wait.seq < best.seq))
        best = wait;
    }
    return best;
  }

  private remove(wait: Wait): void {
    const index = this.waits.indexOf(wait);
    if (index >= 0) this.waits.splice(index, 1);
  }
}

/**
 * A runner's clock that died: it reads the shared time, but none of its waits ever ends, as a runner whose process
 * stopped mid-wait. Its claims lapse and another runner takes its rows.
 */
export function diedClock(shared: FakeClock): RunnerClock {
  return {
    now: () => shared.now(),
    sleepUntil: () => new Promise<void>(() => undefined),
  };
}

// ---- the fake repo -------------------------------------------------------------------------------------------------

/** One K-07 v1 effectMove. */
export interface EffectMove {
  from: EffectRow["state"] | null;
  to: EffectRow["state"];
  at: string;
  by: "commitTurn" | "claimEffects" | "recordEffectResult";
  tryOutcome: "ok" | "networkError" | "declined" | null;
  note: string;
}

interface StoredEffect {
  row: EffectRow;
  version: number;
  claimedBy: string | null;
  claimLapsesAt: number | null;
  createdAt: number;
  lastTryAt: number | null;
  moves: EffectMove[];
}

/** A row as the fake repo holds it: the effect row, with its version and claim. */
export interface HeldEffect {
  row: EffectRow;
  version: number;
  claimedBy: string | null;
  claimLapsesAt: string | null;
  lastTryAt: string | null;
}

const copy = <T>(value: T): T => structuredClone(value);

/** A database round trip inside an open transaction: a few microtask turns, which `drive` and `settle` always flush. */
async function openTransaction(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
}

export class FakeEffectRepo implements EffectRepo {
  /** Every claim, with its request and answer, in order. */
  readonly claims: { request: ClaimEffectsRequest; answer: ClaimEffectsResponse | ClaimEffectsError }[] = [];
  /** Every result sent, with its request and answer, in order. */
  readonly results: {
    request: EffectResultRequest;
    answer: RecordEffectResultResponse | RecordEffectResultError;
  }[] = [];
  /** The event-log entries the results appended, in order. */
  readonly entries: EventEntry[] = [];

  private readonly rows = new Map<string, StoredEffect>();
  /** Rows an open claim holds (FOR UPDATE): another claim skips them (SKIP LOCKED). */
  private readonly locked = new Set<string>();
  /** Answers given instead of running the next results, in order (nothing is written for them). */
  private readonly resultAnswers: RecordEffectResultError[] = [];
  private claimAnswers: ClaimEffectsError[] = [];
  private created = 0;

  /** Writes a row as the commit writes it (K-05 v1.1 item 18): pending, tries 0, runs 1, version 1. */
  seed(effect: EffectRow, at: string): void {
    const row: EffectRow = {
      ...copy(effect),
      state: "pending",
      tries: 0,
      runs: 1,
      firstTryAt: null,
      providerObjectId: null,
      errorCode: null,
      ledgerLineId: null,
    };
    this.created += 1;
    this.rows.set(row.effectId, {
      row,
      version: 1,
      claimedBy: null,
      claimLapsesAt: null,
      createdAt: epochOf(at) + this.created / 1000,
      lastTryAt: null,
      moves: [
        {
          from: null,
          to: "pending",
          at,
          by: "commitTurn",
          tryOutcome: null,
          note: "Written by the turn's commit.",
        },
      ],
    });
  }

  /** Puts a row as it stands mid-life (its version and claim given), for scenarios that start after earlier tries. */
  put(held: HeldEffect, createdAt: string): void {
    this.created += 1;
    this.rows.set(held.row.effectId, {
      row: copy(held.row),
      version: held.version,
      claimedBy: held.claimedBy,
      claimLapsesAt: held.claimLapsesAt === null ? null : epochOf(held.claimLapsesAt),
      createdAt: epochOf(createdAt) + this.created / 1000,
      lastTryAt: held.lastTryAt === null ? null : epochOf(held.lastTryAt),
      moves: [],
    });
  }

  /** The next results answer these instead of running (transient, or a refusal), and write nothing. */
  answerNextResults(...answers: RecordEffectResultError[]): void {
    this.resultAnswers.push(...answers);
  }

  /** The next claims answer these instead of running. */
  answerNextClaims(...answers: ClaimEffectsError[]): void {
    this.claimAnswers.push(...answers);
  }

  held(effectId: string): HeldEffect {
    const stored = this.mustGet(effectId);
    return {
      row: copy(stored.row),
      version: stored.version,
      claimedBy: stored.claimedBy,
      claimLapsesAt: stored.claimLapsesAt === null ? null : utc(stored.claimLapsesAt),
      lastTryAt: stored.lastTryAt === null ? null : utc(stored.lastTryAt),
    };
  }

  /** The row's K-07 v1 effectLife: the row as it stands and every move since it was written. */
  life(effectId: string): unknown {
    const stored = this.mustGet(effectId);
    return { record: "effect", effect: copy(stored.row), moves: copy(stored.moves), providerEventIds: [] };
  }

  async claimEffects(request: ClaimEffectsRequest): Promise<ClaimEffectsResponse | ClaimEffectsError> {
    mustPass("claimEffects.request", request);
    const scripted = this.claimAnswers.shift();
    if (scripted !== undefined) {
      mustPass("claimEffects.errors", scripted);
      this.claims.push({ request: copy(request), answer: copy(scripted) });
      return copy(scripted);
    }
    const now = epochOf(request.now);
    const ports = request.ports;
    const claimable = (stored: StoredEffect): boolean =>
      (stored.row.state === "pending" ||
        (stored.row.state === "running" && stored.claimLapsesAt !== null && stored.claimLapsesAt <= now)) &&
      (ports === undefined || ports.includes(stored.row.port));
    // Read and lock: oldest first, skipping rows another open claim holds.
    const picked = [...this.rows.values()]
      .filter((stored) => !this.locked.has(stored.row.effectId) && claimable(stored))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, request.limit)
      .map((stored) => ({ effectId: stored.row.effectId, version: stored.version }));
    for (const { effectId } of picked) this.locked.add(effectId);
    const claimed: ClaimedEffect[] = [];
    try {
      // The claim's transaction is still open here: another claim started meanwhile reads in between, and skips these.
      await openTransaction();
      for (const { effectId, version } of picked) {
        const stored = this.mustGet(effectId);
        if (stored.version !== version || !claimable(stored)) continue;
        const from = stored.row.state === "pending" ? "pending" : "running";
        if (from === "pending")
          stored.row = { ...stored.row, state: "running", tries: 0, firstTryAt: request.now };
        stored.claimedBy = request.claimer;
        stored.claimLapsesAt = now + CLAIM_MS;
        stored.version += 1;
        stored.moves.push({
          from,
          to: "running",
          at: request.now,
          by: "claimEffects",
          tryOutcome: null,
          note: from === "pending" ? "Claimed: the run starts." : "A lapsed claim taken again.",
        });
        claimed.push({
          effect: copy(stored.row) as ClaimedEffect["effect"],
          version: stored.version,
          claimedFrom: from,
          claimedBy: request.claimer,
          claimLapsesAt: utc(stored.claimLapsesAt),
        });
      }
    } finally {
      for (const { effectId } of picked) this.locked.delete(effectId);
    }
    const answer: ClaimEffectsResponse = { result: "claimed", claimed };
    mustPass("claimEffects.response", answer);
    this.claims.push({ request: copy(request), answer: copy(answer) });
    return copy(answer);
  }

  recordEffectResult(
    request: EffectResultRequest,
  ): Promise<RecordEffectResultResponse | RecordEffectResultError> {
    mustPass("recordEffectResult.request", request);
    const answer = this.result(request);
    mustPass("error" in answer ? "recordEffectResult.errors" : "recordEffectResult.response", answer);
    this.results.push({ request: copy(request), answer: copy(answer) });
    return Promise.resolve(copy(answer));
  }

  private result(request: EffectResultRequest): RecordEffectResultResponse | RecordEffectResultError {
    const scripted = this.resultAnswers.shift();
    if (scripted !== undefined) return scripted;
    const stored = this.rows.get(request.effectId);
    const rowId = request.effectId;
    if (stored === undefined) return { error: "notFound", table: "effects", rowId };
    const { row } = stored;
    if (row.state !== "running") return { error: "wrongState", table: "effects", rowId, state: row.state };
    if (stored.claimedBy !== request.claimer) {
      return {
        error: "claimLost",
        table: "effects",
        rowId,
        claimer: stored.claimedBy,
        claimNo: null,
        state: row.state,
      };
    }
    if (stored.version !== request.expectVersion) {
      return {
        error: "versionChanged",
        changed: [
          { table: "effects", rowId, readVersion: request.expectVersion, currentVersion: stored.version },
        ],
      };
    }
    const at = epochOf(request.at);
    const tries = row.tries + 1;
    let state: EffectRow["state"] = "running";
    if (request.outcome === "ok") state = "succeeded";
    else if (request.outcome === "declined") state = "declined";
    else if (tries >= EFFECT_TRIES) state = "outage";
    stored.row = {
      ...row,
      state,
      tries,
      providerObjectId: request.outcome === "ok" ? request.providerObjectId : row.providerObjectId,
      ledgerLineId: request.outcome === "ok" ? request.ledgerLineId : row.ledgerLineId,
      errorCode: request.outcome === "ok" ? row.errorCode : request.errorCode,
    };
    if (state === "running") {
      stored.claimLapsesAt = (request.nextTryAt === null ? at : epochOf(request.nextTryAt)) + CLAIM_MS;
    } else {
      stored.claimedBy = null;
      stored.claimLapsesAt = null;
    }
    stored.version += 1;
    stored.lastTryAt = at;
    stored.moves.push({
      from: "running",
      to: state,
      at: request.at,
      by: "recordEffectResult",
      tryOutcome: request.outcome,
      note: `Try ${String(tries)}: ${request.outcome}.`,
    });
    this.entries.push(...copy(request.events));
    return {
      result: "recorded",
      effectId: rowId,
      version: stored.version,
      state,
      tries,
      runs: row.runs,
      claimLapsesAt: stored.claimLapsesAt === null ? null : utc(stored.claimLapsesAt),
    };
  }

  private mustGet(effectId: string): StoredEffect {
    const stored = this.rows.get(effectId);
    if (stored === undefined) throw new Error(`no effect row ${effectId}`);
    return stored;
  }
}

// ---- the fake kind port --------------------------------------------------------------------------------------------

/** One call a fake port saw. */
export interface SeenCall {
  effectId: string;
  idempotencyKey: string;
  /** The row's key as the call's effect carries it. */
  rowKey: string;
  attempt: number;
  at: string;
  answerBy: string;
  signal: AbortSignal;
}

/** How a fake port answers: given the call and how many calls it has seen for this row (from 1). */
export type Script = (call: KindCall, nth: number) => KindAnswer | Promise<KindAnswer>;

export class FakeKindPort implements KindPort {
  readonly calls: SeenCall[] = [];
  /** Effect ids called while an earlier call for the same row had not answered. */
  readonly overlaps: string[] = [];
  private readonly open = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly clock: FakeClock,
    private readonly script: Script,
  ) {}

  async run(call: KindCall): Promise<KindAnswer> {
    const id = call.effect.effectId;
    const nth = (this.seen.get(id) ?? 0) + 1;
    this.seen.set(id, nth);
    this.calls.push({
      effectId: id,
      idempotencyKey: call.idempotencyKey,
      rowKey: call.effect.idempotencyKey,
      attempt: call.attempt,
      at: this.clock.nowUtc(),
      answerBy: call.answerBy,
      signal: call.signal,
    });
    const open = this.open.get(id) ?? 0;
    if (open > 0) this.overlaps.push(id);
    this.open.set(id, open + 1);
    try {
      return await this.script(call, nth);
    } finally {
      this.open.set(id, (this.open.get(id) ?? 1) - 1);
    }
  }

  /** The calls for one row. */
  callsFor(effectId: string): SeenCall[] {
    return this.calls.filter((call) => call.effectId === effectId);
  }
}

export const ok = (
  providerObjectId: string | null = null,
  ledgerLineId: string | null = null,
): KindAnswer => ({
  outcome: "ok",
  providerObjectId,
  ledgerLineId,
});
export const declined = (errorCode = "card_declined"): KindAnswer => ({ outcome: "declined", errorCode });
export const networkError = (errorCode = "503", retryAfterMs: number | null = null): KindAnswer => ({
  outcome: "networkError",
  errorCode,
  retryAfterMs,
});

/** A port that answers after `ms` on the fake clock. */
export function after(clock: FakeClock, ms: number, answer: KindAnswer): Promise<KindAnswer> {
  return clock.sleepUntil(clock.now() + ms).then(() => answer);
}

/** A port call that never answers; it rejects once the runner stops waiting (its signal aborts). */
export function never(call: KindCall): Promise<KindAnswer> {
  return new Promise<KindAnswer>((_resolve, reject) => {
    call.signal.addEventListener(
      "abort",
      () => {
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

// ---- spans ---------------------------------------------------------------------------------------------------------

/** The bundle in force in the tests (K-08 v1 span-effect-run-retry.json's). */
export const TEST_BUNDLE: BundleId = {
  hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
  build: 1,
};

/** Opens one trace per effect run on the fake clock, as C-056 would, and keeps every span. */
export function spanRecorder(clock: FakeClock): {
  spans: Span[];
  traceOf: (effect: EffectRow) => EffectSpans;
} {
  const spans: Span[] = [];
  let traces = 0;
  return {
    spans,
    traceOf: () => {
      traces += 1;
      return openTrace({
        openedBy: "sweep",
        jobId: `effects-run-${String(traces)}`,
        bundleId: TEST_BUNDLE,
        now: () => clock.now(),
        sink: (span) => {
          spans.push(span);
        },
      });
    },
  };
}

// ---- effect rows from the contracts' fixtures ----------------------------------------------------------------------

/** The effect row of a K-07 v1 effectLife fixture, or of a K-05 v1.1 claim fixture's first claimed row. */
export function fixtureEffect(file: string): EffectRow {
  const fixture = readContractJson(file) as {
    effect?: EffectRow;
    outcome?: { claimed?: { effect: EffectRow }[] };
  };
  const effect = fixture.effect ?? fixture.outcome?.claimed?.[0]?.effect;
  if (effect === undefined) throw new Error(`${file} holds no effect row`);
  return copy(effect);
}

/** Alex's calendar write on Riley's calendar (K-05 v1.1 claim-effects.json), pending. */
export const calendarWrite = (): EffectRow => fixtureEffect("data-access/fixtures/claim-effects.json");
/** Alex's $40 Groom's package deposit (K-07 v1 effect-charge-declined.json). */
export const depositCharge = (): EffectRow =>
  fixtureEffect("outbox-effects/fixtures/effect-charge-declined.json");
/** Alex's mobile added as a Linq contact (K-07 v1 effect-linq-contact-add.json). */
export const contactAdd = (): EffectRow =>
  fixtureEffect("outbox-effects/fixtures/effect-linq-contact-add.json");

/** A copy of `base` as its own row: its own id and its own key, which is not its id. */
export function variant(base: EffectRow, suffix: string): EffectRow {
  const effectId = `${base.effectId}-${suffix}`;
  return { ...copy(base), effectId, idempotencyKey: `key-${effectId}` };
}

/** The kinds of a port, each answered by the same fake port. */
export function portsFor(
  kinds: readonly EffectKind[],
  port: KindPort,
): Partial<Record<EffectKind, KindPort>> {
  return Object.fromEntries(kinds.map((kind) => [kind, port]));
}
