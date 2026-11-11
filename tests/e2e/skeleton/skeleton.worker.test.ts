// The walking skeleton's end-to-end test (C-148; build prompt section 10, D-017), in its prefix form (T-1103; CQ-78), run
// inside workerd through the Worker's own composition root (T-1149; DL-332). One JOIN webhook goes in through T-465's local
// target, posted to runtime/src/wiring's root.linqWebhook with the HandleActor installed and every joined port fed its
// double (./root-run.ts), and runs as far as its turn's reply. Its spans are collected by the trace id the gateway answered
// with and judged by T-465's checkHops (through T-551's judgePrefixRun); the actor's inbox, safety state and batches, and
// the rows the K-05 doubles wrote, are read back; and each joined row of 02-contracts section 11, up to the prefix, is held
// to what its join proved (CLAIMS). Each hop join (T-552 to T-563) proves its own prefix with it:
//
//   npm run test:contract -- tests/contract/<the hop's contract test> --reporter=json --outputFile=<report.json>
//   SKELETON_UPTO=<name> CONTRACT_REPORT=<report.json> npm run test:e2e -- skeleton
//
// - SKELETON_UPTO and CONTRACT_REPORT are read in Node before the run, by the e2e-workers project's global setup
//   (../_driver/prefix/plan.ts), as T-551's checkSkeletonRun reads them, and given to this file by Vitest's inject. The run
//   passes only when its trace shows hops 1 to n once each, in turn order (the spans after hop n are not judged), and the
//   hop's contract tests passed in the Vitest JSON report CONTRACT_REPORT names (a path from the repository root). With no
//   CONTRACT_REPORT the hop fails, naming the report it lacks (T-551 default 4). A name that is no hop of section 11, or a
//   file that is not Vitest's JSON report, fails this test, naming it.
// - SKELETON_UPTO unset (`npm run test:e2e`, as the merge check runs it): T-465's check over every hop joined so far, from
//   receive to JOINED_THROUGH, with every joined row's claims, and no contract report read.
// - What the merged runtime does not write yet is judged around by name, and each such gap is asserted to still hold
//   (./gaps.ts): the actor's own receive span (the inbox entry, judged on its own), seq restarting in each writer (judged
//   in the order the spans started), and the batch hop with no writer (left out of the hops judged).
//
// Joined on main: joins 1 to 13 (T-552 to T-564), receive to clockArmed. Each later join moves JOINED_THROUGH to its row's
// last hop and adds its row's claims. T-466 completes the file with D-017's automated tests: 1 outbox row and 1 send to the
// Linq double carrying S1-02's question; every hop once, in order, under one trace id and one bundle id; the same webhook
// sent again adds nothing; 20 consecutive runs give the same result. Nothing here prints a message's words or a number.

import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, inject, it } from "vitest";

import joinComposeInput from "../../../ai/recordings/composer-inputs/join-s1-02.json";
import { HAIKU_MODEL } from "../../../ai/src/gateway/index";
import traceSkeleton from "../../../contracts/event-trace/fixtures/trace-skeleton.json";
import planS102 from "../../../contracts/message-plan/fixtures/plan-s1-02.json";
import decideS101Enter from "../../../contracts/model/fixtures/decide-s1-01-enter.json";
import buildFrontierS101 from "../../../contracts/tool-api/fixtures/build-frontier-s1-01.json";
import commitS101 from "../../../contracts/tool-api/fixtures/commit-s1-01.json";
import seedBusinessHead from "../../../contracts/db-schema/core/fixtures/seed-business-head.json";
import type { Hop, Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { QUIET_MS, turnIdOf } from "../../../runtime/src/actor";
import { dueOf } from "../../../runtime/src/clocks/due";
import { actorNameOf, openWords } from "../../../runtime/src/gateway";
import { SEALING_WRAP_KEY } from "../../../runtime/src/wiring";
import {
  BUNDLE_V0,
  bundleV0FixedLine,
  JOIN_TEXT,
  SAM_CHAT,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
  type EventLogRow,
} from "../../../runtime/src/wiring/test-support";
import { checkHops, checkRun, isModelCallSpan, readReceipt, type Collected, type SentText } from "../_driver";
import {
  SECTION_11_ROWS,
  SKELETON_PLAN,
  SKELETON_UPTO,
  judgePrefixRun,
  prefixOf,
  prefixTrace,
  type SkeletonHop,
} from "../_driver/prefix";
import { GAPS, NOT_WRITTEN, judgedTraceOf, stillHolds, writtenHops, type JudgedTrace } from "./gaps";
import { JOIN } from "./join";
import { actorOf, startRootRun, type ActorReader, type RootRun } from "./root-run";

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;

/** What SKELETON_UPTO and CONTRACT_REPORT ask of this run, read in Node (../_driver/prefix/plan.ts). */
const plan = inject(SKELETON_PLAN);

/** The last hop joined on main: join 13's, the delivery receipt and the clock it arms (T-564), the skeleton's last. */
const JOINED_THROUGH: SkeletonHop = "clockArmed";

/** Every hop joined so far, as SKELETON_UPTO=<JOINED_THROUGH> names them: what the run judges with SKELETON_UPTO unset. */
function joinedPrefix(): NonNullable<ReturnType<typeof prefixOf>> {
  const joined = prefixOf(JOINED_THROUGH);
  if (joined === null) throw new Error(`hop ${JOINED_THROUGH} is no hop of 02-contracts section 11`);
  return joined;
}

const mode =
  plan.upto === null
    ? `${SKELETON_UPTO} unset: every hop joined so far, receive to the ${JOINED_THROUGH}`
    : `${SKELETON_UPTO}=${plan.upto}`;

/** K-08 v1's trace-skeleton.json: the skeleton's trace as the contract draws it. */
const SKELETON = traceSkeleton as unknown as Trace;

/** trace-skeleton.json's span of `hop`. */
function skeletonSpan(hop: Hop): Span {
  const span = SKELETON.spans.find((candidate) => candidate.hop === hop);
  if (span === undefined) throw new Error(`trace-skeleton.json has no ${hop} span`);
  return span;
}

/** What each joined row's claims read. */
interface Facts {
  readonly run: RootRun;
  /** The JOIN's handle actor. */
  readonly actor: ActorReader;
  readonly sent: SentText;
  /** The JOIN's turn: T-248's hash of its event id (CQ-09). */
  readonly turnId: string;
  /** The trace as collected (each writer's own seq). */
  readonly collected: Trace;
  /** The trace as T-465's checkHops judged it (./gaps.ts). */
  readonly judged: JudgedTrace;
}

/** The one span of `hop` in the judged trace. */
function onlySpan(facts: Facts, hop: Hop): Span {
  const found = facts.judged.trace.spans.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/**
 * The actor's inbox entry: its own receive span (gap actorReceive). Its `at` is when the entry started, as K-08 says: the
 * actor reads its clock once as the hand-off reaches it and stamps the span from that reading when it answers
 * (runtime/src/actor/handle-actor.ts accept and recordSpan; T-1170).
 */
function inboxEntrySpan(facts: Facts): Span {
  expect(facts.judged.actorReceives, stillHolds("actorReceive")).toHaveLength(1);
  const [span] = facts.judged.actorReceives;
  if (span === undefined) throw new Error("no span of the actor's inbox entry");
  return span;
}

/**
 * The text's arrival, on the gateway's own clock readings, which are exact: from the start of the scrub that hands the text
 * on to its actor (scrub's `at`) to the gateway's answer, which waits for the actor's (receive's `at` plus `ms`, read at its
 * start and at its finish). The actor stores the text and starts its safety read in between (handle-actor.ts accept).
 */
function arrivalOf(facts: Facts): { readonly from: number; readonly to: number } {
  const receive = onlySpan(facts, "receive");
  return { from: Date.parse(onlySpan(facts, "scrub").at), to: Date.parse(receive.at) + receive.ms };
}

/**
 * What each joined row of 02-contracts section 11 holds the run to, by row: what its join proved in its own Workers test
 * (runtime/src/wiring hop2 to hop6), now on the one run every hop shares.
 */
const CLAIMS: Readonly<Record<number, (facts: Facts) => Promise<void>>> = {
  // Row 1, "Webhook in, signature checked" (K-11; T-552): the gateway verified the Linq double's signature, and took the
  // JOIN as a new event id. And at receipt the JOIN opened Sam's chat (K-05 v1.7 openChatOnText; T-1213, DL-444): one call,
  // after the key call and before the actor's inbox entry, naming his handle by the id the key call answered (test owner
  // 1's seeded handle-sam) and, from the K-06 event, its id, service, receipt time and trace, never the number. K-04 then
  // holds his phone row, inserted once: chat open since the receipt, by iMessage, not stopped, version 1, its number read
  // from the handle, with one phone.chat_opened entry (no turn, the event id as its job id, the JOIN's trace, no bundle),
  // as open-chat-first-text-sam.json writes turn 1's. No entry holds the number, the chat id or the JOIN's words.
  1: async (facts) => {
    expect(onlySpan(facts, "receive")).toMatchObject({
      outcome: "ok",
      event_id: JOIN.eventId,
      provider: "linq",
      error_code: null,
      decided: { signatureValid: true, knownEventId: false, answered: 200 },
    });
    expect(readReceipt(facts.judged.trace)).toMatchObject({
      traceId: facts.sent.traceId,
      eventId: JOIN.eventId,
      outcome: "ok",
      signatureValid: true,
      knownEventId: false,
      droppedAtReceipt: false,
    });

    const { dispatch } = facts.run.fakes;
    const [stored] = await facts.actor.inbox();
    if (stored === undefined) throw new Error("no inbox entry");
    const [opened, ...again] = dispatch.chatOpens;
    expect(again).toEqual([]);
    if (opened === undefined) throw new Error("the JOIN opened no chat at receipt");
    const receivedAt = String(stored.event.receivedAt);
    expect(opened.request).toEqual({
      eventId: JOIN.eventId,
      handleId: TEST_OWNER_1.handleId,
      service: JOIN.service,
      receivedAt,
      traceId: facts.sent.traceId,
    });
    expect(opened.answer).toMatchObject({
      result: "inserted",
      handleId: TEST_OWNER_1.handleId,
      phone: { chatOpen: true, chatWay: JOIN.service, stopped: false, version: 1 },
      event: {
        id: `${JOIN.eventId}/chat-opened`,
        kind: "phone.chat_opened",
        actorKind: "provider",
        tableName: "phones",
        rowId: TEST_OWNER_1.handleId,
        oldValues: null,
        newValues: { chat_open: true, chat_way: JOIN.service },
      },
    });
    const answered = opened.answer as { readonly phone: { readonly chatOpenAt: string } };
    expect(Date.parse(answered.phone.chatOpenAt)).toBe(Date.parse(receivedAt));
    // Before the actor's inbox entry: the call had ended when the hand-off reached the actor.
    expect(opened.endedAt).toBeLessThanOrEqual(Date.parse(inboxEntrySpan(facts).at));
    // K-04's phone row, inserted once, as the dispatcher's doubles read it: its number the handle's own address.
    expect(dispatch.phones.get(TEST_OWNER_1.handleId)).toEqual({
      number: JOIN.handle.address,
      stopped: false,
      stopAt: null,
      chatOpen: true,
      chatWay: JOIN.service,
      linqContactAddedAt: null,
      pollVotedAt: null,
      optoutLineDeliveredAt: null,
      version: 1,
    });
    // One phone.chat_opened entry, with no turn: the event id as its job id, the JOIN's trace, no bundle.
    expect(dispatch.chatEntries).toMatchObject([
      {
        id: `${JOIN.eventId}/chat-opened`,
        kind: "phone.chat_opened",
        turn_id: null,
        job_id: JOIN.eventId,
        trace_id: facts.sent.traceId,
        bundle_hash: null,
        bundle_build: null,
        business_id: null,
        actor_kind: "provider",
        table_name: "phones",
        row_id: TEST_OWNER_1.handleId,
        old_values: null,
        why: { provider_event: { provider: "linq", event_id: JOIN.eventId } },
      },
    ]);
    expect(holdersOf(dispatch.chatEntries, [String(JOIN.chatId), ...SECRETS], "chat entry")).toEqual([]);
    expect(holdersOf([opened.request, opened.answer], [String(JOIN.chatId), ...SECRETS], "call")).toEqual([]);
  },

  // Row 2, "Sealed event" (K-06; T-553): scrubbed (nothing to tag), sealed under the handle's key, and one entry in its
  // actor's ordered inbox.
  2: async (facts) => {
    const scrub = onlySpan(facts, "scrub");
    expect(scrub).toMatchObject({
      outcome: "ok",
      event_id: JOIN.eventId,
      error_code: null,
      decided: skeletonSpan("scrub").decided,
    });
    // The actor's inbox entry, once, under the trace id, on the text's arrival: after the gateway's scrub, and before the
    // gateway answered.
    const entry = inboxEntrySpan(facts);
    expect(entry).toMatchObject({
      outcome: "ok",
      event_id: JOIN.eventId,
      error_code: null,
      got: { door: "handleActor", route: "inbox", kind: "text" },
      decided: { stored: true, startsTurn: true },
    });
    const arrival = arrivalOf(facts);
    expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(arrival.from);
    expect(Date.parse(entry.at)).toBeLessThanOrEqual(arrival.to);
    // Read back: one entry, the JOIN's, on its trace, starting a turn. Its words are only sealed: they open under the key
    // K-05 gave the handle at its first sight, and under no other.
    const inbox = await facts.actor.inbox();
    expect(inbox.map((stored) => [stored.event.eventId, stored.traceId, stored.startsTurn])).toEqual([
      [JOIN.eventId, facts.sent.traceId, true],
    ]);
    const [stored] = inbox;
    if (stored === undefined) throw new Error("no inbox entry");
    expect(stored.event).not.toHaveProperty("body");
    const sealed = stored.event.sealed;
    if (sealed === null) throw new Error("the JOIN's words were not sealed");
    const actorName = actorNameOf(JOIN.handle);
    await expect(
      openWords(sealed, crypto.getRandomValues(new Uint8Array(32)), actorName, JOIN.eventId),
    ).rejects.toThrow();
    const key = facts.run.fakes.handleKeys.keyOf(JOIN.handle.address);
    expect((await openWords(sealed, key, actorName, JOIN.eventId)).body).toBe(JOIN_TEXT);
    // The database's rows: K-05's handleSealingKey, asked by each part that seals or opens the words (the gateway, the safety
    // read, the turn), only for this handle, each time with new ids (never built from the number) and the wrapping key by
    // its name. Its first answer made the handle, person and key the words above are sealed under; the rest found them.
    const requests = facts.run.fakes.handleKeys.requests;
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).toEqual({
        handle: JOIN.handle,
        newHandleId: expect.stringMatching(/^handle-/) as unknown,
        newPersonId: expect.stringMatching(/^person-/) as unknown,
        wrappingKeyName: SEALING_WRAP_KEY,
      });
    }
    expect(new Set(requests.map((request) => request.newHandleId)).size).toBe(requests.length);
  },

  // Row 3, "Safety read on each raw text, on arrival, before batching" (K-02; T-554): the JOIN reads No.
  3: async (facts) => {
    const read = onlySpan(facts, "safetyRead");
    expect(read).toMatchObject({
      outcome: "ok",
      event_id: JOIN.eventId,
      error_code: null,
      got: { via: "verdict", outcomes: ["no"], dangerWords: 0 },
      decided: { danger: false, path: "none", line: null },
    });
    // On arrival: the read started once the text's inbox entry had (the actor stores the text and starts its read in one
    // step: handle-actor.ts accept), and before the gateway answered, which waits for that step (arrivalOf).
    expect(Date.parse(read.at)).toBeGreaterThanOrEqual(Date.parse(inboxEntrySpan(facts).at));
    expect(Date.parse(read.at)).toBeLessThanOrEqual(arrivalOf(facts).to);
    // Its one model call: Haiku on the JOIN's words, answered by the recorded-model double (safety-no.json), on its own
    // portCall span beside the hops. The trace's model-call spans whose calls are all safety reads are the read's; those
    // holding any other call are decide's, which row 7 holds to its two reads' four calls.
    expect(facts.run.fakes.models.calls).toEqual([{ model: HAIKU_MODEL, text: JOIN_TEXT }]);
    expect(
      facts.judged.trace.spans
        .filter(
          (span) =>
            isModelCallSpan(span) && (span.model_calls ?? []).every((call) => call.purpose === "safetyRead"),
        )
        .map((span) => span.model_calls?.map((call) => [call.model, call.purpose])),
    ).toEqual([[[HAIKU_MODEL, "safetyRead"]]]);
    // The actor's own record of the read: done, no danger, no line.
    expect(await facts.actor.safety()).toMatchObject([
      { eventId: JOIN.eventId, state: "done", danger: false, path: "none", lineId: null },
    ]);
  },

  // Row 4, "Batch and turn lease" (K-04 turns, K-06 event ids; T-555): one batch, one turn under its event id's hash, its
  // bundle pinned, and its one K-04 turns row.
  4: async (facts) => {
    const lease = onlySpan(facts, "lease");
    expect(lease).toMatchObject({
      outcome: "ok",
      turn_id: facts.turnId,
      error_code: null,
      got: { texts: 1, manifestFrom: "postgres" },
      decided: skeletonSpan("lease").decided,
    });
    // The read on arrival ended before the lease started: no turn takes a text whose read is not done.
    const read = onlySpan(facts, "safetyRead");
    expect(Date.parse(read.at) + read.ms).toBeLessThanOrEqual(Date.parse(lease.at));
    // The batch window writes no span yet (gap batchSpans): the actor's own record shows the batch, closed and handed on.
    expect(
      facts.collected.spans.filter((span) => span.hop === "batch"),
      stillHolds("batchSpans"),
    ).toEqual([]);
    const batches = await facts.actor.batches();
    expect(batches).toMatchObject([{ handed: true, eventIds: [JOIN.eventId] }]);
    // Closed by the window's clock, never by a count: 3 s quiet (or 6 s after the text, on a slow machine).
    expect(["quiet", "max"]).toContain(batches[0]?.reason);
    // One bundle id on every span: bundle v0's, as bundles/v0 publishes it, read at receipt and pinned for the turn.
    expect(new Set(facts.collected.spans.map((span) => JSON.stringify(span.bundle_id)))).toEqual(
      new Set([JSON.stringify(BUNDLE_V0)]),
    );
    // The database's row: K-05's commit wrote the turn's one K-04 turns row, under the lease's turn id and the JOIN's trace.
    expect([...facts.run.fakes.turnRows.turns.values()]).toMatchObject([
      {
        id: facts.turnId,
        handleId: TEST_OWNER_1.handleId,
        eventIds: [JOIN.eventId],
        state: "committed",
        bundleId: BUNDLE_V0,
        traceId: facts.sent.traceId,
        joinedTraceIds: [],
        tries: 1,
      },
    ]);
  },

  // Row 5, "Guard: keywords, then targets" (K-01 keywords, K-04 targets; T-556): JOIN is none of bundle v0's keywords, and
  // the seeded test owner has no target, so the doors.
  5: (facts) => {
    const guard = onlySpan(facts, "guard");
    const drawn = skeletonSpan("guard");
    expect(guard).toMatchObject({
      outcome: drawn.outcome,
      turn_id: facts.turnId,
      got: drawn.got,
      decided: drawn.decided,
    });
    expect(guard).toMatchObject({
      error_code: null,
      got: { texts: 1, roles: 0, openQuestions: 0, bookings: 0 },
      decided: { keyword: null, flagsVisit: false, toDecide: 1, targets: 0, doors: true },
    });
    // The targets: K-05's handleTargets asked once, for the seeded handle; the JOIN went on with no target. The joined
    // frontier (T-557) shows it: decide's context offers only the sign-up door, which T-1147 offers only when the guard's
    // targets say noTarget with no role, open question or booking listed.
    expect(facts.run.fakes.handleTargets.requests).toEqual([{ handleId: TEST_OWNER_1.handleId }]);
    expect(
      facts.run.fakes.decide.decideCalls.map((context) =>
        context.choices.map((choice) => [choice.kind, choice.door]),
      ),
    ).toEqual([[["door", "signUp"]]]);
    return Promise.resolve();
  },

  // Row 6, "Frontier from the Tool API" (K-09 buildFrontier, K-02 context, K-01 bundle v0; T-557): @rosie/actions' turn
  // face, over the bundle the turn pinned and test owner 1's stored state (K-05 v1.2 readTurnState under Lee's
  // Barbershop's scope: no role, open question, booking or phone row), gives the JOIN turn build-frontier-s1-01.json's
  // choices: one choice, c-01, the sign-up door to S1-01. KV is empty, so its bundle part comes from PostgreSQL's copy,
  // and its span, under bundle v0's id, says so.
  6: async (facts) => {
    const flowKey = `bundle/${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}/flow/A`;
    expect(onlySpan(facts, "frontier")).toMatchObject({
      outcome: "ok",
      turn_id: facts.turnId,
      error_code: null,
      bundle_id: BUNDLE_V0,
      business_id: TEST_OWNER_1.businessId,
      got: {
        toolCall: "buildFrontier",
        callerKind: "turn",
        bundleParts: ["flow/A"],
        bundleFrom: ["postgres"],
      },
      decided: { answered: "response" },
    });
    expect(await env.BUNDLES?.get(flowKey)).toBeNull();
    expect(facts.run.fakes.bundleReads.reads).toContainEqual({ call: "readBundleValue", key: flowKey });
    expect(facts.run.fakes.frontier.reads.map((read) => [read.call, read.scope])).toEqual([
      ["readTurnState", TEST_OWNER_1.businessId],
    ]);
    expect(facts.run.fakes.decide.decideCalls.map((context) => context.choices)).toEqual([
      buildFrontierS101.outcome.context.choices,
    ]);
  },

  // Row 7, "Decide, two reads" (K-02; T-558): @rosie/ai's decider, over the recorded-model double's recording 2 (the JOIN
  // run's own context, as ai/recordings keys it: DL-347), gives the JOIN turn two decide reads, first and check, both
  // Haiku, which agree, and no re-read: both enter c-01, the sign-up door, with the quote JOIN and no field, as
  // decide-s1-01-enter.json's reads do with its own text. The turn records the hop's one decideReads span (the AI layer
  // records only each model call's portCall span beside it), labels and counts only.
  7: (facts) => {
    const decide = onlySpan(facts, "decideReads");
    expect(decide).toMatchObject({
      outcome: "ok",
      turn_id: facts.turnId,
      error_code: null,
      bundle_id: BUNDLE_V0,
      business_id: TEST_OWNER_1.businessId,
      got: { choices: 1 },
      decided: {
        agreed: true,
        reread: false,
        parts: 1,
        oneQuestion: 0,
        verbs: ["enter"],
        stakes: "low",
        language: "en",
      },
    });
    // Two reads, both Haiku: each read's step 1 and its one part's step 2 (the two-step wire form), each call on its own
    // portCall span beside the hops, answered at its first attempt.
    const byPurpose = (calls: readonly { model: string; purpose: string }[]): string[] =>
      calls.map((call) => `${call.model} ${call.purpose}`).sort();
    const twoHaikuReads = [
      `${HAIKU_MODEL} decideCheck`,
      `${HAIKU_MODEL} decideCheck`,
      `${HAIKU_MODEL} decideFirst`,
      `${HAIKU_MODEL} decideFirst`,
    ];
    expect(byPurpose(decide.model_calls ?? [])).toEqual(twoHaikuReads);
    const decideCalls = facts.judged.trace.spans.filter(
      (span) =>
        isModelCallSpan(span) &&
        span.model_calls?.some((call) => call.purpose !== "safetyRead" && call.purpose !== "compose"),
    );
    expect(byPurpose(decideCalls.flatMap((span) => span.model_calls ?? []))).toEqual(twoHaikuReads);
    expect(decideCalls.map((span) => [span.attempt, span.outcome])).toEqual(decideCalls.map(() => [1, "ok"]));
    // Then no re-read.
    expect(facts.collected.spans.filter((span) => span.hop === "reread")).toEqual([]);
    expect(facts.run.fakes.decide.rereadCalls).toEqual([]);
    // Both reads enter c-01, the sign-up door, with the quote JOIN and no field: the result the gate was handed holds
    // decide-s1-01-enter.json's two reads with the JOIN's own text, and its one part goes.
    const [gateCall, ...again] = facts.run.gateCalls;
    expect(again).toEqual([]);
    const input = gateCall?.request.input;
    if (input?.kind !== "decided") throw new Error("the gate was handed no decided input");
    const enter = decideS101Enter as unknown as {
      readonly reads: readonly { readonly output: { readonly parts: readonly object[] } }[];
    };
    expect(input.decided.decide.reads).toEqual(
      enter.reads.map((read) => ({
        ...read,
        output: { ...read.output, parts: read.output.parts.map((part) => ({ ...part, quote: JOIN.body })) },
      })),
    );
    expect(input.decided.decide).toMatchObject({
      turnId: facts.turnId,
      bundleId: BUNDLE_V0,
      agreed: true,
      reread: false,
      parts: [{ outcome: "go", part: { verb: "enter", quote: JOIN_TEXT, choice: "c-01", fields: [] } }],
    });
    expect(input.decided.context.choices).toMatchObject([{ choiceId: "c-01", kind: "door", door: "signUp" }]);
    // Every decide call was answered from recording 2 as ai/recordings keys it: the run's request is the recording's.
    expect(facts.run.fakes.decide.misses).toEqual([]);
    expect(new Set(facts.run.fakes.decide.calls.flatMap((call) => call.recordings))).toEqual(
      new Set(["decide-s1-01-join-first", "decide-s1-01-join-check"]),
    );
    return Promise.resolve();
  },

  // Row 8, "Gate and one commit: state, the open question and its clock row, one outbox row, the event log, under the turn
  // id" (K-09, K-05, K-04, K-07, K-08; T-559; ADR-013 sections 4 and 6; K-09 v1.5 defaults 130 to 136): @rosie/actions'
  // turn face's gateAndCommit, its one K-05 commitTurn through the root's turn-row port, gives the JOIN turn one gate span
  // with commit-s1-01.json's limits (trace-skeleton.json's: 1, 4 and 6 pass) and one commit span naming commit-s1-01.json's
  // rows; K-04 then holds exactly 1 turn row (K-05's seven fields alone), 1 thread row, 1 open question, 1 clock row
  // (waiting, unarmed), 1 outbox row and the event-log entries, under one turn id and one trace id, each row id built from
  // the turn's own id (default 131), each value commit-s1-01.json's given.stated.writes states but for the ids and the chat
  // id, which are the run's. The thread and the outbox row took the JOIN event's chat id and service, which the request's
  // turn carried (default 135). No span holds the chat id, and no event-log entry holds it, the JOIN's number in any
  // form or its words, even inside a longer value at any depth (T-1200, from T-559's security review note a).
  8: (facts) => {
    const fixture = commitS101 as unknown as {
      readonly given: {
        readonly stated: {
          readonly writes: {
            readonly state: readonly { readonly values: Record<string, unknown> }[];
            readonly openQuestions: readonly Record<string, unknown>[];
            readonly outboxRows: readonly Record<string, unknown>[];
          };
        };
      };
      readonly outcome: {
        readonly parts: readonly { readonly limits: unknown }[];
        readonly written: {
          readonly written: readonly { readonly table: string; readonly rowId: string }[];
          readonly outboxRows: readonly { readonly id: string }[];
        };
      };
    };
    // The fixture's ids, built from the run's turn id (default 131: its turn key, `sam`, is the handle's sample name),
    // and its chat id the run's (the JOIN event's).
    const asRun = <T>(value: T): T =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll(`-sam-1"`, `-${facts.turnId}-1"`)
          .replaceAll(`"linq-chat-demo-sam"`, JSON.stringify(JOIN.chatId)),
      ) as T;
    const { turnRows } = facts.run.fakes;
    const rowsIn = (table: string) => [...(turnRows.rows.get(table)?.values() ?? [])];

    // The gate: one span for the turn's one part, the turn's own (the Tool API base records none: DL-376).
    const gate = onlySpan(facts, "gate");
    expect(gate.limits).toEqual(skeletonSpan("gate").limits);
    expect(gate.limits).toEqual(fixture.outcome.parts[0]?.limits);
    expect(gate).toMatchObject({
      outcome: "ok",
      error_code: null,
      turn_id: facts.turnId,
      business_id: TEST_OWNER_1.businessId,
      decided: { part: 0, result: "committed", choice: "c-01" },
    });
    // The commit: one span, its rows commit-s1-01.json's by the run's ids.
    const commit = onlySpan(facts, "commit");
    expect(commit.rows).toEqual(
      asRun([
        ...fixture.outcome.written.written.map((row) => ({ table: row.table, id: row.rowId })),
        ...fixture.outcome.written.outboxRows.map((row) => ({ table: "outbox_rows", id: row.id })),
      ]),
    );
    expect(commit).toMatchObject({
      outcome: "ok",
      error_code: null,
      turn_id: facts.turnId,
      decided: { repeated: false, parts: 1, committedParts: 1, core: 1, outboxRows: 1 },
    });

    // K-05: one commitTurn under the lease's turn id, its turn K-05's seven fields alone.
    expect(turnRows.commits.map((request) => request.turn)).toEqual([
      {
        id: facts.turnId,
        handleId: TEST_OWNER_1.handleId,
        eventIds: [JOIN.eventId],
        bundleId: BUNDLE_V0,
        traceId: facts.sent.traceId,
        joinedTraceIds: [],
        tries: 1,
      },
    ]);
    // K-04: exactly the turn row, the part's rows and the safety record's outcome row (the core action's: default 5).
    expect([...turnRows.turns.keys()]).toEqual([facts.turnId]);
    expect([...turnRows.rows.keys()].sort()).toEqual([
      "clock_rows",
      "open_questions",
      "outbox_rows",
      "safety_outcomes",
      "threads",
    ]);
    const stated = fixture.given.stated.writes;
    // 1 thread row (S1-01): chat, no booking, its linq_chat_id the JOIN event's chat id, no reply address.
    expect(rowsIn("threads").map((row) => [row.id, row.values])).toEqual([
      [`thread-s1-01-${facts.turnId}-1`, asRun(stated.state[0]?.values)],
    ]);
    expect(rowsIn("threads")[0]?.values).toMatchObject({ linq_chat_id: JOIN.chatId, booking_id: null });
    // 1 open question (S1-02's, no options), waiting.
    expect(rowsIn("open_questions").map((row) => [row.id, row.values])).toEqual([
      [`oq-s1-02-${facts.turnId}-1`, { ...asRun(stated.openQuestions[0]), status: "waiting" }],
    ]);
    // 1 clock row, the commit's own: waiting, not armed until the first delivery receipt.
    expect(rowsIn("clock_rows").map((row) => [row.id, row.values.state, row.values.due ?? null])).toEqual([
      [`clock-oq-s1-02-${facts.turnId}-1`, "waiting", null],
    ]);
    // 1 outbox row: the JOIN event's service, quick_reply, the question's id, no plan.
    expect(rowsIn("outbox_rows").map((row) => [row.id, row.values])).toEqual([
      [`outbox-s1-02-${facts.turnId}-1`, { ...asRun(stated.outboxRows[0]), commitSeq: 1 }],
    ]);
    expect(rowsIn("outbox_rows")[0]?.values).toMatchObject({
      channel: JOIN.service,
      sendClass: "quick_reply",
    });
    // The event-log entries: each under the one turn id, the one trace id and bundle v0.
    expect(turnRows.eventLog.length).toBeGreaterThan(0);
    expect(
      new Set(
        turnRows.eventLog.map((row) =>
          JSON.stringify([row.turn_id, row.trace_id, row.bundle_hash, row.bundle_build]),
        ),
      ),
    ).toEqual(new Set([JSON.stringify([facts.turnId, facts.sent.traceId, BUNDLE_V0.hash, BUNDLE_V0.build])]));
    // Every row under the one turn id.
    expect(
      new Set([...turnRows.rows.values()].flatMap((table) => [...table.values()].map((row) => row.turnId))),
    ).toEqual(new Set([facts.turnId]));
    // The chat id's one home is the thread row: no span holds it. No event-log entry holds it, the JOIN's number in any
    // form or its words either, even inside a longer value at any depth (an entry's sealed copy is read as the bytes it
    // seals; T-1200). The check fires on damaged copies of the run's entries that hold the number in a label and as a
    // count (T-087's shapes), or the words in a sentence and in plain where the sealed copy is.
    const chatId = String(JOIN.chatId);
    expect(stringsOf(facts.collected.spans).filter((text) => text.includes(chatId))).toEqual([]);
    const secrets = [chatId, ...SECRETS];
    const entryHolders = (entries: readonly EventLogRow[]): string[] =>
      holdersOf(entries.map(withSealedBytes), secrets, "event-log entry");
    const damaged = (change: Record<string, unknown>): EventLogRow[] =>
      turnRows.eventLog.map((row, at) => (at === 0 ? { ...row, ...change } : row));
    const national = JOIN.handle.address.slice(1);
    const local = JOIN.handle.address.slice(2);
    expect(entryHolders(damaged({ new_values: { kind: "chat", handle: `handle-${national}` } }))).toEqual(
      holding("event-log entry 1", secrets, national, local),
    );
    expect(entryHolders(damaged({ why: { step: "A3-22", tries: [{ count: Number(national) }] } }))).toEqual(
      holding("event-log entry 1", secrets, national, local),
    );
    expect(
      entryHolders(damaged({ new_values: { labels: ["No"], quote: `Sam texted ${JOIN_TEXT}` } })),
    ).toEqual(holding("event-log entry 1", secrets, JOIN_TEXT));
    expect(entryHolders(damaged({ sealed_values: btoa(JSON.stringify({ evidence: JOIN_TEXT })) }))).toEqual(
      holding("event-log entry 1", secrets, JOIN_TEXT),
    );
    expect(entryHolders(turnRows.eventLog)).toEqual([]);
    // The gate's reads ran under Lee's Barbershop's scope, once.
    expect(facts.run.fakes.gate.scopes).toEqual([TEST_OWNER_1.businessId]);
    return Promise.resolve();
  },

  // Row 9, "The composer returns that row's plan" (K-09 compose input, K-03 plan; T-560; ADR-013 section 6; DL-347,
  // DL-355, DL-357): @rosie/actions' turn face's composeInput, reading the JOIN turn's one outbox row once under Lee's
  // Barbershop's scope, gives the composer exactly T-1175's recording 4 (S1-02's row, routine, S1-02's four card terms
  // as its facts, the JOIN as its inbound text, no frontier); @rosie/ai's composer, over the recorded-model double,
  // answers it from recording 4 with one Haiku call. One compose span for the one row, its plan plan-s1-02.json's shape,
  // its model call under bundles/v0's pinned id and the JOIN's hashed turn id, on its own portCall span too. No span
  // holds a word the composer was given or wrote, the JOIN's words, its number or its chat id, even inside a longer
  // value (T-1200, from T-560's security review note a).
  9: async (facts) => {
    const row = `outbox-s1-02-${facts.turnId}-1`;
    const plan = planS102 as unknown as {
      readonly formats: readonly string[];
      readonly lines: readonly object[];
      readonly question: { readonly optionIds: readonly string[] } | null;
    };
    // One compose span for the one outbox row, the turn's: S1-02's, routine, on the JOIN's service.
    const compose = onlySpan(facts, "compose");
    expect(compose).toMatchObject({
      outcome: "ok",
      error_code: null,
      turn_id: facts.turnId,
      bundle_id: BUNDLE_V0,
      business_id: TEST_OWNER_1.businessId,
      got: {
        row,
        channel: JOIN.service,
        situation: "routine",
        allowedFormats: ["text"],
        facts: 4,
        options: 0,
        inbound: true,
      },
      decided: {
        formats: plan.formats,
        lines: plan.lines.length,
        question: plan.question !== null,
        optionIds: plan.question?.optionIds.length ?? 0,
      },
    });
    // The plan the turn handed on is plan-s1-02.json's, on the row and its channel.
    expect(facts.run.fakes.face.finalizeCalls.map((call) => [call.outboxRowId, call.plan])).toEqual([
      [row, { row, channel: JOIN.service, copyOf: null, plan: planS102 }],
    ]);
    // The composer's request is recording 4's, field for field (keyed on the runtime's ids: DL-347), with no frontier.
    expect(facts.run.fakes.composer.misses).toEqual([]);
    expect(facts.run.fakes.composer.inputs).toEqual([joinComposeInput]);
    expect(facts.run.fakes.composer.inputs[0]).not.toHaveProperty("frontier");
    expect(facts.run.fakes.composer.calls).toEqual([
      { model: HAIKU_MODEL, recording: "composer-join-s1-02" },
    ]);
    // Its one model call, Haiku for compose, on the compose span and on its own portCall span, under bundles/v0's pinned
    // id and the turn id T-248's hash of evt-sam-0000 (DL-357).
    expect(facts.turnId).toBe(await turnIdOf(["evt-sam-0000"]));
    expect(compose.model_calls?.map((call) => [call.model, call.purpose, call.outcome])).toEqual([
      [HAIKU_MODEL, "compose", "ok"],
    ]);
    const composeCalls = facts.judged.trace.spans.filter(
      (span) => isModelCallSpan(span) && (span.model_calls ?? []).some((call) => call.purpose === "compose"),
    );
    expect(composeCalls.map((span) => [span.bundle_id, span.turn_id, span.attempt, span.outcome])).toEqual([
      [BUNDLE_V0, facts.turnId, 1, "ok"],
    ]);
    // Compose input read the row once, under Lee's Barbershop's scope.
    expect(facts.run.fakes.compose.scopes).toEqual([TEST_OWNER_1.businessId]);
    expect(facts.run.fakes.compose.rowReads).toEqual([
      { outboxRowId: row, businessId: TEST_OWNER_1.businessId },
    ]);
    // No span holds a word the composer was given or wrote (the master line, the card's terms, the plan's lines and
    // its question), the JOIN's words, its number in any form or its chat id, even inside a longer value at any depth
    // (T-1200). The check fires on a damaged copy of the run's spans whose compose span holds the plan's question.
    const given = joinComposeInput as unknown as {
      readonly masterText: { readonly text: string };
      readonly facts: readonly { readonly value: string }[];
    };
    const written = planS102 as unknown as {
      readonly lines: readonly { readonly text: string }[];
      readonly question: { readonly text: string };
    };
    const secrets = [
      String(JOIN.chatId),
      ...SECRETS,
      given.masterText.text,
      ...given.facts.map((fact) => fact.value),
      ...written.lines.map((line) => line.text),
      written.question.text,
    ];
    const spans = facts.collected.spans;
    const at = spans.findIndex((span) => span.hop === "compose");
    const damaged = spans.map((span, k) =>
      k === at ? { ...span, decided: { ...span.decided, said: `Rosie: ${written.question.text}` } } : span,
    );
    expect(holdersOf(damaged, secrets, "span")).toEqual(
      holding(`span ${String(at + 1)}`, secrets, written.question.text),
    );
    expect(holdersOf(spans, secrets, "span")).toEqual([]);
  },

  // Row 10, "Code fills slots and fixed lines; claim check and message checks" (K-09 finalizeMessage, K-03 final parts;
  // T-561; ADR-013 section 6; Q-30's default): @rosie/actions' turn face's finalizeMessage, reading the JOIN turn's row and
  // its fixed-line facts once each under Lee's Barbershop's scope, fills the row's plan (plan-s1-02.json) and adds Rosie's
  // first-text lines word for word as bundle v0 writes them: S13-01's opener first, then Q-30's STOP, HELP and rates line,
  // and the privacy link alone on the last line. Every message check passes at the first attempt as finalize runs them, so
  // no rewrite, and the plan and the final parts are written into the row together, once, after the commit (T-196's
  // writePlan). One fillAndChecks span, the turn's (the Tool API base records none: DL-376).
  10: (facts) => {
    const row = `outbox-s1-02-${facts.turnId}-1`;
    const plan = planS102 as unknown as {
      readonly lines: readonly { readonly text: string }[];
      readonly question: { readonly text: string };
    };
    const opener = bundleV0FixedLine("opener").replace("<business>", TEST_OWNER_1_BUSINESS_NAME);
    const optOutLine = bundleV0FixedLine("optOutLine");
    const privacyLink = bundleV0FixedLine("privacyLink");
    const fixedLines = ["opener", "optOutLine", "privacyLink"];
    // One fillAndChecks span for the row, the turn's, after the compose: sent at the first attempt with no message check
    // failed, the first text's fixed lines by id, the row written.
    const checks = onlySpan(facts, "fillAndChecks");
    expect(checks).toMatchObject({
      outcome: "ok",
      error_code: null,
      turn_id: facts.turnId,
      bundle_id: BUNDLE_V0,
      business_id: TEST_OWNER_1.businessId,
      got: { row, attempt: "composed", calls: 1 },
      decided: {
        outcome: "send",
        failed: [],
        fallback: false,
        fallbackFailed: [],
        fixedLines,
        sends: 1,
        questionWithdrawn: false,
        teamPaged: false,
      },
      rows: [{ table: "outbox_rows", id: row }],
    });
    expect(Date.parse(checks.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(facts, "compose").at));
    // No rewrite: no rewriteOrFallback span, and the composer was asked none.
    expect(facts.collected.spans.filter((span) => span.hop === "rewriteOrFallback")).toEqual([]);
    expect(facts.run.fakes.composer.rewrites).toEqual([]);
    // The plan and the final parts, written into the row together, once, after the commit: the opener first, then the
    // plan's words, the STOP, HELP and rates line, and the privacy link alone on the last line, each word for word.
    const words = [`${opener} ${[...plan.lines.map((line) => line.text), plan.question.text].join("\n")}`];
    const text = [...words, optOutLine, privacyLink].join("\n");
    const { finalize } = facts.run.fakes;
    expect(finalize.writes).toEqual([
      {
        outboxRowId: row,
        expectVersion: 1,
        plan: { row, channel: JOIN.service, copyOf: null, plan: planS102 },
        finalParts: {
          row,
          channel: JOIN.service,
          sends: [{ kind: "words", text, calendarFile: "none", options: [], link: null }],
          fixedLines,
          slotValues: [],
          threadReplyTo: null,
        },
      },
    ]);
    const lines = text.split("\n");
    expect(lines[0]?.startsWith(`${opener} `)).toBe(true);
    expect(lines.slice(-2)).toEqual([optOutLine, privacyLink]);
    expect(facts.run.fakes.turnRows.commits).toHaveLength(1);
    // Finalize read the row and its fixed-line facts once each, under Lee's Barbershop's scope.
    expect(finalize.scopes).toEqual([TEST_OWNER_1.businessId]);
    expect(finalize.rowReads).toEqual([{ outboxRowId: row, businessId: TEST_OWNER_1.businessId }]);
    expect(finalize.factReads).toEqual([{ outboxRowId: row, businessId: TEST_OWNER_1.businessId }]);
    // No span holds a word of the final parts.
    expect(
      stringsOf(facts.collected.spans).filter((value) =>
        [opener, optOutLine, privacyLink, ...lines].some((line) => value.includes(line)),
      ),
    ).toEqual([]);
    return Promise.resolve();
  },

  // Row 11, "Outbox dispatcher, limit 8" (K-05, K-07; T-562; ADR-013 section 6: commit-s1-01.json's row, quick_reply,
  // K-09 v1.5 default 133; DL-312, DL-317, DL-433; T-1213, DL-444): the dispatcher the turn woke claims the JOIN turn's one
  // row once, in commit order, through K-05 v1.2's claim (claim 1, from checked, by the linq port), with the final parts
  // finalize wrote into it: S13-01's opener, the plan's words, Q-30's STOP, HELP and rates line, and the privacy link alone
  // on the last line. The JOIN opened Sam's chat at receipt (row 1: K-05 v1.7 openChatOnText), so limit 8 reads Sam's
  // send state with his phone row, not stopped, its chat open by iMessage, and lets the reply in the same turn go (Q-15);
  // the claim is renewed just before the part goes, with Sam's phone row read beside it (not stopped, chat open), and the
  // one words part is handed to the root's FakeLinq under its key, to Sam's chat, then marked sent. No waitingChat: no row
  // is marked. One dispatch span, the dispatcher's own, for the row, started after the turn's fillAndChecks span. The reply
  // at 11pm (Q-15), a stopped phone's row dropped, and two dispatchers claiming at once are proven in
  // runtime/src/wiring/hop11.worker.test.ts. The order rule join 12 meets: the part's providerAccepted span (row 12's hop,
  // not judged here) starts at Linq's acceptance, inside the row's dispatch span and after its start (the Linq double
  // accepts a moment after the send starts: DL-349), so judged by start time it follows the dispatch span.
  11: (facts) => {
    const row = `outbox-s1-02-${facts.turnId}-1`;
    const key = `${row}/1/1`;
    const { dispatch, finalize, linq } = facts.run.fakes;
    const written = finalize.plans.get(row);
    if (written === undefined) throw new Error("finalize wrote no final parts into the JOIN turn's row");
    const opener = bundleV0FixedLine("opener").replace("<business>", TEST_OWNER_1_BUSINESS_NAME);
    const optOutLine = bundleV0FixedLine("optOutLine");
    const privacyLink = bundleV0FixedLine("privacyLink");

    // One claim, for the JOIN turn's recipient: the row claimed once, from checked, by the linq port, as quick_reply.
    expect(dispatch.claims.map((call) => call.request.recipientHandleId)).toEqual([TEST_OWNER_1.handleId]);
    const answer = dispatch.claims[0]?.answer;
    if (answer === undefined || "error" in answer)
      throw new Error("the JOIN turn's claim was not answered claimed");
    expect(
      answer.claimed.map((claimed) => [
        claimed.outboxRowId,
        claimed.claimedFrom,
        claimed.port,
        claimed.sendClass,
        claimed.claim.claimNo,
      ]),
    ).toEqual([[row, "checked", "linq", "quick_reply", 1]]);
    // The dispatcher was handed the final parts finalize wrote, which carry the first text's lines word for word.
    expect(answer.claimed[0]?.finalParts).toEqual(written.finalParts);
    const text = written.finalParts.sends[0].text ?? "";
    expect(written.finalParts.sends).toHaveLength(1);
    expect(text.startsWith(`${opener} `)).toBe(true);
    expect(text.split("\n").slice(-2)).toEqual([optOutLine, privacyLink]);

    // Limit 8 read Sam's send state before the send: his phone row as the JOIN opened it at receipt (not stopped, chat
    // open by iMessage, version 1) and Sam's chat with its Linq id; then the dispatcher read the stopped flag once more,
    // just before the send (its own re-read, T-259). Limit 8 passed: no row was marked, waitingChat least of all.
    const read = {
      result: "sendState",
      outboxRowId: row,
      rowState: "sending",
      phone: { stopped: false, chatOpen: true, chatWay: JOIN.service, version: 1 },
      chat: { linqChatId: JOIN.chatId },
      audience: "customer",
    };
    expect(dispatch.stateReads.map((call) => call.answer)).toMatchObject([read, read]);
    expect(dispatch.rowMarks).toEqual([]);

    // The claim renewed just before the part went, Sam's phone row read beside it: not stopped, chat open.
    expect(dispatch.renewals.map((call) => call.answer)).toMatchObject([
      {
        result: "renewed",
        outboxRowId: row,
        claim: { claimNo: 1 },
        recipient: { stopped: false, chatOpen: true, version: 1 },
      },
    ]);
    // The one words part, handed to the root's FakeLinq under its key, to Sam's chat by iMessage, with the final parts'
    // words; then marked sent, and the row sent under its one claim.
    expect(linq.keysInOrder).toEqual([key]);
    expect(linq.requests).toMatchObject([
      {
        idempotencyKey: key,
        to: TEST_OWNER_1.handle.address,
        chatId: JOIN.chatId,
        service: JOIN.service,
        kind: "words",
        text,
        overrideOptout: false,
      },
    ]);
    expect(dispatch.partMarks.map((call) => [call.request.outcome, call.answer])).toMatchObject([
      ["sent", { result: "marked", outboxRowId: row, repeated: false, row: { state: "sent" } }],
    ]);
    expect(dispatch.row(row)).toMatchObject({ state: "sent", claim: { claimNo: 1 } });

    // One dispatch span for the row, the dispatcher's: limit 8 passed, claim 1, the one part sent by Linq.
    const span = onlySpan(facts, "dispatch");
    expect(span).toMatchObject({
      outcome: "ok",
      error_code: null,
      turn_id: facts.turnId,
      bundle_id: BUNDLE_V0,
      provider: "linq",
      call: "sendPart",
      attempt: 1,
      limits: [{ limit: 8, result: "pass", outcome: null }],
      got: { parts: 1, partsSent: 1 },
      decided: { result: "sent", claimNo: 1 },
      rows: [{ table: "outbox_rows", id: row }],
    });
    expect(Date.parse(span.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(facts, "fillAndChecks").at));
    // The order rule join 12 meets: the part's providerAccepted span starts after the dispatch span, inside it.
    const [accepted, ...moreAccepted] = facts.judged.trace.spans.filter(
      (each) => each.hop === "providerAccepted",
    );
    expect(moreAccepted).toEqual([]);
    if (accepted === undefined) throw new Error("no providerAccepted span for the sent part");
    expect(accepted.rows).toEqual([{ table: "outbox_parts", id: key }]);
    expect(Date.parse(accepted.at)).toBeGreaterThan(Date.parse(span.at));
    expect(Date.parse(accepted.at)).toBeLessThanOrEqual(Date.parse(span.at) + span.ms);
    // No span holds a word of the final parts.
    expect(
      stringsOf(facts.collected.spans).filter((value) =>
        text.split("\n").some((line) => value.includes(line)),
      ),
    ).toEqual([]);
    return Promise.resolve();
  },

  // Row 12, "Send to the Linq double" (K-11; T-563; DL-315, DL-433; CQ-152): the row's one words part went through the
  // root's Linq send port to @rosie/adapters' Linq double (T-411), the one the local target collects its parts from, which
  // recorded exactly one send: under the part's key, to Sam's chat by iMessage, carrying S1-02's question in the final
  // parts finalize wrote (S13-01's opener first, Q-30's STOP, HELP and rates line, the privacy link alone on the last
  // line), accepted with the message id the part was marked sent with. One providerAccepted span, the part's, at the
  // double's acceptance, inside the row's dispatch span and after its start (DL-349); no retry was needed, so nothing went
  // on the retry queue. Then the hard invariant (no duplicate send): the same webhook sent again is dropped at receipt, and
  // a dispatcher retry forced through the root's retry door (T-258's door, which the root installs: DL-315) claims nothing
  // and sends nothing, so the double still holds one send. A send whose answer was lost, retried about 60 s later under a
  // re-claim with the same key, and a 4006 retried under a new try key with one part delivered, are proven in
  // runtime/src/wiring/hop12.worker.test.ts.
  12: async (facts) => {
    const row = `outbox-s1-02-${facts.turnId}-1`;
    const key = `${row}/1/1`;
    const { dispatch, finalize, linq, retryQueue } = facts.run.fakes;
    const written = finalize.plans.get(row);
    if (written === undefined) throw new Error("finalize wrote no final parts into the JOIN turn's row");
    const text = written.finalParts.sends[0].text ?? "";
    const opener = bundleV0FixedLine("opener").replace("<business>", TEST_OWNER_1_BUSINESS_NAME);
    const question = (planS102 as unknown as { readonly question: { readonly text: string } }).question.text;

    // The Linq double the target collects from recorded exactly one send: the part, under its key, to Sam's chat, with
    // S1-02's question in Rosie's first text, word for word, and nothing it refused.
    expect(facts.run.target.linq).toBe(linq.double);
    expect(linq.double.sentRequests()).toEqual([
      {
        idempotencyKey: key,
        to: TEST_OWNER_1.handle.address,
        chatId: JOIN.chatId,
        service: JOIN.service,
        kind: "words",
        text,
        calendarFile: null,
        options: [],
        link: null,
        photo: null,
        tapback: null,
        threadedReplyTo: null,
        typing: null,
        overrideOptout: false,
      },
    ]);
    expect(linq.double.rejectedRequests()).toEqual([]);
    const lines = text.split("\n");
    expect(lines[0]?.startsWith(`${opener} `)).toBe(true);
    expect(text).toContain(question);
    expect(lines.slice(-2)).toEqual([bundleV0FixedLine("optOutLine"), bundleV0FixedLine("privacyLink")]);
    // Accepted by the double, and the part marked sent with the message id it gave.
    const accepted = linq.accepted.get(key);
    if (accepted?.providerMessageId == null) throw new Error("the Linq double accepted no part");
    expect(dispatch.partMarks.map((call) => call.request)).toMatchObject([
      { outcome: "sent", idempotencyKey: key, providerMessageId: accepted.providerMessageId },
    ]);

    // The part's one providerAccepted span, at the double's acceptance, inside the row's dispatch span.
    const providerAccepted = onlySpan(facts, "providerAccepted");
    expect(providerAccepted).toMatchObject({
      outcome: "ok",
      error_code: null,
      turn_id: facts.turnId,
      bundle_id: BUNDLE_V0,
      provider: "linq",
      rows: [{ table: "outbox_parts", id: key }],
    });
    expect(Date.parse(providerAccepted.at)).toBe(Date.parse(accepted.acceptedAt));
    const dispatchSpan = onlySpan(facts, "dispatch");
    expect(Date.parse(providerAccepted.at)).toBeGreaterThan(Date.parse(dispatchSpan.at));
    expect(Date.parse(providerAccepted.at)).toBeLessThanOrEqual(
      Date.parse(dispatchSpan.at) + dispatchSpan.ms,
    );
    // No retry was needed: nothing went on the retry queue.
    expect(retryQueue.sent).toEqual([]);

    // The same webhook sent again: dropped at receipt as a known event id, so nothing more is stored or sent.
    const again = await facts.run.target.sendEvent(JOIN);
    expect(again.gatewayStatus).toBe(200);
    await facts.actor.settle();
    const repeat = await facts.run.target.collect(again.traceId);
    if (repeat.trace === null) throw new Error(`no span carries trace id ${again.traceId}`);
    expect(readReceipt(judgedTraceOf(repeat.trace).trace)).toMatchObject({
      eventId: JOIN.eventId,
      knownEventId: true,
      repeatedWebhook: true,
    });

    // A dispatcher retry forced through the root's retry door: the row is sent, so its claim takes nothing.
    const claimsBefore = dispatch.claims.length;
    await expect(
      facts.run.root.queue.sends.retrySend({
        key: `retry-${key}#1`,
        kind: "send",
        businessId: TEST_OWNER_1.businessId,
        traceId: facts.sent.traceId,
        body: {
          outboxRowId: row,
          recipientHandleId: TEST_OWNER_1.handleId,
          failedKey: key,
          chain: "rerun",
          code: "forced",
        },
        try: 2,
        firstTriedAt: new Date(facts.run.fakes.clock.now()).toISOString(),
      }),
    ).resolves.toEqual({ result: "done" });
    expect(dispatch.claims.slice(claimsBefore).map((call) => call.answer)).toEqual([
      { result: "claimed", claimed: [], passedHeld: [] },
    ]);
    // Still one send: the double's one record, the line handed one request, the part marked once.
    expect(linq.double.sentRequests()).toHaveLength(1);
    expect(linq.requests).toHaveLength(1);
    expect(dispatch.partMarks).toHaveLength(1);
    // No span holds a word of the part.
    expect(
      stringsOf(facts.collected.spans).filter((value) => lines.some((line) => value.includes(line))),
    ).toEqual([]);
  },

  // Row 13, "Delivery receipt; the clock arms" (K-06 delivered, K-05 arm; T-564; ADR-013 section 6: K-09 README v1.5
  // default 134; arch 02 line 127; STATE note 37): the Linq double's delivery receipt for the JOIN turn's one part reached
  // the gateway before the trace was collected (root-run.ts), echoing the part's key. The receipt door marked the part
  // delivered through K-05 markPart (found by the message id the double gave: the row's first delivery, naming S1-02's
  // question) and handed it to T-255's clock arming over the root's arming port, which armed S1-02's clock row, the one
  // the commit made, through K-05 armClock named by its question: at step 9's due time with no Clock line and no visit,
  // 8pm the day after delivery in Lee's Barbershop's zone. Its question opened, no never-delivered row was cancelled (the
  // commit's own, none for turn 1: note 37), and Sam's actor was named for its alarm. One delivered span and one
  // clockArmed span, on the JOIN's trace (one trace id from the webhook to the receipt) and bundle v0, after the part's
  // providerAccepted span, labels and counts only. Then a second delivered event for the same part arms nothing more:
  // K-05 answers it repeated. Linq's repeats and the arming failing closed with no database are proven in
  // runtime/src/wiring/hop13.worker.test.ts.
  13: async (facts) => {
    const row = `outbox-s1-02-${facts.turnId}-1`;
    const key = `${row}/1/1`;
    const question = `oq-s1-02-${facts.turnId}-1`;
    const clock = `clock-${question}`;
    const { arming, dispatch, linq } = facts.run.fakes;
    const seeded = seedBusinessHead as unknown as {
      readonly rows: readonly {
        readonly table: string;
        readonly values: Readonly<Record<string, unknown>>;
      }[];
    };
    const zone = seeded.rows.find(
      (each) => each.table === "businesses" && each.values.id === TEST_OWNER_1.businessId,
    )?.values.time_zone;
    if (typeof zone !== "string") throw new Error("the seed gives Lee's Barbershop no zone");
    const accepted = linq.accepted.get(key);
    if (accepted?.providerMessageId == null) throw new Error("the Linq double accepted no part");

    // The double's own receipt for the part, once: its message id, Sam's chat, the part's key.
    const receipts = linq.double.events().filter((event) => event.kind === "delivered");
    expect(receipts).toMatchObject([
      { kind: "delivered", partKey: key, messageId: accepted.providerMessageId, chatId: JOIN.chatId },
    ]);
    // K-05 markPart: the part delivered, found by its message id, the row's first delivery, naming S1-02's question.
    const marks = dispatch.partMarks.filter((call) => call.request.outcome === "delivered");
    expect(marks.map((call) => [call.request, call.answer])).toMatchObject([
      [
        { outcome: "delivered", providerMessageId: accepted.providerMessageId, idempotencyKey: key },
        {
          result: "marked",
          outboxRowId: row,
          partNo: 1,
          tryNo: 1,
          repeated: false,
          firstDelivery: true,
          openQuestionId: question,
          row: { state: "delivered" },
        },
      ],
    ]);
    const [mark] = marks;
    if (mark?.request.outcome !== "delivered") throw new Error("no delivered mark");
    const deliveredAt = mark.request.at;

    // K-05 armClock, once, named by S1-02's question, at T-255's due time from the delivered time: step 9's default with
    // no Clock line and no visit (K-09 README v1.5 default 134), 8pm the day after delivery in the business's zone.
    expect(arming.factReads).toEqual([question]);
    const due = dueOf({ deliveredAt, clockLine: null, visitStartsAt: null, zone });
    expect(due.branch).toBe("noVisit");
    const wall = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const local = (utc: string): string => wall.format(new Date(utc));
    const dayAfter = new Date(Date.parse(`${local(deliveredAt).slice(0, 10)}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(local(due.dueAt)).toBe(`${dayAfter}, 20:00`);
    expect(arming.arms.map((call) => [call.request, call.answer])).toEqual([
      [
        { openQuestionId: question, deliveredAt, dueAt: due.dueAt, dueZone: zone },
        {
          result: "armed",
          repeated: false,
          clock: {
            clockRowId: clock,
            version: 2,
            armedAt: deliveredAt,
            dueAt: due.dueAt,
            dueZone: zone,
            handleId: TEST_OWNER_1.handleId,
          },
        },
      ],
    ]);
    // The commit's clock row, armed beside what the commit wrote; its question open; nothing cancelled; Sam's actor named.
    expect(arming.clockRow(clock)).toMatchObject({ state: "armed", version: 2, dueAt: due.dueAt });
    expect(arming.questionStatus(question)).toBe("open");
    expect(arming.cancels).toEqual([]);
    expect(arming.actorReads).toEqual([TEST_OWNER_1.handleId]);

    // One delivered and one clockArmed span, on the JOIN's trace and bundle v0, after the part's providerAccepted span.
    const accept = onlySpan(facts, "providerAccepted");
    const delivered = onlySpan(facts, "delivered");
    const armed = onlySpan(facts, "clockArmed");
    expect(delivered).toMatchObject({
      trace_id: facts.sent.traceId,
      turn_id: facts.turnId,
      bundle_id: BUNDLE_V0,
      outcome: "ok",
      provider: "linq",
      error_code: null,
      got: { firstDelivery: true, repeated: false },
      rows: [{ table: "outbox_rows", id: row }],
    });
    expect(armed).toMatchObject({
      trace_id: facts.sent.traceId,
      turn_id: facts.turnId,
      bundle_id: BUNDLE_V0,
      outcome: "ok",
      error_code: null,
      got: { firstDelivery: true, partNo: 1, tryNo: 1 },
      decided: {
        result: "armed",
        branch: "noVisit",
        zoneFrom: "business",
        clockLineUnread: false,
        neverDelivered: "none",
        synced: true,
      },
      rows: [{ table: "clock_rows", id: clock }],
    });
    expect(Date.parse(delivered.at)).toBeGreaterThanOrEqual(Date.parse(accept.at));
    expect(Date.parse(armed.at)).toBeGreaterThanOrEqual(Date.parse(delivered.at));
    // No span holds the due time, even inside a longer value, and neither span of this hop holds the zone.
    expect(stringsOf(facts.collected.spans).filter((value) => value.includes(due.dueAt))).toEqual([]);
    expect(stringsOf([delivered, armed]).filter((value) => value.includes(zone))).toEqual([]);

    // A second delivered event for the same part (Linq sends the webhook again): K-05 answers it repeated, and nothing
    // more is armed.
    const again = await facts.run.target.sendEvent(linq.deliveredReceipt(key, "evt-linq-delivered-0001"), {
      partKey: key,
    });
    expect(again.gatewayStatus).toBe(200);
    expect(
      dispatch.partMarks.filter((call) => call.request.outcome === "delivered").map((call) => call.answer),
    ).toMatchObject([
      { result: "marked", outboxRowId: row, repeated: false, firstDelivery: true },
      { result: "marked", outboxRowId: row, repeated: true, firstDelivery: false },
    ]);
    expect(arming.arms).toHaveLength(1);
    expect(arming.clockRow(clock)).toMatchObject({ state: "armed", version: 2, dueAt: due.dueAt });
  },
};

/** Every string a value holds, at any depth (its keys are field names, not what a span was told). */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) stringsOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

/**
 * Every text a value holds, at any depth: each string, and each number as its digits (T-087's checkNoRawNumberOrText
 * shapes: a number inside a label, and a number as a count). Rows 8 and 9 read it (T-1200).
 */
function textsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (typeof value === "number") into.push(String(value));
  else if (Array.isArray(value)) for (const item of value as unknown[]) textsOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) textsOf(item, into);
  return into;
}

/**
 * An event-log entry with its sealed copy (K-05 v1 sealedValues, base64) read as the text of the bytes it carries. The
 * letters of base64 spell a short word such as JOIN by chance (about once in 100,000 runs of this copy), and sealed bytes
 * almost never do (about once in 30 million), while words in plain would show in them.
 */
function withSealedBytes(entry: EventLogRow): EventLogRow {
  const sealed = entry.sealed_values;
  if (typeof sealed !== "string") return entry;
  const bytes = Uint8Array.from(atob(sealed), (char) => char.charCodeAt(0));
  return { ...entry, sealed_values: new TextDecoder().decode(bytes) };
}

/**
 * Each item that holds a secret, even inside a longer value, at any depth (textsOf), named by `name` and its place, and
 * by the secret's place in `secrets`, never the secret (K-08 v1 README). Each line of a secret, of 4 characters or more
 * as leaks() reads one, is matched as written: K-08's own labels, such as the outcome joinedTurn, hold the letters of
 * JOIN in another case and are no words.
 */
function holdersOf(items: readonly unknown[], secrets: readonly string[], name: string): string[] {
  const lines = secrets.map((secret) =>
    secret
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 4),
  );
  return items.flatMap((item, index) => {
    const texts = textsOf(item);
    return lines.flatMap((parts, at) =>
      parts.some((part) => texts.some((text) => text.includes(part)))
        ? [`${name} ${String(index + 1)} holds secret ${String(at + 1)}`]
        : [],
    );
  });
}

/** What holdersOf answers when the item `name` holds each of `held`: a damaged copy's expected lines. */
function holding(name: string, secrets: readonly string[], ...held: readonly string[]): string[] {
  return held.map((secret) => `${name} holds secret ${String(secrets.indexOf(secret) + 1)}`);
}

/** The JOIN's number in each form a number could leak in, and its words. */
const SECRETS = [JOIN.handle.address, JOIN.handle.address.slice(1), JOIN.handle.address.slice(2), JOIN_TEXT];

/** Each span that holds one of SECRETS, naming the span and the secret's place in the list, never the secret. */
function leaksIn(spans: readonly Span[]): string[] {
  return spans.flatMap((span) => {
    const strings = stringsOf(span);
    return SECRETS.flatMap((secret, index) =>
      strings.some((text) => text.includes(secret))
        ? [`hop ${span.hop} (seq ${String(span.seq)}) holds secret ${String(index + 1)}`]
        : [],
    );
  });
}

afterEach(async () => {
  await reset();
});

describe(`the walking skeleton end to end, inside workerd (${mode})`, () => {
  it(
    "one JOIN webhook through the Worker's composition root, as far as its turn's reply: T-465's checkHops judges every hop joined so far, through SKELETON_UPTO's, and each joined row holds what its join proved",
    { timeout: TEST_MS },
    async () => {
      // A name that is no hop of section 11, or a file that is not Vitest's JSON report, fails here, named (T-551).
      if (plan.refused !== null) throw new Error(plan.refused);
      const prefix = plan.prefix;
      const unwritten = prefix === null ? undefined : NOT_WRITTEN[prefix.hop];
      if (prefix !== null && unwritten !== undefined) {
        throw new Error(
          `${SKELETON_UPTO}=${prefix.name} ends at hop ${prefix.hop}, which nothing writes yet (known gap ${unwritten}, ${GAPS[unwritten].task}): no run can show it`,
        );
      }
      // The JOIN is the seeded test owner's first text (T-1148): the handle, chat and words the doubles know.
      expect([JOIN.handle, JOIN.chatId, JOIN.body]).toEqual([TEST_OWNER_1.handle, SAM_CHAT, JOIN_TEXT]);

      const run = startRootRun();
      const actor = actorOf(JOIN.handle);
      try {
        // What the turn's commit records for the text (K-09 README default 5); the read on arrival is the joined one.
        run.fakes.known(JOIN.eventId);
        const sent = await run.target.sendEvent(JOIN);
        expect(sent.gatewayStatus).toBe(200);
        // On arrival: the inbox entry and the safety read. Then 3 s of quiet close the batch, and its turn runs on its
        // lease to its reply.
        await actor.settle();
        await run.fakes.clock.advance(QUIET_MS);
        await runDurableObjectAlarm(actor.stub);
        const turnId = await turnIdOf([JOIN.eventId]);
        await actor.untilReplied(turnId);
        await actor.settle();

        const collected = await run.target.collect(sent.traceId);
        // Every span of the trace is a K-08 span (the prebuilt check, ./root-run.ts).
        expect(collected.traceProblems).toEqual([]);
        const trace = collected.trace;
        if (trace === null) throw new Error(`no span carries trace id ${sent.traceId}`);
        // Gap seqPerWriter: as written, the trace is no one run by seq.
        expect(
          checkHops(trace).problems.filter((problem) => problem.kind === "seq"),
          stillHolds("seqPerWriter"),
        ).not.toEqual([]);
        const judged = judgedTraceOf(trace);
        const judgedRun: Collected = { ...collected, trace: judged.trace };

        if (prefix === null) {
          // T-465's check over every hop joined so far.
          const hops = writtenHops(joinedPrefix().hops);
          const report = checkRun({ ...judgedRun, trace: prefixTrace(judged.trace, hops) }, hops);
          expect(report.problems).toEqual([]);
          expect(report.hops?.hops).toEqual(hops);
        } else {
          // T-551's prefix: hops 1 to n by T-465's checkRun, and hop n's contract tests as the report holds them.
          const hops = writtenHops(prefix.hops);
          const unjudged = prefix.hops.flatMap((hop) => {
            const gap = NOT_WRITTEN[hop];
            return gap === undefined ? [] : [`hop ${hop} is not judged: known gap ${gap}, ${GAPS[gap].task}`];
          });
          const report = judgePrefixRun(judgedRun, { ...prefix, hops }, plan.contractTests);
          expect(report.problems, [plan.hint, ...unjudged].join("; ")).toEqual([]);
          expect(report.hops?.hops).toEqual(hops);
        }

        // No span holds the JOIN's number or words (K-08 v1 README: never the raw number or words).
        expect(leaksIn(trace.spans)).toEqual([]);

        // Each joined row, up to the prefix's, holds what its join proved.
        const facts: Facts = { run, actor, sent, turnId, collected: trace, judged };
        const joinedRow = joinedPrefix().row.row;
        const through = Math.min(prefix?.row.row ?? joinedRow, joinedRow);
        for (const row of SECTION_11_ROWS.slice(0, through)) {
          const claims = CLAIMS[row.row];
          if (claims === undefined)
            throw new Error(`row ${String(row.row)} is joined, but has no claims here`);
          await claims(facts);
        }
      } finally {
        run.close();
      }
    },
  );
});
