// Doubles and fixtures for the commit's tests (T-305). Never imported by the Worker. The doubles stand in for the commit's
// ports, each another task's (types.ts CommitPorts): the K-05 data-access call (T-306 runs it on PostgreSQL), what a
// passed part's choice writes (the walk and the step writes), the shared-core calls and the safety holds' read. They
// never stand in for the commit under test. Limits 1 to 6 are the gate framework's scripted doubles (T-298).
// Values come only from the contracts' fixtures (K-02, K-05, K-07, K-09, K-24: the master's sample cast, the 555-01xx
// range; rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type * as K05 from "../../../contracts/generated/data-access/data-access.v1.1";
import type * as K05V1dot22 from "../../../contracts/generated/data-access/data-access.v1.22";
import { copy, gateExchange } from "../gate/framework/test-support";
import type { Choice, SetupKey } from "../gate/framework";
import { CONTRACTS_DIR, SCHEMA_FILES, formatProblems } from "../tool-api";
import { contractFile } from "../tool-api/test-support";
import type {
  CommitPorts,
  CommitTurnAnswer,
  CommitTurnRequest,
  CommitTurnResponse,
  CoreAction,
  CoreResult,
  CoreRun,
  EffectNew,
  OpenHolds,
  PassedPart,
  RowRef,
  SafetyHold,
  UnitWrites,
  Why,
} from "./types";

// ---------------------------------------------------------------------------------------------------------------
// The contracts' own schemas (Ajv 2020, strict), as the contract tests hold them

/**
 * K-05 v1.22 (T-1474), the version every turn's commit speaks (build.ts default 11; T-1479): it holds every v1.21
 * definition under its own name, by reference, and restates outboxRowNew, which takes a row's step and lineNo (both or
 * neither: README item 82), writes, commitTurn.request and the exchanges to refer to it, keeping v1.17's
 * answerPhoneRowsBy (README item 71; build.ts default 9) and its commitTurn.handleIdExchange, and v1.21's
 * `openQuestions.askAgain` (README item 81; build.ts default 10), by reference. Without a step, every request and
 * exchange is v1.21's, and without a raise v1.17's (README "v1.22": every v1 to v1.21 exchange is a v1.22 exchange).
 */
const DATA_ACCESS_V1_22_FILE = "data-access/data-access.v1.22.schema.json";
const DATA_ACCESS_V1_22 = `https://rosie.invalid/contracts/${DATA_ACCESS_V1_22_FILE}`;
/**
 * K-05 v1.21 (T-1508), the version that took a raise first (build.ts default 10; T-1505): v1.20's definitions by
 * reference, and `writes`, `commitTurn.request`, `commitTurn.errors` and the exchanges restated to take
 * `openQuestions.askAgain` (README item 81). v1.22 refers to it, so it is held with v1.22's files.
 */
const DATA_ACCESS_V1_21_FILE = "data-access/data-access.v1.21.schema.json";
const DATA_ACCESS_V1_21 = `https://rosie.invalid/contracts/${DATA_ACCESS_V1_21_FILE}`;
const EVENT_TRACE_V1 = "https://rosie.invalid/contracts/event-trace/event-trace.v1.schema.json";
const EVENT_TRACE_V1_1 = "https://rosie.invalid/contracts/event-trace/event-trace.v1.1.schema.json";

export interface ContractChecks {
  /**
   * Problems K-05 v1.22 `$defs/<call>.<part>` finds, one line each (a path and what it wants, never a value): every v1.21
   * definition by reference, commitTurn.request with answerPhoneRowsBy, a raise and rows that name their step and line,
   * commitTurn.handleIdExchange, commitTurn.askAgainExchange and commitTurn.rowLineExchange.
   */
  k05(definition: string, value: unknown): string[];
  /**
   * Problems K-05 v1.21 `$defs/<call>.<part>` finds (T-1505): commitTurn.request with `openQuestions.askAgain`, its
   * errors with the open question's wrongState, and commitTurn.askAgainExchange.
   */
  k05v121(definition: string, value: unknown): string[];
  /** Problems K-08 v1.1 `$defs/<definition>` finds (eventLogRow, eventLogBatch). */
  k08(definition: string, value: unknown): string[];
  /** Problems K-08 v1 `$defs/<definition>` finds (safeId, handleRef, rowRef: a row id that is never a number). */
  k08v1(definition: string, value: unknown): string[];
}

let checks: ContractChecks | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every file a schema's $refs name, relative to contracts/ (a $ref inside the schema itself names none). */
function referencedFiles(file: string, schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item) => referencedFiles(file, item));
  if (!isRecord(schema)) return [];
  return Object.entries(schema).flatMap(([key, inner]) => {
    if (key !== "$ref" || typeof inner !== "string") return referencedFiles(file, inner);
    const target = inner.split("#")[0] ?? "";
    return target === "" ? [] : [path.posix.join(path.posix.dirname(file), target)];
  });
}

/**
 * One strict Ajv instance holding the frozen schemas the Tool API holds, and K-05 v1.22 and v1.21 with every file their
 * $refs reach (K-05 v1 to v1.20 among them), each file once.
 */
export function contractChecks(): ContractChecks {
  if (checks !== undefined) return checks;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const held = new Set<string>();
  const queue: string[] = [...SCHEMA_FILES, DATA_ACCESS_V1_22_FILE, DATA_ACCESS_V1_21_FILE];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (held.has(file)) continue;
    const schema = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as object;
    ajv.addSchema(schema);
    held.add(file);
    queue.push(...referencedFiles(file, schema));
  }
  const problems = (schemaId: string, definition: string, value: unknown): string[] => {
    const validate: ValidateFunction | undefined = ajv.getSchema(`${schemaId}#/$defs/${definition}`);
    if (validate === undefined) throw new Error(`no definition ${definition}`);
    return validate(value) ? [] : formatProblems(validate.errors);
  };
  checks = {
    k05: (definition, value) => problems(DATA_ACCESS_V1_22, definition, value),
    k05v121: (definition, value) => problems(DATA_ACCESS_V1_21, definition, value),
    k08: (definition, value) => problems(EVENT_TRACE_V1_1, definition, value),
    k08v1: (definition, value) => problems(EVENT_TRACE_V1, definition, value),
  };
  return checks;
}

/**
 * The event-log rows a commit request appends, as they land in K-04 v1's event_log (K-08 v1.1 eventLogRow, column for
 * column): each entry with the turn's id, trace id and bundle, and the commit's time (K-05 v1 eventEntry: "The turn's id,
 * trace id and bundle ... come from the call, not the entry").
 */
export function eventLogRowsOf(request: CommitTurnRequest, at: string): Record<string, unknown>[] {
  const { turn } = request;
  return request.writes.events.map((entry) => ({
    id: entry.id,
    at,
    zone: entry.zone,
    turn_id: turn.id,
    job_id: null,
    trace_id: turn.traceId,
    bundle_hash: turn.bundleId.hash,
    bundle_build: turn.bundleId.build,
    business_id: entry.businessId,
    actor_kind: entry.actorKind,
    actor_person_id: entry.actorPersonId,
    actor_role: entry.actorRole,
    kind: entry.kind,
    table_name: entry.tableName,
    row_id: entry.rowId,
    old_values: entry.oldValues,
    new_values: entry.newValues,
    sealed_values: entry.sealed?.base64 ?? null,
    sealed_for_person_id: entry.sealed?.forPersonId ?? null,
    why: entry.why,
    approved_by: entry.approvedBy,
    proofs: entry.proofs,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// The K-05 fake: commitTurn on an in-memory store

/** One K-05 data-access exchange (contracts/data-access/fixtures), freshly parsed. */
export function k05Exchange(file: string): K05.CommitTurnExchange {
  return contractFile(`data-access/fixtures/${file}`) as K05.CommitTurnExchange;
}

export interface K05FakeOptions {
  /** The database's now(): each first commit's committedAt. */
  readonly now?: string;
  /** The commit order of the next outbox row (K-04 commit_seq; a fresh database starts at 1). */
  readonly nextCommitSeq?: number;
  /** Answers given instead of committing, in order; null commits as the database does. */
  readonly answers?: readonly (CommitTurnAnswer | null)[];
}

export interface K05Fake {
  /**
   * K-05 v1.22 commitTurn (v1.1's, with v1.17's answerPhoneRowsBy, v1.21's raise and v1.22's rows that name their step
   * and line): any v1.22 request, the field set, as the commit's port sends every one (types.ts CommitPorts.commitTurn;
   * build.ts default 11), or left out, as a K-05 v1.1 fixture's request is sent to it as it is.
   */
  readonly commitTurn: (
    request: K05V1dot22.CommitTurnRequest,
    call: Parameters<CommitPorts["commitTurn"]>[1],
  ) => ReturnType<CommitPorts["commitTurn"]>;
  /**
   * Every request sent, in order, as sent: K-05 v1.22's, so a turn's answerPhoneRowsBy and each row's step and line read
   * as they were sent.
   */
  readonly requests: K05V1dot22.CommitTurnRequest[];
  /** What each first commit of a turn id wrote, in order: a repeat adds nothing. */
  readonly commits: { readonly turnId: string; readonly written: RowRef[] }[];
}

/**
 * The one raise of a request K-05 v1.22's schema took (one at most: K-05 v1.21 item 81, which v1.22 keeps), or null for
 * a request with no `askAgain`.
 */
function raiseIn(request: K05V1dot22.CommitTurnRequest): { id: string; expectVersion: number } | null {
  const [raise] = request.writes.openQuestions.askAgain ?? [];
  return raise === undefined ? null : { id: raise.id, expectVersion: raise.expectVersion };
}

/**
 * A K-05 v1.22 commitTurn that commits into memory as K-05 v1 item 1 and v1.1 item 18 say: a request K-05 v1.22's schema
 * refuses throws (the commit sent what K-05 does not take; build.ts default 11), so a row's step and line are held to
 * v1.22's outboxRowNew, both or neither; a turn id committed before writes nothing and returns the first commit with
 * `repeated` true and no rows, whatever the repeat's body; otherwise every row written with its version after the commit
 * (an insert 1, an update its read version plus one; a reservation booked also cancels its saved-time clock row) and the
 * outbox rows in commit order. The versions read are not compared (limit 4 runs on PostgreSQL: T-306). It knows no
 * phones row's handle id, so a turn that writes a phones row scripts K-05's answer (`answers`). A request that asks an
 * open question again (`openQuestions.askAgain`: K-05 v1.21 item 81, kept by v1.22; T-1505) has its raise written at its
 * read version plus one, after the questions opened and closed (v1.21 default 198); whether the question is live and at
 * that version is the database's to check (T-1509).
 */
export function k05Fake(options: K05FakeOptions = {}): K05Fake {
  const now = options.now ?? "2026-10-19T14:05:06Z";
  let nextSeq = options.nextCommitSeq ?? 1;
  const answers = [...(options.answers ?? [])];
  const firsts = new Map<string, CommitTurnResponse>();
  const requests: K05V1dot22.CommitTurnRequest[] = [];
  const commits: { turnId: string; written: RowRef[] }[] = [];

  const remember = (answer: CommitTurnResponse): CommitTurnResponse => {
    firsts.set(answer.turnId, copy(answer));
    commits.push({ turnId: answer.turnId, written: copy(answer.committed.written) });
    return answer;
  };

  const commit = (request: K05V1dot22.CommitTurnRequest): CommitTurnResponse => {
    const { writes } = request;
    const written: RowRef[] = [];
    const row = (table: string, rowId: string, version: number): void => {
      written.push({ table, rowId, version });
    };
    for (const write of writes.state) {
      if (write.op === "insert") row(write.table, String(write.values.id), 1);
      else row(write.table, String(write.key.id), write.expectVersion + 1);
    }
    for (const question of writes.openQuestions.open) row("open_questions", question.id, 1);
    for (const close of writes.openQuestions.close) row("open_questions", close.id, close.expectVersion + 1);
    const raise = raiseIn(request);
    if (raise !== null) row("open_questions", raise.id, raise.expectVersion + 1);
    for (const clock of writes.clockRows.make) row("clock_rows", String(clock.id), 1);
    for (const cancel of writes.clockRows.cancel) row("clock_rows", cancel.id, cancel.expectVersion + 1);
    for (const confirm of writes.reservations.confirm) {
      row("reservations", confirm.id, confirm.expectVersion + 1);
      row("clock_rows", `${confirm.id}/saved-time`, 2);
    }
    for (const release of writes.reservations.release)
      row("reservations", release.id, release.expectVersion + 1);
    for (const effect of writes.effects?.write ?? []) row("effects", String(effect.effectId), 1);
    for (const letGo of writes.effects?.letGo ?? []) row("effects", letGo.effectId, letGo.expectVersion + 1);
    const outboxRows = writes.outboxRows.map((outbox) => ({ id: outbox.id, commitSeq: nextSeq++ }));
    return {
      result: "committed",
      turnId: request.turn.id,
      committedAt: now,
      repeated: false,
      committed: { written, outboxRows, promoted: [] },
    };
  };

  return {
    requests,
    commits,
    commitTurn(request) {
      requests.push(copy(request));
      const problems = contractChecks().k05("commitTurn.request", request);
      if (problems.length > 0) {
        return Promise.reject(new Error(`K-05 v1.22 refuses the request: ${problems.join("; ")}`));
      }
      const first = firsts.get(request.turn.id);
      if (first !== undefined) {
        return Promise.resolve({
          ...copy(first),
          repeated: true,
          committed: { written: [], outboxRows: copy(first.committed.outboxRows), promoted: [] },
        });
      }
      const scripted = answers.shift() ?? null;
      if (scripted !== null) {
        return Promise.resolve(
          "error" in scripted || scripted.repeated ? copy(scripted) : remember(copy(scripted)),
        );
      }
      return Promise.resolve(remember(commit(request)));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The other ports' doubles

/** Writes with every list empty. */
export function noWrites(why: Why): UnitWrites {
  return {
    why,
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    closes: [],
    clockCancels: [],
    messages: [],
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  };
}

/** A unit's why from its choice: the step, and the branch label the bundle writes. */
export function whyOfChoice(choice: Choice | null): Why {
  if (choice === null) throw new Error("a part with no choice needs its writes scripted");
  return { step: choice.step, choice: choice.branch ?? choice.label };
}

/** What one port call was handed of what is open: the hold ids and the unread event ids. */
export interface OpenSeen {
  readonly holds: string[];
  readonly unread: string[];
}

const seen = (open: OpenHolds): OpenSeen => ({
  holds: open.holds.map((hold) => hold.holdId),
  unread: [...open.unreadEventIds],
});

export interface PortCalls {
  /** The parts writesOf was asked for, by index, in order. */
  readonly writesOf: number[];
  /** What each writesOf call was handed of what is open, in order. */
  readonly writesOfOpen: OpenSeen[];
  /** The core actions run, by call name, in order. */
  readonly runCore: string[];
  /** The ids of the holds each core action was handed, in order. */
  readonly coreHolds: string[][];
  /** The unread event ids each core action was handed, in order. */
  readonly coreUnread: string[][];
  /** How many times what is open was read. */
  openHolds: number;
}

export interface Doubles {
  /** What each passed part writes, by part index; a part not named writes nothing. */
  readonly writes?: Readonly<Partial<Record<number, UnitWrites>>>;
  /** Each core action's run, in the request's order. */
  readonly core?: readonly CoreRun[];
  /** The holds open on the handle. */
  readonly holds?: readonly SafetyHold[];
  /** The turn's texts not yet read, by event id. */
  readonly unread?: readonly string[];
  readonly k05?: K05Fake;
}

/** The commit's ports as doubles, every call written down. */
export function doublePorts(doubles: Doubles = {}): { ports: CommitPorts; calls: PortCalls; k05: K05Fake } {
  const k05 = doubles.k05 ?? k05Fake();
  const calls: PortCalls = {
    writesOf: [],
    writesOfOpen: [],
    runCore: [],
    coreHolds: [],
    coreUnread: [],
    openHolds: 0,
  };
  const core = [...(doubles.core ?? [])];
  const ports: CommitPorts = {
    commitTurn: (request, call) => k05.commitTurn(request, call),
    writesOf(part: PassedPart, _turn, open) {
      calls.writesOf.push(part.index);
      calls.writesOfOpen.push(seen(open));
      return Promise.resolve(copy(doubles.writes?.[part.index] ?? noWrites(whyOfChoice(part.choice))));
    },
    runCore(action: CoreAction, _turn, open) {
      calls.runCore.push(action.call);
      const handed = seen(open);
      calls.coreHolds.push(handed.holds);
      calls.coreUnread.push(handed.unread);
      const run = core[calls.runCore.length - 1];
      if (run === undefined) return Promise.reject(new Error("no core run scripted"));
      return Promise.resolve(copy(run));
    },
    openHolds() {
      calls.openHolds += 1;
      return Promise.resolve({
        holds: copy([...(doubles.holds ?? [])]),
        unreadEventIds: [...(doubles.unread ?? [])],
      });
    },
  };
  return { ports, calls, k05 };
}

// ---------------------------------------------------------------------------------------------------------------
// Sam names his kinds of work (S1-02): K-09 commit-s1-02.json

export const S1_02 = "commit-s1-02.json";

/** The keys S1-02's walk gives, as commit-s1-02.json states them (S1-02 gives kinds; S1-11 the 11 pf keys). */
export function s1_02Gives(): SetupKey[] {
  const { given } = gateExchange(S1_02) as unknown as { given: { stated: { gives: SetupKey[] } } };
  return [...given.stated.gives];
}

/** The core action's result commit-s1-02.json answers: Sam's text's safety outcome, No. */
export function s1_02SafetyOutcome(): CoreResult {
  const { outcome } = gateExchange(S1_02);
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error("commit-s1-02 commits");
  const [first] = outcome.core;
  if (first === undefined) throw new Error("commit-s1-02 carries one core action");
  return first;
}

/** The safety outcome's run: its result, writing nothing in the commit's lists (recordSafetyOutcome is M3b's call). */
export function s1_02CoreRun(): CoreRun {
  return { result: s1_02SafetyOutcome(), writes: noWrites({ step: "A3-22", choice: null }) };
}

/** The kinds Sam names, in order: K-24 seed-business-kinds.json's picked kinds (id, words, kind). */
const SAM_KINDS = [
  { id: "pick-sam-barbershop", words: "Barbershop", kindId: "barber" },
  { id: "pick-sam-plumbing", words: "plumbing", kindId: "plumber" },
  { id: "pick-sam-electrical", words: "electrical", kindId: "electrician" },
] as const;

/**
 * What S1-02's "All on the list" writes, as commit-s1-02.json states it (the walk's double): the three picked kinds (K-24
 * picked_kinds, as K-24's seed writes them before S1-04 sets their companies), S1-02's question answered with its clock
 * cancelled, and S1-04's question to Sam with its one message (quick reply). K-08 v1.1 has no kind for picked kinds
 * (CQ-56), so they come with no entry of their own.
 */
export function samKindsWrites(): UnitWrites {
  return {
    why: { step: "S1-02", choice: "All on the list" },
    versionsRead: [],
    state: SAM_KINDS.map((kind, index) => ({
      op: "insert" as const,
      table: "picked_kinds",
      values: {
        id: kind.id,
        owner_person_id: "person-sam",
        position: index + 1,
        words: kind.words,
        outcome: "listed",
        kind_id: kind.kindId,
        business_id: "biz-lees-barbershop",
      },
    })),
    stateEvents: [],
    asks: [
      {
        question: {
          id: "oq-s1-04-sam",
          handleId: "handle-sam",
          personId: "person-sam",
          businessId: "biz-lees-barbershop",
          bookingId: null,
          step: "S1-04",
          options: [],
          readback: null,
          versionsRead: [],
          clock: null,
        },
        safeDefault: null,
      },
    ],
    closes: [{ id: "oq-s1-02", expectVersion: 2, status: "answered", answeredOptionId: null }],
    clockCancels: [{ id: "clock-oq-s1-02", expectVersion: 2 }],
    messages: [
      {
        id: "out-s1-04-sam",
        recipientHandleId: "handle-sam",
        recipientPersonId: "person-sam",
        businessId: "biz-lees-barbershop",
        bookingId: null,
        channel: "imessage",
        sendClass: "quick_reply",
        openQuestionId: "oq-s1-04-sam",
        copyOfRowId: null,
        versionsRead: [],
      },
    ],
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: s1_02Gives(),
  };
}

/** The K-05 answer commit-s1-02.json states the commit got: what it wrote, as its outcome's `written` lists it. */
export function s1_02K05Answer(): CommitTurnResponse {
  const { outcome } = gateExchange(S1_02);
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error("commit-s1-02 commits");
  return {
    result: "committed",
    turnId: outcome.turnId,
    committedAt: outcome.committedAt,
    repeated: false,
    committed: copy(outcome.written),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Effect rows: K-07 v1's effect lives

/** The fields of K-05 v1.1 effectNew, which a commit writes (the call adds the rest). */
const EFFECT_NEW_FIELDS = [
  "effectId",
  "businessId",
  "bookingId",
  "kind",
  "port",
  "calendarProvider",
  "visitId",
  "personId",
  "handleId",
  "amount",
  "portRequest",
  "idempotencyKey",
  "traceId",
] as const;

/** A K-07 v1 effect life's row (contracts/outbox-effects/fixtures), as a commit writes it: K-05 v1.1 effectNew's fields. */
export function effectAtCommit(file: string): EffectNew {
  const { effect } = contractFile(`outbox-effects/fixtures/${file}`) as { effect: Record<string, unknown> };
  const row: Record<string, unknown> = {};
  for (const field of EFFECT_NEW_FIELDS) if (field in effect) row[field] = effect[field];
  return row;
}
