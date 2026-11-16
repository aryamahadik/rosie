// T-1414's proofs for the fixed-lines service (the card's "Proves it with", with its lead notes, DL-864 and DL-871,
// which bind it): sendFixedLine in a turn, on T-317's in-memory reads of the frozen contracts' seeds as the runtime
// side reads them (doubles for the reads only, never for the service under test), never a database:
//   - HELP to a phone that is not stopped gives one quick_reply row, no business, the answer {outboxRowId, repeated
//     false} valid against K-09 v1 sendFixedLine.response, the row valid against K-05 v1.1 outboxRowNew;
//   - a stopped phone answers phoneStopped, valid against K-09 v1 sendFixedLine.errors, and nothing is written;
//   - the same action twice gives the same writes; two HELPs of one turn in one commit write one row, the second
//     answering the first's as repeated (DL-871);
//   - only HELP's reply rides in a turn, to the turn's own handle; a call made alone answers notBuilt (CQ-44);
//   - nothing logs, and no answer, row or refusal carries a number, an address or anyone's words.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { CommitTurnContext, CoreRun } from "../../commit";
import { NotBuiltError, createToolApiValidator } from "../../tool-api";
import { callContext } from "../../gate/framework/test-support";
import {
  flagsSeedRecord,
  k05Problems,
  messagesReaderOn,
  phoneRow,
  stringsIn,
  withPhones,
  worldOf,
  type World,
} from "../flags/test-support";
import type { MessagesReader } from "../messages-consent";
import {
  FixedLineRefusedError,
  HELP_REPLY,
  HELP_STEP,
  TURN_LINES,
  fixedLineKey,
  fixedLineRowId,
  planSendFixedLine,
  sendFixedLineAlone,
  sendFixedLineCore,
  sendFixedLineHandler,
  sendsInTurn,
  sentEarlierInTurn,
  turnLineOf,
  type FixedLineAction,
  type FixedLineDeps,
} from "./index";
import { contextOf, fixedLineActionsOf, helpAction, keywordCaller, keywordTurn } from "./test-support";

const validator = createToolApiValidator();

/** The turns this file's HELPs ride in. */
const ALEX_TURN = "turn-alex-help";
const BEN_TURN = "turn-ben-help";

/** A HELP turn of one person on one handle: one HELP action per text, each the request's own object. */
function helpTurn(input: {
  readonly turnId: string;
  readonly personId: string | null;
  readonly handleId: string;
  readonly helps?: number;
  readonly recipient?: string;
}): { context: CommitTurnContext; actions: FixedLineAction[] } {
  const caller = keywordCaller(input.turnId, input.personId);
  const helps = input.helps ?? 1;
  const eventIds = Array.from({ length: helps }, (_, at) => `evt-${input.turnId}-${String(at + 1)}`);
  const request = keywordTurn({
    caller,
    handleId: input.handleId,
    eventIds,
    core: eventIds.map(() => helpAction(caller, input.recipient ?? input.handleId)),
  });
  return { context: contextOf(request), actions: fixedLineActionsOf(request) };
}

/** The reads as the wiring's flags port binds them: T-307's, on the runtime side (no business scope). */
function readsOn(world: World): FixedLineDeps<unknown> {
  return { messagesReader: () => messagesReaderOn(world, null) };
}

/** A reader that must never be read: each read throws. */
function unread(): never {
  throw new Error("nothing is read for a call that does not run");
}

const UNREAD: MessagesReader = {
  person: unread,
  handleIdsOfPerson: unread,
  handle: unread,
  phoneOfHandle: unread,
  chatThreadOf: unread,
  consentsOfPersons: unread,
};

/** The one action of a one-HELP turn. */
function onlyAction(actions: readonly FixedLineAction[]): FixedLineAction {
  const [action, ...more] = actions;
  if (action === undefined || more.length > 0) throw new Error("one HELP");
  return action;
}

/** The answer a run gave as its response, held to K-09 v1's sendFixedLine.response. */
function responseOf(run: CoreRun): { outboxRowId: string | null; repeated: boolean } {
  const { result } = run;
  if (result.call !== "sendFixedLine" || result.response === null) {
    throw new Error(`not written: ${JSON.stringify(result.error)}`);
  }
  expect(validator.check("sendFixedLine", "response", result.response)).toEqual([]);
  return result.response;
}

let warn: MockInstance;
let log: MockInstance;
let error: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Nothing the service does writes a log line (K-08 v1: never a person's words, a number or an address).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("HELP to a phone that is not stopped: one quick_reply row, no business (K-09 v1 sendFixedLine; RULES 7.6)", () => {
  it("Alex's HELP in his keyword turn gives one quick_reply row back to his phone, and answers {outboxRowId, repeated false}", async () => {
    const world = worldOf(flagsSeedRecord());
    const { context, actions } = helpTurn({
      turnId: ALEX_TURN,
      personId: "person-alex",
      handleId: "handle-alex",
    });
    const action = onlyAction(actions);
    expect(sendsInTurn(action.request)).toBe(true);
    const run = await sendFixedLineCore(action, context, readsOn(world));
    const rowId = await fixedLineRowId(fixedLineKey(ALEX_TURN, action.request));
    // The row's id carries no key, number or name: a K-08 v1 safe id.
    expect(rowId).toMatch(/^out-fixed-line-[0-9a-f]{32}$/u);
    expect(run.result).toEqual({
      call: "sendFixedLine",
      response: { outboxRowId: rowId, repeated: false },
      error: null,
    });
    expect(responseOf(run)).toEqual({ outboxRowId: rowId, repeated: false });
    // One row of the request's send class to the handle the text came from, on its chat's service: no business (Rosie's
    // own line, for every business), no booking, no question, no copy, no versions read, and no words (no plan).
    expect(run.writes.messages).toEqual([
      {
        id: rowId,
        recipientHandleId: "handle-alex",
        recipientPersonId: "person-alex",
        businessId: null,
        bookingId: null,
        channel: "imessage",
        sendClass: "quick_reply",
        openQuestionId: null,
        copyOfRowId: null,
        versionsRead: [],
      },
    ]);
    const [row] = run.writes.messages;
    expect(k05Problems("outboxRowNew", row)).toEqual([]);
    // The row is all it writes, under the stop home's step; no state, question, clock or effect.
    expect(run.writes.why).toEqual({ step: HELP_STEP, choice: null });
    expect(HELP_STEP).toBe("S13-32");
    expect(run.writes.state).toEqual([]);
    expect(run.writes.stateEvents).toEqual([]);
    expect(run.writes.asks).toEqual([]);
    expect(run.writes.closes).toEqual([]);
    expect(run.writes.clockCancels).toEqual([]);
    expect(run.writes.reservations).toEqual({ confirm: [], release: [] });
    expect(run.writes.effects).toEqual({ write: [], letGo: [] });
    expect(run.writes.gives).toEqual([]);
    expect(run.writes).not.toHaveProperty("clocks");
  });

  it("the row goes on the chat's own service, and names no person for a handle the caller is not behind", async () => {
    const world = worldOf(flagsSeedRecord());
    // Tomás's chat is RCS (K-04 seed-phone-chat-open.json); his turn's caller knows no person yet.
    const tomas = helpTurn({ turnId: "turn-tomas-help", personId: null, handleId: "handle-tomas" });
    const run = await sendFixedLineCore(onlyAction(tomas.actions), tomas.context, readsOn(world));
    expect(
      run.writes.messages.map((row) => [row.recipientHandleId, row.recipientPersonId, row.channel]),
    ).toEqual([["handle-tomas", null, "rcs"]]);
    // A caller naming a person who is not behind the handle: the row names nobody (default 3).
    const other = helpTurn({ turnId: "turn-tomas-help-2", personId: "person-sam", handleId: "handle-tomas" });
    const named = await sendFixedLineCore(onlyAction(other.actions), other.context, readsOn(world));
    expect(named.writes.messages.map((row) => row.recipientPersonId)).toEqual([null]);
  });

  it("a HELP by email goes back by email, to the address it came from (default 6)", async () => {
    const world = worldOf(flagsSeedRecord());
    const { context, actions } = helpTurn({
      turnId: "turn-alex-email-help",
      personId: "person-alex",
      handleId: "handle-alex-email",
    });
    const run = await sendFixedLineCore(onlyAction(actions), context, readsOn(world));
    expect(responseOf(run).repeated).toBe(false);
    expect(
      run.writes.messages.map((row) => [row.recipientHandleId, row.channel, row.businessId, row.copyOfRowId]),
    ).toEqual([["handle-alex-email", "email", null, null]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a stopped phone answers phoneStopped, and nothing is written (RULES 7.2; MC C1)", () => {
  it("Ben's stopped phone: phoneStopped naming his handle, valid against K-09 v1, and no row; the plan refuses it whatever the send class", async () => {
    const world = worldOf(flagsSeedRecord());
    const { context, actions } = helpTurn({
      turnId: BEN_TURN,
      personId: "person-ben",
      handleId: "handle-ben",
    });
    const action = onlyAction(actions);
    const run = await sendFixedLineCore(action, context, readsOn(world));
    expect(run.result).toEqual({
      call: "sendFixedLine",
      response: null,
      error: { error: "phoneStopped", recipientHandleId: "handle-ben" },
    });
    expect(validator.check("sendFixedLine", "errors", run.result.error)).toEqual([]);
    expect(run.writes.messages).toEqual([]);
    expect(run.writes.state).toEqual([]);
    // The plan holds the stop for every send class, safety included: only stop replies and safety lines go, and this
    // call sends neither (K-09 sendFixedLine.errors).
    for (const sendClass of ["quick_reply", "safety", "routine", "visit_now"] as const) {
      const plan = await planSendFixedLine(
        {
          request: { ...action.request, sendClass },
          turn: { id: BEN_TURN, handleId: "handle-ben" },
          sentEarlier: false,
        },
        { messages: messagesReaderOn(world, null) },
      );
      expect(plan.answer, sendClass).toEqual({ error: "phoneStopped", recipientHandleId: "handle-ben" });
      expect(plan.row, sendClass).toBeNull();
    }
  });

  it("once START lifts the stop, the same phone gets its HELP row", async () => {
    const world = worldOf(flagsSeedRecord());
    world.record = withPhones(world.record, [
      phoneRow("handle-ben", "+15555550106", {
        chatOpen: true,
        chatOpenAt: new Date("2026-10-05T17:00:00Z"),
        chatWay: "imessage",
      }),
    ]);
    const { context, actions } = helpTurn({
      turnId: BEN_TURN,
      personId: "person-ben",
      handleId: "handle-ben",
    });
    const run = await sendFixedLineCore(onlyAction(actions), context, readsOn(world));
    expect(responseOf(run).outboxRowId).not.toBeNull();
    expect(run.writes.messages.map((row) => [row.recipientHandleId, row.sendClass])).toEqual([
      ["handle-ben", "quick_reply"],
    ]);
  });

  it("the flag is read only through the reader it is given: with none, the call is not built and nothing is read", async () => {
    const { context, actions } = helpTurn({
      turnId: BEN_TURN,
      personId: "person-ben",
      handleId: "handle-ben",
    });
    const refused = await sendFixedLineCore(onlyAction(actions), context, {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(refused).toBeInstanceOf(NotBuiltError);
    expect(refused).toMatchObject({ call: "sendFixedLine" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a handle not there, or a chat not open, gets no row (defaults 4 and 5)", () => {
  it("a handle that does not exist answers notFound (handles); a phone handle with no phone row notFound (phones), by its handle id", async () => {
    const seeds = flagsSeedRecord();
    const nobody = helpTurn({ turnId: "turn-nobody-help", personId: null, handleId: "handle-nobody" });
    const missing = await sendFixedLineCore(
      onlyAction(nobody.actions),
      nobody.context,
      readsOn(worldOf(seeds)),
    );
    expect(missing.result.error).toEqual({ error: "notFound", table: "handles", rowId: "handle-nobody" });
    expect(validator.check("sendFixedLine", "errors", missing.result.error)).toEqual([]);
    expect(missing.writes.messages).toEqual([]);
    // Alex's handle with its phone row gone: named by its handle id, never its number (K-08 v1).
    const noPhone = worldOf({
      ...seeds,
      phones: seeds.phones.filter((phone) => phone.handleId !== "handle-alex"),
    });
    const alex = helpTurn({ turnId: ALEX_TURN, personId: "person-alex", handleId: "handle-alex" });
    const run = await sendFixedLineCore(onlyAction(alex.actions), alex.context, readsOn(noPhone));
    expect(run.result.error).toEqual({ error: "notFound", table: "phones", rowId: "handle-alex" });
    expect(validator.check("sendFixedLine", "errors", run.result.error)).toEqual([]);
    expect(run.writes.messages).toEqual([]);
  });

  it("a phone whose chat is not open gets no row (MC C9: Rosie never writes first): outboxRowId null, nothing written", async () => {
    const world = worldOf(flagsSeedRecord());
    // Pat's phone has never texted Rosie's number (K-29 seed-chat-link.json: chat_open false).
    const { context, actions } = helpTurn({
      turnId: "turn-pat-help",
      personId: "person-pat",
      handleId: "handle-pat",
    });
    const run = await sendFixedLineCore(onlyAction(actions), context, readsOn(world));
    expect(responseOf(run)).toEqual({ outboxRowId: null, repeated: false });
    expect(run.writes.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("once per text: the caller's turn is the key, with the line and the recipient (K-09 v1; DL-871)", () => {
  it("the same action twice gives the same writes", async () => {
    const world = worldOf(flagsSeedRecord());
    const { context, actions } = helpTurn({
      turnId: ALEX_TURN,
      personId: "person-alex",
      handleId: "handle-alex",
    });
    const action = onlyAction(actions);
    const first = await sendFixedLineCore(action, context, readsOn(world));
    const again = await sendFixedLineCore(action, contextOf(context.request), readsOn(world));
    expect(again).toEqual(first);
    expect(first.writes.messages).toHaveLength(1);
  });

  it("two HELPs of one turn in one commit: the first writes the row; the second answers it as repeated and writes nothing", async () => {
    const world = worldOf(flagsSeedRecord());
    const { context, actions } = helpTurn({
      turnId: ALEX_TURN,
      personId: "person-alex",
      handleId: "handle-alex",
      helps: 2,
    });
    const [first, second] = actions;
    if (first === undefined || second === undefined) throw new Error("two HELPs");
    // Two texts, two actions equal in every field, each its own object in the request.
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(sentEarlierInTurn(first, context)).toBe(false);
    expect(sentEarlierInTurn(second, context)).toBe(true);
    const runs: CoreRun[] = [];
    for (const action of actions) runs.push(await sendFixedLineCore(action, context, readsOn(world)));
    const rowId = await fixedLineRowId(fixedLineKey(ALEX_TURN, first.request));
    expect(runs.map(responseOf)).toEqual([
      { outboxRowId: rowId, repeated: false },
      { outboxRowId: rowId, repeated: true },
    ]);
    expect(runs.map((run) => run.writes.messages.map((row) => row.id))).toEqual([[rowId], []]);
  });

  it("each key is its own: another turn, line or recipient is another row; an action the request does not hold has nothing before it", async () => {
    const { context, actions } = helpTurn({
      turnId: ALEX_TURN,
      personId: "person-alex",
      handleId: "handle-alex",
      helps: 2,
    });
    const [first, second] = actions;
    if (first === undefined || second === undefined) throw new Error("two HELPs");
    const key = fixedLineKey(ALEX_TURN, first.request);
    expect(fixedLineKey("turn-alex-later", first.request)).not.toBe(key);
    expect(fixedLineKey(ALEX_TURN, { ...first.request, recipientHandleId: "handle-alex-email" })).not.toBe(
      key,
    );
    expect(fixedLineKey(ALEX_TURN, { ...first.request, fixedLineId: "outage" })).not.toBe(key);
    const ids = await Promise.all(
      ["turn-alex-later", ALEX_TURN].map((turnId) => fixedLineRowId(fixedLineKey(turnId, first.request))),
    );
    expect(new Set(ids).size).toBe(2);
    // A copy of the second HELP is not the request's own: nothing stands before it, so it is no repeat.
    expect(sentEarlierInTurn(structuredClone(second), context)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("only HELP's reply rides in a turn, to the turn's own handle (defaults 1 and 2)", () => {
  it("a line other than HELP's, HELP in another send class, or a request carrying the actor's send, is not built: NotBuiltError before anything is read", async () => {
    const { context, actions } = helpTurn({
      turnId: ALEX_TURN,
      personId: "person-alex",
      handleId: "handle-alex",
    });
    const action = onlyAction(actions);
    expect(sendsInTurn(action.request)).toBe(true);
    expect(TURN_LINES.get(HELP_REPLY)).toEqual({ step: HELP_STEP, sendClass: "quick_reply" });
    const outage = structuredClone(action);
    outage.request.fixedLineId = "outage";
    const sent = structuredClone(action);
    sent.request.sentByActor = {
      at: "2026-10-21T19:30:05Z",
      fixedLineId: HELP_REPLY,
      linqMessageId: "linq-msg-alex-help",
    };
    // A safety-class HELP would pass a STOP in the same commit (limit 8 sends every safety row to a stopped phone).
    const classed = (["safety", "routine", "visit_now"] as const).map((sendClass) => {
      const each = structuredClone(action);
      each.request.sendClass = sendClass;
      return [sendClass, each] as const;
    });
    for (const [label, each] of [["outage", outage] as const, ["sentByActor", sent] as const, ...classed]) {
      expect(sendsInTurn(each.request), label).toBe(false);
      expect(turnLineOf(each.request), label).toBeNull();
      const refused = await sendFixedLineCore(each, context, { messagesReader: () => UNREAD }).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused, label).toBeInstanceOf(NotBuiltError);
      expect(refused, label).toMatchObject({ call: "sendFixedLine" });
    }
  });

  it("a recipient that is not the turn's handle is refused before anything is read (notTheTurnsHandle), naming no value", async () => {
    const { context, actions } = helpTurn({
      turnId: ALEX_TURN,
      personId: "person-alex",
      handleId: "handle-alex",
      recipient: "handle-sam",
    });
    // Refused before the reader is even made: making it throws here.
    const refused = await sendFixedLineCore(onlyAction(actions), context, { messagesReader: unread }).catch(
      (thrown: unknown) => thrown,
    );
    expect(refused).toBeInstanceOf(FixedLineRefusedError);
    expect(refused).toMatchObject({ fault: "notTheTurnsHandle" });
    expect((refused as Error).message).not.toContain("handle-sam");
    // The plan holds the same rule.
    await expect(
      planSendFixedLine(
        {
          request: onlyAction(actions).request,
          turn: { id: ALEX_TURN, handleId: "handle-alex" },
          sentEarlier: false,
        },
        { messages: UNREAD },
      ),
    ).rejects.toMatchObject({ name: "FixedLineRefusedError", fault: "notTheTurnsHandle" });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("made alone, sendFixedLine answers notBuilt (CQ-44's default: K-05 has no commit with no turn)", () => {
  it("the call made alone, and the base's handler, answer notBuilt naming the call, reading and writing nothing", async () => {
    await expect(sendFixedLineAlone()).rejects.toBeInstanceOf(NotBuiltError);
    // The outage line as the AI-down path asks it alone (runtime/src/outage/ai: a job's call, no turn).
    const { actions } = helpTurn({ turnId: ALEX_TURN, personId: "person-alex", handleId: "handle-alex" });
    const request = structuredClone(onlyAction(actions).request);
    request.caller = { ...request.caller, kind: "job", turnId: null, requestId: "safety:evt-alex-help" };
    request.fixedLineId = "outage";
    const call = callContext("biz-lees-barbershop");
    const refused = await sendFixedLineHandler<unknown>()(request, call).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(NotBuiltError);
    expect(refused).toMatchObject({ call: "sendFixedLine" });
    expect(call.span.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("no answer, row or refusal carries a number, an address or anyone's words (K-08 v1)", () => {
  it("every case's answer and writes hold ids, flags and labels only", async () => {
    const seeds = flagsSeedRecord();
    const privateValues = new Set(seeds.privateValues);
    expect(privateValues).toContain("+15555550101");
    expect(privateValues).toContain("alex@example.com");
    const world = worldOf(seeds);
    const runs: CoreRun[] = [];
    for (const [turnId, personId, handleId] of [
      [ALEX_TURN, "person-alex", "handle-alex"],
      ["turn-alex-email-help", "person-alex", "handle-alex-email"],
      [BEN_TURN, "person-ben", "handle-ben"],
      ["turn-pat-help", "person-pat", "handle-pat"],
      ["turn-nobody-help", null, "handle-nobody"],
    ] as const) {
      const { context, actions } = helpTurn({ turnId, personId, handleId, helps: 2 });
      for (const action of actions) runs.push(await sendFixedLineCore(action, context, readsOn(world)));
    }
    const strings = stringsIn(runs);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((value) => privateValues.has(value))).toEqual([]);
    expect(strings.filter((value) => value.includes("5555550"))).toEqual([]);
  });
});
