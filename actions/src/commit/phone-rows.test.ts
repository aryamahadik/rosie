// T-1419's proofs (the card's "Proves it with", its lead notes 1 and 2, DL-877 and DL-885, and the architect's ruling on
// CQ-342, item 4): every turn's commit asks K-05 v1.17 to name a phones row by its handle id (answerPhoneRowsBy handleId:
// K-05 README item 71; build.ts default 9), so the turn's span, the stillChanged rows and K-09's written carry a phones row
// by its handle id, never its number, while the request still names it by its number (item 71.4).
//
// gateAndCommit runs on the gate's scripted limits (never the stubs changed) and the commit's port doubles
// (test-support.ts), never a double of the commit: K-09 v1's stop-recorded.json (Ben's core-only turn, his text's record
// and then his STOP), each core action's run its outcome's result, the STOP's writes as K-05 v1.17's stop twin writes
// Alex's (commit-alex-stop-handle-id.json) with stop-recorded.json's ids, and K-05 a double answering as that twin and
// commit-alex-phone-changed-handle-id.json answer. Every exchange is held to K-05 v1.17's commitTurn.handleIdExchange by
// its schema, never by the generated types alone, which are wider (T-1418 default 150); every row id named outward to
// K-08 v1's safeId, a phones row's to its handle id exactly (T-1418's security review, note 8a), and every string to no
// run of seven digits of the number. The numbers are the fixtures' own, whole, in the 555-01xx range (rule 9), and
// nothing here logs one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as K05V1dot17 from "../../../contracts/generated/data-access/data-access.v1.17";
import {
  callContext,
  copy,
  fixtureScript,
  gateExchange,
  scriptedLimits,
} from "../gate/framework/test-support";
import type { GateRequest } from "../gate/framework";
import { createToolApi, createToolApiValidator } from "../tool-api";
import {
  contractFile,
  recordingHandlers,
  recordingScope,
  stringsIn,
  traceFor,
} from "../tool-api/test-support";
import { ANSWER_PHONE_ROWS_BY, buildCommitRequest, rowsNamedBy, type CommitUnit } from "./build";
import { PHONE_ROW_BY_NUMBER, gateAndCommit } from "./commit";
import { CommitRefusedError } from "./errors";
import {
  S1_02,
  contractChecks,
  doublePorts,
  effectAtCommit,
  k05Fake,
  noWrites,
  s1_02CoreRun,
  samKindsWrites,
  type K05Fake,
} from "./test-support";
import type {
  CommitDeps,
  CommitTurnAnswer,
  CommitTurnError,
  CommitTurnResponse,
  Committed,
  CoreRun,
  GateAndCommitRequest,
  UnitWrites,
} from "./types";

const validator = createToolApiValidator();

const STOP_RECORDED = "stop-recorded.json";

/** Ben's mobile, whole, as stop-recorded.json's STOP names it (555-01xx; rule 9). */
const BEN = "+15555550131";
/** Ben's handle: his phone row's handle id (K-04 phones.handle_id), as stop-recorded.json's `written` names the row. */
const BEN_HANDLE = "handle-ben";
/** Alex's mobile, whole, and his handle, as K-05 v1.17's commit-alex-phone-changed-handle-id.json names them. */
const ALEX = "+15555550101";
const ALEX_HANDLE = "handle-alex";

// ---------------------------------------------------------------------------------------------------------------
// The fixtures

/** stop-recorded.json (K-09 v1), freshly parsed: Ben's core-only turn and its committed outcome. */
function stopRecorded(): { request: GateAndCommitRequest; outcome: Committed } {
  const { request, outcome } = gateExchange(STOP_RECORDED);
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error(`${STOP_RECORDED} commits`);
  return { request, outcome };
}

/** One of K-05 v1.17's commit twins (contracts/data-access/fixtures), freshly parsed. */
function v1dot17Twin(file: string): K05V1dot17.CommitTurnExchange {
  return contractFile(`data-access/fixtures/${file}`) as K05V1dot17.CommitTurnExchange;
}

/** K-05 v1.17's stop twin: Alex's STOP, its phones row answered by its handle id. */
const stopTwin = (): K05V1dot17.CommitTurnExchange => v1dot17Twin("commit-alex-stop-handle-id.json");
/** K-05 v1.17's versionChanged twin: Sam's turn that read Alex's phone, refused, the phone named by its handle id. */
const phoneChangedTwin = (): K05V1dot17.CommitTurnExchange =>
  v1dot17Twin("commit-alex-phone-changed-handle-id.json");

/** stop-recorded.json's answer for one core call. */
function coreResultOf(call: CoreRun["result"]["call"]): CoreRun["result"] {
  const result = stopRecorded().outcome.core.find((each) => each.call === call);
  if (result === undefined) throw new Error(`${STOP_RECORDED} carries ${call}`);
  return result;
}

/** What stop-recorded.json's STOP answers: its STOP row, its reply's row and the phone's version after the commit. */
function stopAnswered(): { consentId: string; replyId: string; phoneVersion: number } {
  const result = coreResultOf("recordStopOrStart");
  if (result.call !== "recordStopOrStart" || result.response === null)
    throw new Error("the STOP is recorded");
  const [consentId] = result.response.consentRowIds;
  const replyId = result.response.reply?.outboxRowId;
  if (consentId === undefined || typeof replyId !== "string") {
    throw new Error("the STOP writes its row and its reply");
  }
  return { consentId, replyId, phoneVersion: result.response.phoneVersion };
}

/** Ben's text's record (No), as stop-recorded.json answers it, writing nothing in the commit's lists (s1_02CoreRun's form). */
function benRecordRun(): CoreRun {
  return { result: coreResultOf("recordSafetyOutcome"), writes: noWrites({ step: "A3-22", choice: null }) };
}

/**
 * Ben's STOP's writes as K-05 v1.17's stop twin writes Alex's (commit-alex-stop-handle-id.json), with stop-recorded.json's
 * ids, words and time, on the phone read at `readVersion` (stop-recorded.json's: 3): the phone stopped with its chat
 * closed, compared and set on the version read and named by its number, as every request names a phones row (README item
 * 71.4); K-29's STOP row for every business; the stop reply, decided on the phone's version after the commit. Its entries
 * name the phone by its handle id (K-08 v1).
 */
function benStopWrites(readVersion = 3): UnitWrites {
  const { request } = stopRecorded();
  const at = request.now;
  const { consentId, replyId } = stopAnswered();
  const twinConsent = stopTwin().request.writes.state.find((write) => write.table === "consents");
  if (twinConsent?.op !== "insert") throw new Error("the stop twin writes its STOP row");
  return {
    ...noWrites({ step: "A7-11", choice: "optOut" }),
    versionsRead: [{ table: "phones", rowId: BEN, version: readVersion }],
    state: [
      {
        op: "update",
        table: "phones",
        key: { number: BEN },
        expectVersion: readVersion,
        set: { stopped: true, stop_at: at, chat_open: false },
      },
      {
        op: "insert",
        table: "consents",
        values: {
          id: consentId,
          person_id: "person-ben",
          business_id: null,
          kind: "texts",
          revoked: true,
          handle_id: BEN_HANDLE,
          exact_words: "STOP",
          words_sha256: twinConsent.values.words_sha256,
          at,
          channel: "text",
          turn_id: request.turn?.id,
        },
      },
    ],
    stateEvents: [
      {
        id: "log-phone-ben-stopped-1",
        kind: "phone.stopped",
        zone: null,
        businessId: null,
        actorKind: "person",
        actorPersonId: "person-ben",
        actorRole: null,
        tableName: "phones",
        rowId: BEN_HANDLE,
        oldValues: { stopped: false, chat_open: true, stop_at: null },
        newValues: { stopped: true, chat_open: false, stop_at: at },
        sealed: null,
        why: { choice: "optOut" },
        approvedBy: { kind: "consentRow", consent_id: consentId },
        proofs: null,
      },
      {
        id: `log-${consentId}`,
        kind: "consent.withdrawn",
        zone: null,
        businessId: null,
        actorKind: "person",
        actorPersonId: "person-ben",
        actorRole: null,
        tableName: "consents",
        rowId: consentId,
        oldValues: null,
        newValues: { kind: "texts", revoked: true, business_id: null },
        sealed: null,
        why: { choice: "optOut" },
        approvedBy: null,
        proofs: null,
      },
    ],
    messages: [
      {
        id: replyId,
        recipientHandleId: BEN_HANDLE,
        recipientPersonId: "person-ben",
        businessId: null,
        bookingId: null,
        channel: "imessage",
        sendClass: "quick_reply",
        openQuestionId: null,
        copyOfRowId: null,
        versionsRead: [{ table: "phones", rowId: BEN, version: readVersion + 1 }],
      },
    ],
  };
}

/** Ben's STOP as stop-recorded.json answers it, its writes on the phone read at `readVersion` (benStopWrites). */
function benStopRun(readVersion = 3): CoreRun {
  return { result: coreResultOf("recordStopOrStart"), writes: benStopWrites(readVersion) };
}

/**
 * K-05's answer to Ben's commit, as K-05 v1.17's stop twin answers Alex's: the phones row by its handle id, at the
 * version after the stop; the stop reply with its commit order; nothing promoted (stop-recorded.json's `written`).
 */
function stopTwinAnswer(): CommitTurnResponse {
  const { outcome } = stopRecorded();
  return {
    result: "committed",
    turnId: outcome.turnId,
    committedAt: outcome.committedAt,
    repeated: false,
    committed: copy(outcome.written),
  };
}

/**
 * K-05's versionChanged on Ben's phone read at `readVersion`, as commit-alex-phone-changed-handle-id.json answers on
 * Alex's: the changed row by its handle id, with the version read and the version now.
 */
function benPhoneChanged(readVersion: number): CommitTurnError {
  return {
    error: "versionChanged",
    changed: [{ table: "phones", rowId: BEN_HANDLE, readVersion, currentVersion: readVersion + 1 }],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The checks

/** A K-05 exchange as K-05 v1.17 holds it (commitTurn.exchange): the request as sent and its answer, at `now`. */
function exchangeOf(request: unknown, outcome: CommitTurnAnswer, now: string): Record<string, unknown> {
  return { call: "commitTurn", given: { k04Seeds: [], after: [], now }, request, outcome };
}

/** Problems K-05 v1.17's commitTurn.handleIdExchange finds in an exchange: by its schema, never the types alone. */
function handleIdProblems(request: unknown, outcome: CommitTurnAnswer, now: string): string[] {
  return contractChecks().k05("commitTurn.handleIdExchange", exchangeOf(request, outcome, now));
}

/** Each id K-08 v1's safeId refuses, with its problems: an id that is a number, an address or words. */
function notSafeIds(ids: readonly string[]): string[] {
  return ids.flatMap((id) =>
    contractChecks()
      .k08v1("safeId", id)
      .map((problem) => `${id} ${problem}`),
  );
}

/**
 * Every string in `value` that holds a run of seven digits of `number` once its other characters are dropped, so no
 * plus, space, punctuation or letters around it (a tel: prefix) hide the number (K-08 v1 safeId: seven or more digits
 * read as a number).
 */
function numberIn(value: unknown, number: string): string[] {
  const digits = number.replace(/[^0-9]/g, "");
  const runs = Array.from({ length: digits.length - 6 }, (_, at) => digits.slice(at, at + 7));
  return stringsIn(value).filter((text) => {
    const held = text.replace(/[^0-9]/g, "");
    return runs.some((run) => held.includes(run));
  });
}

interface StopDeps extends CommitDeps {
  readonly k05: K05Fake;
}

/**
 * Ben's turn's deps: limits 1 to 6 passing (a core-only turn has no part to gate), his record and STOP run as
 * stop-recorded.json answers them, once per pass with the phone read at each pass's version (`reads`, one per pass), and
 * K-05 answering `answers` in order at the fixture's time.
 */
function benDeps(answers: readonly (CommitTurnAnswer | null)[], reads: readonly number[] = [3]): StopDeps {
  const k05 = k05Fake({ now: stopRecorded().outcome.committedAt, answers });
  const core = reads.flatMap((readVersion) => [benRecordRun(), benStopRun(readVersion)]);
  const { ports } = doublePorts({ core, k05 });
  return { limits: scriptedLimits(), ports, k05 };
}

/** Every console line written while a test runs (console.log, info, warn, error and debug), each argument as text. */
const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  const write = (...args: unknown[]): void => {
    lines.push(
      args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
          return JSON.stringify(arg);
        })
        .join(" "),
    );
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(write);
  }
});

afterEach(() => {
  // No log line holds a number (K-08 v1 README: never the raw number): the commit writes none of its own.
  expect(numberIn(lines, BEN)).toEqual([]);
  expect(numberIn(lines, ALEX)).toEqual([]);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
// buildCommitRequest

describe("buildCommitRequest asks K-05 v1.17 for every phones row by its handle id, on every request (build.ts default 9)", () => {
  /** One unit of the commit, with no answer. */
  const unit = (writes: UnitWrites): CommitUnit => ({ writes, answer: null });

  /** The request Ben's turn's commit builds from `units`. */
  function built(units: readonly CommitUnit[]): ReturnType<typeof buildCommitRequest> {
    const { request } = stopRecorded();
    if (request.turn === null) throw new Error(`${STOP_RECORDED} carries its turn`);
    return buildCommitRequest({
      turn: request.turn,
      zone: null,
      businessId: "biz-lees-barbershop",
      actor: { personId: "person-ben", roleAt: () => null },
      units,
    });
  }

  it("every request carries answerPhoneRowsBy handleId beside v1.1's three fields, whatever its units write, and K-05 v1.17 takes each", () => {
    expect(ANSWER_PHONE_ROWS_BY).toBe("handleId");
    const cases: [string, CommitUnit[]][] = [
      ["no unit", []],
      ["Ben's record and STOP: core actions alone", [unit(benRecordRun().writes), unit(benStopRun().writes)]],
      ["S1-02's walk: a part's state, question and reply", [unit(samKindsWrites())]],
      [
        "a part's effect row",
        [
          unit({
            ...noWrites({ step: "S1-02", choice: "All on the list" }),
            effects: { write: [effectAtCommit("effect-charge.json")], letGo: [] },
          }),
        ],
      ],
    ];
    for (const [what, units] of cases) {
      const request = built(units);
      expect(request.answerPhoneRowsBy, what).toBe("handleId");
      expect(Object.keys(request), what).toEqual(["turn", "versionsRead", "writes", "answerPhoneRowsBy"]);
      expect(contractChecks().k05("commitTurn.request", request), what).toEqual([]);
    }
  });

  it("the request still names Ben's phone by its number, as every request does (K-05 v1.17 item 71.4): what the turn read, the update's key and the reply's reads; rowsNamedBy names it so too", () => {
    const stop = benStopRun();
    const request = built([unit(benRecordRun().writes), unit(stop.writes)]);
    expect(request.versionsRead).toEqual([{ table: "phones", rowId: BEN, version: 3 }]);
    expect(request.writes.state.filter((write) => write.table === "phones")).toEqual([
      {
        op: "update",
        table: "phones",
        key: { number: BEN },
        expectVersion: 3,
        set: { stopped: true, stop_at: stopRecorded().request.now, chat_open: false },
      },
    ]);
    expect(request.writes.outboxRows.map((row) => row.versionsRead)).toEqual([
      [{ table: "phones", rowId: BEN, version: 4 }],
    ]);
    // No row the request names carries the handle id K-05 v1.17 answers the phone by: it is a name, never a key.
    expect(stringsIn(request.versionsRead)).not.toContain(BEN_HANDLE);
    expect(rowsNamedBy(stop.writes)).toContainEqual({ table: "phones", rowId: BEN });
    expect(rowsNamedBy(stop.writes)).not.toContainEqual({ table: "phones", rowId: BEN_HANDLE });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// stop-recorded.json through gateAndCommit

describe("stop-recorded.json through gateAndCommit, K-05 answering as v1.17's stop twin (T-1419)", () => {
  it("K-09's answer is the fixture's: `written` names Ben's phone by its handle id, kept although his STOP wrote it (the frozen fixture wins over commit.ts default 9)", async () => {
    const { request, outcome } = stopRecorded();
    const deps = benDeps([stopTwinAnswer()]);
    const answer = await gateAndCommit(copy(request), callContext(), deps);

    expect(answer).toEqual(outcome);
    expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
    expect((answer as Committed).written.written).toEqual([
      { table: "phones", rowId: BEN_HANDLE, version: stopAnswered().phoneVersion },
    ]);

    // One K-05 request, asking; its exchange holds to K-05 v1.17's handleIdExchange.
    expect(deps.k05.requests).toHaveLength(1);
    const [sent] = deps.k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(sent.answerPhoneRowsBy).toBe("handleId");
    expect(handleIdProblems(sent, stopTwinAnswer(), outcome.committedAt)).toEqual([]);
    // K-05's answer is the stop twin's shape: one phones row, by its handle id, at the version after the stop; the
    // stop reply; nothing promoted.
    const twin = stopTwin().outcome;
    if (!("result" in twin)) throw new Error("the stop twin commits");
    const shape = (answered: CommitTurnResponse | K05V1dot17.CommitTurnResponse): unknown => ({
      written: answered.committed.written.map((row) => [row.table, row.version]),
      outboxRows: answered.committed.outboxRows.length,
      promoted: answered.committed.promoted,
    });
    expect(shape(stopTwinAnswer())).toEqual(shape(twin));
    expect(twin.committed.written.map((row) => row.rowId)).toEqual([ALEX_HANDLE]);

    // The STOP's phones row by its number in the request and in rowsNamedBy, by its handle id in the answer: the core
    // filter (writtenOf) never matches it.
    expect(rowsNamedBy(benStopRun().writes)).toContainEqual({ table: "phones", rowId: BEN });
    expect(sent.writes.state.filter((write) => write.table === "phones")).toMatchObject([
      { op: "update", key: { number: BEN } },
    ]);
  });

  it("the call's span keeps Ben's phone by its handle id and his reply; no id it or K-09's answer names is number-shaped, and no string holds his number", async () => {
    const { request } = stopRecorded();
    const call = callContext();
    const answer = await gateAndCommit(copy(request), call, benDeps([stopTwinAnswer()]));
    const { replyId } = stopAnswered();

    expect(call.span.rows).toEqual([
      { table: "phones", id: BEN_HANDLE },
      { table: "outbox_rows", id: replyId },
    ]);
    for (const row of call.span.rows) expect(contractChecks().k08v1("rowRef", row), row.table).toEqual([]);
    const committed = answer as Committed;
    const named = [
      ...call.span.rows.map((row) => row.id),
      ...committed.written.written.map((row) => row.rowId),
      ...committed.written.outboxRows.map((row) => row.id),
    ];
    expect(notSafeIds(named)).toEqual([]);
    // The phones row is the row's own handle id, never a number wrapped in letters (T-1418's security review, 8a).
    expect(call.span.rows.filter((row) => row.table === "phones").map((row) => row.id)).toEqual([BEN_HANDLE]);
    expect(committed.written.written.filter((row) => row.table === "phones").map((row) => row.rowId)).toEqual(
      [BEN_HANDLE],
    );
    expect(numberIn(call.span, BEN)).toEqual([]);
    expect(numberIn(answer, BEN)).toEqual([]);
  });

  it("the schema the double is held to refuses v1.16's answer to a request that asks: Ben's phone answered by his number, written or changed", () => {
    const { request, outcome } = stopRecorded();
    const turn = request.turn;
    if (turn === null) throw new Error(`${STOP_RECORDED} carries its turn`);
    const sent = buildCommitRequest({
      turn,
      zone: null,
      businessId: "biz-lees-barbershop",
      actor: { personId: "person-ben", roleAt: () => null },
      units: [
        { writes: benRecordRun().writes, answer: null },
        { writes: benStopRun().writes, answer: null },
      ],
    });
    const byNumber = stopTwinAnswer();
    byNumber.committed.written = byNumber.committed.written.map((row) =>
      row.table === "phones" ? { ...row, rowId: BEN } : row,
    );
    expect(handleIdProblems(sent, byNumber, outcome.committedAt)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/outcome\/committed\/written\/0\/rowId /)]),
    );
    const changed = benPhoneChanged(3);
    const changedByNumber: CommitTurnError = {
      error: "versionChanged",
      changed: [{ table: "phones", rowId: BEN, readVersion: 3, currentVersion: 4 }],
    };
    expect(handleIdProblems(sent, changedByNumber, outcome.committedAt)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/outcome\/changed\/0\/rowId /)]),
    );
    // Its twins by handle id pass.
    expect(handleIdProblems(sent, stopTwinAnswer(), outcome.committedAt)).toEqual([]);
    expect(handleIdProblems(sent, changed, outcome.committedAt)).toEqual([]);
  });

  it("a repeat asks too, and K-05 answers it with its first commit, naming no phones row (K-05 v1.17 default 151)", async () => {
    const { request, outcome } = stopRecorded();
    const deps = benDeps([stopTwinAnswer()], [3, 3]);
    const first = await gateAndCommit(copy(request), callContext(), deps);
    const call = callContext();
    const again = await gateAndCommit(copy(request), call, deps);

    expect(first).toEqual(outcome);
    expect(again).toMatchObject({
      repeated: true,
      written: { written: [], outboxRows: outcome.written.outboxRows, promoted: [] },
    });
    expect(deps.k05.requests).toHaveLength(2);
    expect(deps.k05.requests[1]).toEqual(deps.k05.requests[0]);
    expect(deps.k05.requests.map((sent) => sent.answerPhoneRowsBy)).toEqual(["handleId", "handleId"]);
    expect(deps.k05.commits).toHaveLength(1);
    expect(call.span.rows).toEqual([]);
    expect(numberIn(again, BEN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A version conflict on a phones row

describe("a version conflict on a phones row names it by its handle id, and every request reads it by its number (T-1419)", () => {
  it("Ben's phone read at 2 and changed: the reload reads it anew, asks again and commits the fixture's outcome; neither request takes the handle id the answer named", async () => {
    const { request, outcome } = stopRecorded();
    const deps = benDeps([benPhoneChanged(2), stopTwinAnswer()], [2, 3]);
    const answer = await gateAndCommit(copy(request), callContext(), deps);

    expect(answer).toEqual(outcome);
    expect(deps.k05.requests.map((sent) => sent.versionsRead)).toEqual([
      [{ table: "phones", rowId: BEN, version: 2 }],
      [{ table: "phones", rowId: BEN, version: 3 }],
    ]);
    const answers = [benPhoneChanged(2), stopTwinAnswer()];
    deps.k05.requests.forEach((sent, index) => {
      expect(sent.answerPhoneRowsBy).toBe("handleId");
      expect(stringsIn(sent.versionsRead)).not.toContain(BEN_HANDLE);
      const answered = answers[index];
      if (answered === undefined) throw new Error("an answer per request");
      expect(handleIdProblems(sent, answered, outcome.committedAt)).toEqual([]);
    });
  });

  it("Ben's phone changed twice: stillChanged names handle-ben, never his number, and each request reads the phone as its pass read it", async () => {
    const { request, outcome } = stopRecorded();
    const deps = benDeps([benPhoneChanged(3), benPhoneChanged(4)], [3, 4]);
    const error = await gateAndCommit(copy(request), callContext(), deps).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CommitRefusedError);
    const refused = error as CommitRefusedError;
    expect(refused).toMatchObject({ fault: "stillChanged", ids: [BEN_HANDLE] });
    expect(refused.message).toBe(
      `gateAndCommit: the commit refused the turn (stillChanged: ${BEN_HANDLE}); nothing was written`,
    );
    expect(notSafeIds(refused.ids)).toEqual([]);
    expect(numberIn([refused.message, ...refused.ids], BEN)).toEqual([]);

    expect(deps.k05.requests.map((sent) => sent.versionsRead)).toEqual([
      [{ table: "phones", rowId: BEN, version: 3 }],
      [{ table: "phones", rowId: BEN, version: 4 }],
    ]);
    deps.k05.requests.forEach((sent, index) => {
      expect(sent.answerPhoneRowsBy).toBe("handleId");
      expect(stringsIn(sent.versionsRead)).not.toContain(BEN_HANDLE);
      expect(handleIdProblems(sent, benPhoneChanged(3 + index), outcome.committedAt)).toEqual([]);
    });
    expect(deps.k05.commits).toEqual([]);
  });

  it("for a turn at a business, through the Tool API base: Sam's turn that read Alex's phone, refused twice as commit-alex-phone-changed-handle-id.json answers, throws stillChanged naming handle-alex; nothing it throws, logs or traces holds Alex's number", async () => {
    const twin = phoneChangedTwin();
    const read = twin.request.versionsRead.find((row) => row.table === "phones");
    expect(read).toEqual({ table: "phones", rowId: ALEX, version: 3 });
    if (read === undefined || !("error" in twin.outcome))
      throw new Error("the twin reads Alex's phone, refused");
    const refusal = twin.outcome;
    expect(refusal).toEqual({
      error: "versionChanged",
      changed: [{ table: "phones", rowId: ALEX_HANDLE, readVersion: 3, currentVersion: 4 }],
    });
    // Sam's S1-02 turn (commit-s1-02.json's limits, its walk's writes and its core action), its decision resting on
    // Alex's phone as the twin's turn read it.
    const k05 = k05Fake({ answers: [refusal, refusal] });
    const ported = doublePorts({
      writes: { 0: { ...samKindsWrites(), versionsRead: [read] } },
      core: [s1_02CoreRun(), s1_02CoreRun()],
      k05,
    });
    const deps: CommitDeps = {
      limits: scriptedLimits(fixtureScript(gateExchange(S1_02))),
      ports: ported.ports,
    };
    const scope = recordingScope();
    const api = createToolApi({
      validator,
      scope,
      handlers: recordingHandlers("gateAndCommit", (given, context) =>
        gateAndCommit(given as GateRequest, context, deps),
      ),
    });
    const request = copy(gateExchange(S1_02).request);
    const { trace, spans } = traceFor(request);
    const error = await api.call("gateAndCommit", request, trace).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CommitRefusedError);
    const refused = error as CommitRefusedError;
    expect(refused).toMatchObject({ fault: "stillChanged", ids: [ALEX_HANDLE] });
    expect(notSafeIds(refused.ids)).toEqual([]);
    expect(numberIn([refused.message, ...refused.ids], ALEX)).toEqual([]);
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ outcome: "failed" });
    expect(numberIn(spans, ALEX)).toEqual([]);

    // Both requests ask, and read Alex's phone by its number, as Sam's walk read it: never by the handle id answered.
    expect(k05.requests).toHaveLength(2);
    for (const sent of k05.requests) {
      expect(sent.answerPhoneRowsBy).toBe("handleId");
      expect(sent.versionsRead).toEqual([read]);
      expect(handleIdProblems(sent, refusal, twin.given.now)).toEqual([]);
    }
    expect(k05.commits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A producer that ignores the field: gateAndCommit fails closed (commit.ts default 10)

/**
 * Ben's phone as a K-05 that ignores answerPhoneRowsBy names it: by his number as K-04 stores it (v1.16's answer), and in
 * other forms K-08 v1's safeId refuses (no plus, phone punctuation, a tel: prefix), each his whole number (555-01xx).
 */
const BEN_BY_NUMBER: readonly string[] = [BEN, "15555550131", "1-555-555-0131", "tel:+15555550131"];

/** stillChanged's message with no row named: what a version conflict naming a phones row by its number throws. */
const STILL_CHANGED_NO_ID = "gateAndCommit: the commit refused the turn (stillChanged); nothing was written";

/** stop-recorded.json's K-05 answer as a producer that ignores the field gives it: Ben's phone named `byNumber`. */
function stopAnsweredByNumber(byNumber: string, repeated = false): CommitTurnResponse {
  const answer = stopTwinAnswer();
  return {
    ...answer,
    repeated,
    committed: {
      ...answer.committed,
      written: answer.committed.written.map((row) =>
        row.table === "phones" ? { ...row, rowId: byNumber } : row,
      ),
    },
  };
}

/** The error a call threw, or a failure when it answered. */
async function thrownBy(call: Promise<unknown>): Promise<Error> {
  const thrown = await call.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof Error)) throw new Error("the call answered; it was to throw");
  return thrown;
}

describe("a K-05 that answers a phones row by its number, though every request asks for its handle id: gateAndCommit fails closed, naming no id (T-1419 round 2, DL-893)", () => {
  it("the double is the producer the rule is for: K-05 v1.17 refuses each of its answers, by every form of Ben's number, where it takes the same answer by handle id", () => {
    const { request, outcome } = stopRecorded();
    const turn = request.turn;
    if (turn === null) throw new Error(`${STOP_RECORDED} carries its turn`);
    const sent = buildCommitRequest({
      turn,
      zone: null,
      businessId: "biz-lees-barbershop",
      actor: { personId: "person-ben", roleAt: () => null },
      units: [
        { writes: benRecordRun().writes, answer: null },
        { writes: benStopRun().writes, answer: null },
      ],
    });
    for (const byNumber of BEN_BY_NUMBER) {
      const changed: CommitTurnError = {
        error: "versionChanged",
        changed: [{ table: "phones", rowId: byNumber, readVersion: 3, currentVersion: 4 }],
      };
      expect(
        handleIdProblems(sent, stopAnsweredByNumber(byNumber), outcome.committedAt),
        byNumber,
      ).not.toEqual([]);
      expect(handleIdProblems(sent, changed, outcome.committedAt), byNumber).not.toEqual([]);
      expect(notSafeIds([byNumber]), byNumber).not.toEqual([]);
    }
    expect(handleIdProblems(sent, stopAnsweredByNumber(BEN_HANDLE), outcome.committedAt)).toEqual([]);
  });

  it("K-05 commits Ben's STOP and names his phone by his number: gateAndCommit throws PHONE_ROW_BY_NUMBER after one request, and the span, the message and the console hold no id of his", async () => {
    const { request } = stopRecorded();
    expect(PHONE_ROW_BY_NUMBER).not.toContain(BEN_HANDLE);
    expect(PHONE_ROW_BY_NUMBER).not.toContain("nothing was written");
    for (const byNumber of BEN_BY_NUMBER) {
      for (const repeated of [false, true]) {
        const what = `${byNumber}${repeated ? ", a repeat" : ""}`;
        const deps = benDeps([stopAnsweredByNumber(byNumber, repeated)]);
        const call = callContext();
        const error = await thrownBy(gateAndCommit(copy(request), call, deps));

        expect(error, what).toBeInstanceOf(TypeError);
        expect(error.message, what).toBe(PHONE_ROW_BY_NUMBER);
        expect(numberIn([error.name, error.message], BEN), what).toEqual([]);
        expect(call.span.rows, what).toEqual([]);
        expect(
          deps.k05.requests.map((sent) => sent.answerPhoneRowsBy),
          what,
        ).toEqual(["handleId"]);
      }
    }
  });

  it("K-05 refuses Ben's commit, naming his changed phone by his number: stillChanged at once, with no id and no reload, though a reload would commit; K-05 wrote nothing", async () => {
    const { request } = stopRecorded();
    for (const byNumber of BEN_BY_NUMBER) {
      const changed: CommitTurnError = {
        error: "versionChanged",
        changed: [{ table: "phones", rowId: byNumber, readVersion: 3, currentVersion: 4 }],
      };
      // A second pass is scripted to commit (the phone read anew at 4, K-05 answering by handle id): none runs.
      const deps = benDeps([changed, stopTwinAnswer()], [3, 4]);
      const call = callContext();
      const error = await thrownBy(gateAndCommit(copy(request), call, deps));

      expect(error, byNumber).toBeInstanceOf(CommitRefusedError);
      expect(error, byNumber).toMatchObject({ fault: "stillChanged", ids: [] });
      expect(error.message, byNumber).toBe(STILL_CHANGED_NO_ID);
      expect(numberIn(error.message, BEN), byNumber).toEqual([]);
      expect(deps.k05.requests, byNumber).toHaveLength(1);
      expect(deps.k05.requests[0]?.answerPhoneRowsBy, byNumber).toBe("handleId");
      expect(deps.k05.commits, byNumber).toEqual([]);
      expect(call.span.rows, byNumber).toEqual([]);
    }
  });

  it("through the Tool API base, Sam's turn at the barbershop that read Alex's phone: changed or written by his number, the call fails closed and rolls back; no span, thrown message or log line holds his number", async () => {
    const twin = phoneChangedTwin();
    const read = twin.request.versionsRead.find((row) => row.table === "phones");
    const samTurn = gateExchange(S1_02).request.turn;
    if (read === undefined || samTurn === null) throw new Error("Sam's turn reads Alex's phone");
    const changedByNumber: CommitTurnError = {
      error: "versionChanged",
      changed: [{ table: "phones", rowId: ALEX, readVersion: 3, currentVersion: 4 }],
    };
    const writtenByNumber: CommitTurnResponse = {
      result: "committed",
      turnId: samTurn.id,
      committedAt: twin.given.now,
      repeated: false,
      committed: { written: [{ table: "phones", rowId: ALEX, version: 4 }], outboxRows: [], promoted: [] },
    };
    const cases: [CommitTurnAnswer, string, string, string[] | undefined][] = [
      [changedByNumber, "CommitRefusedError", STILL_CHANGED_NO_ID, []],
      [writtenByNumber, "TypeError", PHONE_ROW_BY_NUMBER, undefined],
    ];
    for (const [answer, name, message, ids] of cases) {
      const k05 = k05Fake({ answers: [answer] });
      const ported = doublePorts({
        writes: { 0: { ...samKindsWrites(), versionsRead: [read] } },
        core: [s1_02CoreRun(), s1_02CoreRun()],
        k05,
      });
      const deps: CommitDeps = {
        limits: scriptedLimits(fixtureScript(gateExchange(S1_02))),
        ports: ported.ports,
      };
      const scope = recordingScope();
      const api = createToolApi({
        validator,
        scope,
        handlers: recordingHandlers("gateAndCommit", (given, context) =>
          gateAndCommit(given as GateRequest, context, deps),
        ),
      });
      const request = copy(gateExchange(S1_02).request);
      const { trace, spans } = traceFor(request);
      const error = await thrownBy(api.call("gateAndCommit", request, trace));

      expect(error.name, name).toBe(name);
      expect(error.message, name).toBe(message);
      expect((error as { ids?: unknown }).ids, name).toEqual(ids);
      expect(scope.events.at(-1), name).toEqual({ what: "rollback" });
      expect(spans, name).toHaveLength(1);
      expect(spans[0], name).toMatchObject({ outcome: "failed", error_code: name });
      expect(numberIn([spans, error.message], ALEX), name).toEqual([]);
      expect(k05.requests, name).toHaveLength(1);
      const [sent] = k05.requests;
      if (sent === undefined) throw new Error("one commit was sent");
      expect(sent.answerPhoneRowsBy, name).toBe("handleId");
      expect(handleIdProblems(sent, answer, twin.given.now), name).not.toEqual([]);
    }
  });
});
