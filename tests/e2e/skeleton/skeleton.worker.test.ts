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
// Joined on main: joins 1 to 10 (T-552 to T-561), receive to finalize. Each later join moves JOINED_THROUGH to its row's
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
import type { Hop, Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { QUIET_MS, turnIdOf } from "../../../runtime/src/actor";
import { actorNameOf, openWords } from "../../../runtime/src/gateway";
import { SEALING_WRAP_KEY } from "../../../runtime/src/wiring";
import {
  BUNDLE_V0,
  bundleV0FixedLine,
  JOIN_TEXT,
  SAM_CHAT,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
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

/** The last hop joined on main: join 10's, finalize filling slots and fixed lines with the claim and message checks (T-561). */
const JOINED_THROUGH: SkeletonHop = "fillAndChecks";

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
  // JOIN as a new event id.
  1: (facts) => {
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
    return Promise.resolve();
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
  // turn carried (default 135), and no span or event-log entry's values hold the chat id.
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
    // The chat id's one home is the thread row: no span and no event-log entry's values hold it.
    const chatId = String(JOIN.chatId);
    expect(stringsOf(facts.collected.spans).filter((text) => text.includes(chatId))).toEqual([]);
    expect(
      stringsOf(turnRows.eventLog.map((row) => [row.old_values, row.new_values])).filter((text) =>
        text.includes(chatId),
      ),
    ).toEqual([]);
    // The gate's reads ran under Lee's Barbershop's scope, once.
    expect(facts.run.fakes.gate.scopes).toEqual([TEST_OWNER_1.businessId]);
    return Promise.resolve();
  },

  // Row 9, "The composer returns that row's plan" (K-09 compose input, K-03 plan; T-560; ADR-013 section 6; DL-347,
  // DL-355, DL-357): @rosie/actions' turn face's composeInput, reading the JOIN turn's one outbox row once under Lee's
  // Barbershop's scope, gives the composer exactly T-1175's recording 4 (S1-02's row, routine, S1-02's four card terms
  // as its facts, the JOIN as its inbound text, no frontier); @rosie/ai's composer, over the recorded-model double,
  // answers it from recording 4 with one Haiku call. One compose span for the one row, its plan plan-s1-02.json's shape,
  // its model call under bundles/v0's pinned id and the JOIN's hashed turn id, on its own portCall span too.
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
};

/** Every string a value holds, at any depth (its keys are field names, not what a span was told). */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) stringsOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) stringsOf(item, into);
  return into;
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
