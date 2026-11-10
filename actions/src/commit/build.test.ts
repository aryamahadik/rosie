// T-1150: the commit writes K-05's turn row with K-05 v1's seven fields alone (K-09 v1.5 default 135; ADR-013 section 6,
// the T-1139 note). commit-s1-01.json's request turn carries the service and the Linq chat id of the turn's last text:
// they reach the commit's walk through CommitTurnContext.request, and never K-05's closed turn, an event-log entry's
// values, the call's span or answer, a log line or an error's message; the chat id's one home is the thread's
// linq_chat_id (K-04 threads). Through the Tool API base with its K-09 v1.5 validator, the gate's scripted limits (never
// the stubs changed) and the commit's port doubles (test-support.ts), the walk's double handing over the rows
// commit-s1-01.json's given.stated.writes states (default 136). Values come only from the contracts' fixtures (rule 9).

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Span } from "../../../runtime/src/trace";
import { copy, decidedOf, fixtureScript, gateExchange, scriptedLimits } from "../gate/framework/test-support";
import type { GateRequest, SetupKey } from "../gate/framework";
import { createToolApi, createToolApiValidator } from "../tool-api";
import {
  contractFile,
  recordingHandlers,
  recordingScope,
  stringsIn,
  traceFor,
} from "../tool-api/test-support";
import { buildCommitRequest, k05TurnRow } from "./build";
import { gateAndCommit } from "./commit";
import { CommitRefusedError } from "./errors";
import { contractChecks, doublePorts, eventLogRowsOf, k05Fake, noWrites, whyOfChoice } from "./test-support";
import type {
  CommitDeps,
  CommitPorts,
  CommitTurnAnswer,
  CommitTurnContext,
  CommitTurnRequest,
  CoreRun,
  OpenQuestionNew,
  OutboxRowNew,
  StateWrite,
  TurnRow,
  UnitWrites,
} from "./types";

const validator = createToolApiValidator();

type Json = Record<string, unknown>;

const S1_01 = "commit-s1-01.json";

/** The Linq chat id commit-s1-01.json's turn carries (K-06 text-imessage.json's form): its one home is the thread's row. */
const CHAT_ID = "linq-chat-demo-sam";

/** K-05 v1's `turn` (contracts/data-access/data-access.v1.schema.json), as the schema states it. */
const K05_TURN = (
  contractFile("data-access/data-access.v1.schema.json") as {
    $defs: { turn: { properties: Json; required: string[]; additionalProperties: boolean } };
  }
).$defs.turn;
const K05_TURN_FIELDS = Object.keys(K05_TURN.properties);

/** What commit-s1-01.json's given states (K-09 v1.5 gateAndCommit.given, statedWrites: default 136). */
interface StatedS101 {
  step: string;
  gives: SetupKey[];
  writes: { state: StateWrite[]; openQuestions: OpenQuestionNew[]; outboxRows: OutboxRowNew[] };
}

function stated(): StatedS101 {
  return (contractFile(`tool-api/fixtures/${S1_01}`) as { given: { stated: StatedS101 } }).given.stated;
}

/** commit-s1-01.json's request turn: K-09 v1.5 gateAndCommit.turn, K-05's seven fields with the service and chat id. */
function requestTurn(): TurnRow & { service?: unknown; chatId?: unknown } {
  const { turn } = gateExchange(S1_01).request;
  if (turn === null) throw new Error("commit-s1-01.json carries a turn");
  return turn;
}

/** S1-02's safe default as bundle v0 writes its card (contracts/bundle/fixtures/bundle-v0-skeleton.json). */
function s102SafeDefault(): string {
  const bundle = contractFile("bundle/fixtures/bundle-v0-skeleton.json") as {
    flows: { A: { steps: Record<string, { card: { safeDefault: string } }> } };
  };
  return bundle.flows.A.steps["S1-02"]?.card.safeDefault ?? "";
}

/**
 * What S1-01's walk hands the commit (the walk is T-1139's; this is its double), as commit-s1-01.json's
 * given.stated.writes states it: S1-01's thread (its linq_chat_id the turn's chat id), S1-02's question with its card's
 * safe default, and the reply's outbox row; it gives thread. The thread's own event-log entry is the walk's (default
 * 135: new values {"kind": "chat"}), so the double hands none.
 */
function s101Writes(): UnitWrites {
  const { writes, gives } = stated();
  const [choice] = decidedOf(gateExchange(S1_01)).context.choices;
  return {
    ...noWrites(whyOfChoice(choice)),
    state: writes.state,
    asks: writes.openQuestions.map((question) => ({ question, safeDefault: s102SafeDefault() })),
    messages: writes.outboxRows,
    gives,
  };
}

/** Sam's text's safety outcome, No, as commit-s1-01.json answers it: writing nothing in the commit's lists. */
function s101CoreRun(): CoreRun {
  const { outcome } = gateExchange(S1_01);
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error("commit-s1-01 commits");
  const [first] = outcome.core;
  if (first === undefined) throw new Error("commit-s1-01 carries one core action");
  return { result: first, writes: noWrites({ step: "A3-22", choice: null }) };
}

interface S101Deps extends CommitDeps {
  readonly k05: ReturnType<typeof k05Fake>;
  /** The turn each writesOf call was handed (CommitTurnContext), in order. */
  readonly contexts: CommitTurnContext[];
}

/** S1-01's turn as commit-s1-01.json states it: limits as its outcome logs them, the walk's writes, its core action. */
function s101Deps(answers: readonly (CommitTurnAnswer | null)[] = []): S101Deps {
  const exchange = gateExchange(S1_01);
  const k05 = k05Fake({ now: exchange.given.now, answers });
  const ported = doublePorts({ writes: { 0: s101Writes() }, core: [s101CoreRun()], k05 });
  const contexts: CommitTurnContext[] = [];
  const ports: CommitPorts = {
    ...ported.ports,
    writesOf(part, turn, open) {
      contexts.push(turn);
      return ported.ports.writesOf(part, turn, open);
    },
  };
  return { ports, limits: scriptedLimits(fixtureScript(exchange)), k05, contexts };
}

interface Called {
  answer: { ok: true; value: unknown } | { ok: false; error: unknown };
  spans: Span[];
}

/** One gateAndCommit call through the Tool API base, its handler the commit with `deps`. */
async function callCommit(request: unknown, deps: CommitDeps): Promise<Called> {
  const handlers = recordingHandlers("gateAndCommit", (given, context) =>
    gateAndCommit(given as GateRequest, context, deps),
  );
  const api = createToolApi({ validator, scope: recordingScope(), handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("gateAndCommit", request, trace).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { answer, spans };
}

/** The JSON pointer of every string in `value` that holds `needle`. */
function placesHolding(value: unknown, needle: string, at = ""): string[] {
  if (typeof value === "string") return value.includes(needle) ? [at] : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) => placesHolding(item, needle, `${at}/${String(index)}`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => placesHolding(item, needle, `${at}/${key}`));
  }
  return [];
}

/** Every console line written while `run` runs (console.log, info, warn, error and debug), each argument as text. */
async function consoleLinesOf(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const write = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(write);
  }
  await run();
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
// buildCommitRequest: the turn row

describe("buildCommitRequest writes K-05's turn row with K-05 v1's seven fields alone (K-09 v1.5 default 135)", () => {
  it("K-05 v1's turn is closed, with seven fields; commit-s1-01.json's request turn has them, its service and chat id", () => {
    expect(K05_TURN_FIELDS).toEqual([
      "id",
      "handleId",
      "eventIds",
      "bundleId",
      "traceId",
      "joinedTraceIds",
      "tries",
    ]);
    expect(K05_TURN.required).toEqual(K05_TURN_FIELDS);
    expect(K05_TURN.additionalProperties).toBe(false);
    expect(Object.keys(requestTurn())).toEqual([...K05_TURN_FIELDS, "service", "chatId"]);
  });

  it("k05TurnRow keeps exactly K-05's seven fields of the request's turn, in K-05's order, and leaves the turn as it was", () => {
    const turn = requestTurn();
    const row = k05TurnRow(turn);
    expect(Object.keys(row)).toEqual(K05_TURN_FIELDS);
    for (const field of K05_TURN_FIELDS) {
      expect(row[field as keyof TurnRow], field).toEqual(turn[field as keyof TurnRow]);
    }
    expect(row).not.toHaveProperty("service");
    expect(row).not.toHaveProperty("chatId");
    expect(turn).toMatchObject({ service: "imessage", chatId: CHAT_ID });
    expect(contractChecks().k05("turn", row)).toEqual([]);
  });

  it("on commit-s1-01.json's request: K-05 v1.1 takes the request, and the chat id is only the thread's linq_chat_id", () => {
    const built = buildCommitRequest({
      turn: requestTurn(),
      zone: "America/New_York",
      businessId: "biz-lees-barbershop",
      actor: { personId: "person-sam", roleAt: () => null },
      units: [
        { writes: s101CoreRun().writes, answer: null },
        { writes: s101Writes(), answer: null },
      ],
    });
    expect(Object.keys(built.turn)).toEqual(K05_TURN_FIELDS);
    expect(contractChecks().k05("commitTurn.request", built)).toEqual([]);
    // The request's turn as it came, which T-305's commit copied: K-05's closed turn refuses it.
    const asItCame: CommitTurnRequest = { ...built, turn: requestTurn() };
    expect(contractChecks().k05("commitTurn.request", asItCame)).toEqual(
      expect.arrayContaining([
        "/turn must NOT have additional properties (service)",
        "/turn must NOT have additional properties (chatId)",
      ]),
    );
    // The chat id's one home is the thread's row; no event-log entry's values hold it.
    expect(placesHolding(built, CHAT_ID)).toEqual(["/writes/state/0/values/linq_chat_id"]);
    expect(built.writes.state[0]).toMatchObject({ table: "threads", values: { linq_chat_id: CHAT_ID } });
    expect(built.writes.events.length).toBeGreaterThan(0);
    for (const entry of built.writes.events) expect(stringsIn(entry), entry.id).not.toContain(CHAT_ID);
    for (const row of eventLogRowsOf(built, "2026-10-19T18:05:05Z")) {
      expect(contractChecks().k08("eventLogRow", row), String(row.id)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// commit-s1-01.json through the Tool API

describe("commit-s1-01.json through the Tool API: K-09 v1.5's validator passes it and the commit writes K-05's turn row", () => {
  it("the commit answers exactly the fixture's outcome, and the turn's service and chat id reach CommitTurnContext.request", async () => {
    const exchange = gateExchange(S1_01);
    expect(validator.check("gateAndCommit", "request", exchange.request)).toEqual([]);
    const deps = s101Deps();
    const called = await callCommit(copy(exchange.request), deps);

    expect(called.answer).toEqual({ ok: true, value: exchange.outcome });
    expect(deps.contexts).toHaveLength(1);
    expect(deps.contexts[0]?.request.turn).toMatchObject({ service: "imessage", chatId: CHAT_ID });

    // One K-05 request (the fake holds it to K-05 v1.1, whose turn is closed), its turn row K-05's seven fields.
    expect(deps.k05.requests).toHaveLength(1);
    const [sent] = deps.k05.requests;
    if (sent === undefined) throw new Error("no request");
    expect(Object.keys(sent.turn)).toEqual(K05_TURN_FIELDS);
    expect(sent.turn).toEqual(k05TurnRow(requestTurn()));
    expect(contractChecks().k05("commitTurn.request", sent)).toEqual([]);
    expect(placesHolding(sent, CHAT_ID)).toEqual(["/writes/state/0/values/linq_chat_id"]);
  });

  it("no span, log line, event-log entry's values or answer holds the chat id", async () => {
    const exchange = gateExchange(S1_01);
    const deps = s101Deps();
    let called: Called | undefined;
    const lines = await consoleLinesOf(async () => {
      called = await callCommit(copy(exchange.request), deps);
    });
    if (called === undefined) throw new Error("no call");
    expect(called.answer.ok).toBe(true);
    expect(placesHolding(called.answer, CHAT_ID)).toEqual([]);

    const [span] = called.spans;
    expect(called.spans).toHaveLength(1);
    expect(validator.checkSpan(span)).toEqual([]);
    expect(placesHolding(called.spans, CHAT_ID)).toEqual([]);
    expect(span?.rows).toEqual([
      { table: "threads", id: "thread-s1-01-sam-1" },
      { table: "open_questions", id: "oq-s1-02-sam-1" },
      { table: "clock_rows", id: "clock-oq-s1-02-sam-1" },
      { table: "outbox_rows", id: "outbox-s1-02-sam-1" },
    ]);

    const [sent] = deps.k05.requests;
    if (sent === undefined) throw new Error("no request");
    for (const entry of sent.writes.events) {
      expect(placesHolding([entry.oldValues, entry.newValues], CHAT_ID), entry.id).toEqual([]);
    }
    expect(lines.filter((line) => line.includes(CHAT_ID))).toEqual([]);
  });

  it("a turn with the chat id and no service is refused before the commit runs, and nothing holds the chat id", async () => {
    const request = copy(gateExchange(S1_01).request) as unknown as Json & { turn: Json };
    delete request.turn.service;
    const deps = s101Deps();
    let called: Called | undefined;
    const lines = await consoleLinesOf(async () => {
      called = await callCommit(request, deps);
    });
    if (called === undefined) throw new Error("no call");
    expect(called.answer).toMatchObject({
      ok: true,
      value: { error: "invalidRequest", call: "gateAndCommit" },
    });
    const refusal = (called.answer as { value: { problems: string[] } }).value;
    expect(refusal.problems).toContain("/turn must have property service when property chatId is present");
    expect(deps.contexts).toEqual([]);
    expect(deps.k05.requests).toEqual([]);
    expect(placesHolding(called, CHAT_ID)).toEqual([]);
    expect(lines.filter((line) => line.includes(CHAT_ID))).toEqual([]);
  });

  it("a commit that fails closed throws with no chat id in its message, and its span holds none", async () => {
    const exchange = gateExchange(S1_01);
    const deps = s101Deps([
      { error: "wrongState", table: "outbox_rows", rowId: "outbox-s1-02-sam-1", state: "planned" },
    ]);
    let called: Called | undefined;
    const lines = await consoleLinesOf(async () => {
      called = await callCommit(copy(exchange.request), deps);
    });
    if (called === undefined || called.answer.ok) throw new Error("the commit should have thrown");
    const { error } = called.answer;
    expect(error).toBeInstanceOf(CommitRefusedError);
    expect((error as Error).message).not.toContain(CHAT_ID);
    expect(placesHolding(called.spans, CHAT_ID)).toEqual([]);
    expect(called.spans[0]).toMatchObject({ outcome: "failed" });
    expect(lines.filter((line) => line.includes(CHAT_ID))).toEqual([]);
  });
});
