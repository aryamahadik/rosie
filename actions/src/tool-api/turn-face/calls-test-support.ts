// What the turn face's tests of gate and commit, compose input and finalize use (T-1141). Never imported by the Worker.
// No database: K-05's calls are doubles over T-305's K-05 fake and T-318's safety world, each answering in K-05's own
// shapes; the bundle is K-01 v1's bundle-v0-skeleton.json, which K-09 v1.5's turn 1 fixtures pin. The code under test, the
// Tool API base, the gate and its limits as registered (limit 1 given the bundle's step cards), the commit, the walk,
// runCore and the safety service, is never stood in for. Values come only from the contracts' fixtures and the master's
// sample cast (rule 9).
//
// What main cannot give yet is named, each with what it waits for, never faked (DL-346's rule, as T-315's WAITING):
//   - GATE_WAITING: limit 1 names no sign-up door (K-02 v1.1's signUp: gate/limit-1/allowed.ts changeOf answers unknown
//     for any door it does not list), so it stops turn 1's part with askedDecider (nobodyDecides), where K-09 v1.5's
//     commit-s1-01.json and ADR-013 section 2 pass it. A check fails, naming the entry, once limit 1 passes the door.
//   - READER_WAITING: turn 1's recipient holds no role yet (ADR-013 default 130; T-1148's seed), and K-05 v1.3 item 35's
//     table gives the reader from the recipient's live roles, "with none, refused", where K-09's compose-input-s1-02.json
//     reads him as the owner. Which reader a new owner's first reply has is the architect's to rule.

import { readFileSync } from "node:fs";

import type { GateAndCommitRequest } from "../../commit";
import type { CommitTurnContext } from "../../commit";
import { S1_01_IDS, sameSealer, type SameSealer } from "../../commit/core/test-support";
import { k05Fake, type K05Fake } from "../../commit/test-support";
import {
  NOT_TOLD_YET,
  PLUGIN_LISTS_NO_STOP_WORDS,
  type SafetyTelling,
  type StoredOutcome,
} from "../../domain/safety";
import { flagsReaderOn, messagesReaderOn } from "../../domain/flags/test-support";
import { BARBERSHOP, safetyWorldOf, type SafetyWorld } from "../../domain/safety/test-support";
import type { CancelClockRequest, WritePlanRequest } from "../../finalize";
import {
  fakeBundles,
  sampleBundle,
  type BundleDocument,
  type FakeBundles,
} from "../../frontier/assemble/test-support";
import type { GatePart, GateTurn, LimitVerdict } from "../../gate/framework";
import { contractFile, fixture } from "../test-support";
import {
  bundleStepCards,
  turnCommitDeps,
  turnLimits,
  type OpenHoldsAnswer,
  type OpenHoldsRequest,
  type SafetyReads,
  type TurnCommitBinding,
} from "./commit";
import { HeldTurns } from "./held";
import {
  composeInputDeps,
  finalizeDeps,
  type FixedLineFactsRead,
  type OutboxRowRead,
  type RowBinding,
  type RowData,
  type RowErrorAnswer,
} from "./rows";
import type { TurnFaceCalls } from "./turn-face";

type Json = Record<string, unknown>;

/** The turn key commit-s1-01.json's ids are built from (K-09 v1.5 default 131: the handle's sample name). */
export const SAM_KEY = "sam";

// ---------------------------------------------------------------------------------------------------------------
// Turn 1's commit: K-09 v1.5 commit-s1-01.json

/** commit-s1-01.json as these tests read it. */
export interface CommitS101 {
  given: { now: string; stated: { writes: Json } };
  request: GateAndCommitRequest;
  outcome: Json & {
    core: unknown[];
    parts: (Json & { limits: Json[] })[];
    written: { written: Json[]; outboxRows: Json[] };
    openQuestions: { opened: string[]; closed: string[] };
  };
}

/** K-09 v1.5's commit-s1-01.json, freshly parsed. */
export function commitS101(): CommitS101 {
  return fixture("commit-s1-01.json") as CommitS101;
}

/**
 * commit-s1-01.json's request with its decided context taken from the frontier's answer (each call's output feeding the
 * next: DL-322), or the fixture's own context when the frontier gave none (main's frontier fails closed while its door
 * waits: T-315's WAITING), so the commit always reads the context the turn's frontier gives, or would give.
 */
export function commitRequestAfter(frontierContext: unknown): GateAndCommitRequest {
  const { request } = commitS101();
  if (frontierContext !== undefined && request.input.kind === "decided") {
    request.input.decided.context = structuredClone(frontierContext) as typeof request.input.decided.context;
  }
  return request;
}

// ---------------------------------------------------------------------------------------------------------------
// What main's gate cannot give yet (the module note)

/** A limit main's gate fails a part on where the fixture passes it, with what it waits for. */
export interface GateWaiting {
  readonly limit: 1;
  readonly part: number;
  readonly door: "signUp";
  readonly step: string;
  /** What main's limit answers instead: askedDecider, by nobodyDecides (changeOf's unknown). */
  readonly answers: { readonly outcome: "ask"; readonly action: "askedDecider" };
  /** What it waits for: a change to limit 1 outside this card (the T-1141 report's new task). */
  readonly waitsFor: string;
}

export const GATE_WAITING: readonly GateWaiting[] = [
  {
    limit: 1,
    part: 0,
    door: "signUp",
    step: "S1-01",
    answers: { outcome: "ask", action: "askedDecider" },
    waitsFor: "limit 1 passes K-02 v1.1's sign-up door (ADR-013 section 2): a new task from T-1141's report",
  },
];

/** Whether main's limit 1 still stops turn 1's sign-up door: the expectations that follow GATE_WAITING read it. */
export const LIMIT_ONE_WAITS: boolean = GATE_WAITING.length > 0;

/** The gate's turn for one part of a request, as runGate builds it, on a repo that is no database. */
export function gateTurnOf(request: GateAndCommitRequest): { part: GatePart; turn: GateTurn } {
  if (request.input.kind !== "decided") throw new Error("the request carries decided texts");
  const { decided } = request.input;
  const [entry] = decided.decide.parts;
  const said = entry.part;
  if (said.verb !== "enter") throw new Error("turn 1 enters its one choice");
  const choice = decided.context.choices.find((offered) => offered.choiceId === said.choice) ?? null;
  const businessId = request.caller.businessId ?? BARBERSHOP;
  return {
    part: { index: 0, part: said, choice },
    turn: {
      request,
      context: decided.context,
      decide: decided.decide,
      repo: { name: "no database" },
      businessId,
    },
  };
}

/** What main's slot 1 (the flags, then limit 1 given bundle v0's step cards) answers for turn 1's part. */
export async function limitOneOnTurnOne(bundles: FakeBundles): Promise<LimitVerdict<1>> {
  const [one] = turnLimits(bundleStepCards(bundles));
  const { part, turn } = gateTurnOf(commitRequestAfter(undefined));
  return one.check(part, turn);
}

// ---------------------------------------------------------------------------------------------------------------
// K-05's calls as doubles

/** Bundle v0 (K-01 v1 bundle-v0-skeleton.json), which commit-s1-01.json's turn pins, as the frontier's fake bundles. */
export function bundleV0(): FakeBundles {
  return fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
}

/** One readOpenHolds the double answered: the request, and the repo it read on. */
export interface OpenHoldsRead {
  readonly request: OpenHoldsRequest;
  readonly repo: unknown;
}

/** K-05 v1.3 readOpenHolds over the world: its open holds on the handle at the business, its texts with no record. */
export function openHoldsOn(
  world: SafetyWorld,
  reads: OpenHoldsRead[] = [],
): TurnCommitBinding<unknown>["readOpenHolds"] {
  return (repo, request) => {
    reads.push({ request: structuredClone(request), repo });
    const answer: OpenHoldsAnswer = {
      result: "openHolds",
      holds: world.safety.holds
        .filter(
          (hold) =>
            hold.handleId === request.handleId &&
            hold.releasedAt === null &&
            hold.businessId === request.businessId,
        )
        .map((hold) => ({
          holdId: hold.id,
          releaseRule: hold.releaseRule,
          blocksBooking: hold.blocksBooking,
        })),
      unreadEventIds: request.eventIds.filter(
        (eventId) =>
          !world.safety.outcomes.some(
            (outcome) => outcome.eventId === eventId && outcome.businessId === request.businessId,
          ),
      ),
    };
    return Promise.resolve(answer);
  };
}

/** One safety read the double answered: the read and the business its request named. */
export interface SafetyReadSeen {
  readonly read: string;
  readonly businessId: string;
}

/** K-05 v1.4's safety reads over the world, each under the business its request names, in K-05's shapes. */
export function safetyReadsOn(world: SafetyWorld, seen: SafetyReadSeen[] = []): SafetyReads<unknown> {
  const under = (businessId: string, row: { businessId: string | null }): boolean =>
    row.businessId === businessId;
  const note = (read: string, businessId: string): void => {
    seen.push({ read, businessId });
  };
  const outcomeWhere = (businessId: string, match: (row: StoredOutcome) => boolean) =>
    world.safety.outcomes.find((row) => match(row) && under(businessId, row)) ?? null;
  return {
    outcomeOfEvent: (_repo, { eventId, businessId }) => {
      note("readSafetyOutcomeOfEvent", businessId);
      return Promise.resolve({ safetyOutcome: outcomeWhere(businessId, (row) => row.eventId === eventId) });
    },
    outcome: (_repo, { outcomeId, businessId }) => {
      note("readSafetyOutcome", businessId);
      return Promise.resolve({ safetyOutcome: outcomeWhere(businessId, (row) => row.id === outcomeId) });
    },
    hold: (_repo, { holdId, businessId }) => {
      note("readSafetyHold", businessId);
      const hold = world.safety.holds.find((row) => row.id === holdId && under(businessId, row)) ?? null;
      return Promise.resolve({ hold });
    },
    holdOfOutcome: (_repo, { outcomeId, businessId }) => {
      note("readSafetyHoldOfOutcome", businessId);
      const hold =
        world.safety.holds.find((row) => row.safetyOutcomeId === outcomeId && under(businessId, row)) ?? null;
      return Promise.resolve({ hold });
    },
    outboxRowWritten: (_repo, { outboxRowId, businessId }) => {
      note("readOutboxRowWritten", businessId);
      return Promise.resolve({ written: world.safety.outboxRowIds.includes(outboxRowId) });
    },
    businessZone: (_repo, { businessId }) => {
      note("readBusinessZone", businessId);
      const timeZone = world.zones[businessId];
      return Promise.resolve(
        timeZone === undefined ? { error: "notFound", table: "businesses", rowId: businessId } : { timeZone },
      );
    },
    businessOwner: ({ businessId }) => {
      note("readBusinessOwner", businessId);
      return Promise.resolve({ owner: null });
    },
  };
}

/** The doubles a face's calls run on, and what each saw. */
export interface CallDoubles {
  readonly calls: TurnFaceCalls<unknown>;
  readonly k05: K05Fake;
  readonly world: SafetyWorld;
  readonly sealer: SameSealer;
  readonly bundles: FakeBundles;
  readonly openHoldsReads: OpenHoldsRead[];
  readonly safetyReads: SafetyReadSeen[];
}

export interface CallDoublesOptions {
  readonly world?: SafetyWorld;
  readonly telling?: SafetyTelling;
  readonly scope?: TurnFaceCalls<unknown>["scope"];
}

/** A scope whose repo is no database, which records the business of each call. */
export function noDatabaseScope(businesses: string[] = []): TurnFaceCalls<unknown>["scope"] {
  return {
    withBusiness: (businessId, work) => {
      businesses.push(businessId);
      return work({ name: "no database", businessId });
    },
  };
}

/**
 * The face's calls over the doubles: commit-s1-01.json's ids (its outcome id and turn key sam), K-05 v1.1's fake commit at
 * the fixture's now, T-318's world for the safety reads with T-317's and T-307's readers on it, the same-bytes sealer,
 * the barbershop's plug-in (no stop words) and nobody told yet (T-319).
 */
export function callDoubles(options: CallDoublesOptions = {}): CallDoubles {
  const world = options.world ?? safetyWorldOf();
  const k05 = k05Fake({ now: commitS101().given.now });
  const sealer = sameSealer();
  const bundles = bundleV0();
  const openHoldsReads: OpenHoldsRead[] = [];
  const safetyReads: SafetyReadSeen[] = [];
  const binding: TurnCommitBinding<unknown> = {
    bundles,
    commitTurn: k05.commitTurn,
    readOpenHolds: openHoldsOn(world, openHoldsReads),
    safetyReads: safetyReadsOn(world, safetyReads),
    sealer,
    stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
    telling: options.telling ?? NOT_TOLD_YET,
    safetyExtra: {
      flagsReader: () => flagsReaderOn(world.flags, BARBERSHOP),
      messagesReader: () => messagesReaderOn(world.flags, BARBERSHOP),
      ids: S1_01_IDS,
    },
    turnKey: () => SAM_KEY,
  };
  const calls: TurnFaceCalls<unknown> = {
    scope: options.scope ?? noDatabaseScope(),
    commit: turnCommitDeps(binding),
  };
  return { calls, k05, world, sealer, bundles, openHoldsReads, safetyReads };
}

/** The commit's context for a request, as gateAndCommitOnce builds it, on a repo that is no database. */
export function commitContextOf(request: GateAndCommitRequest): CommitTurnContext {
  const { turn } = request;
  if (turn === null) throw new Error("the request carries its turn");
  const { id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries } = turn;
  return {
    request,
    turn: structuredClone({ id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries }),
    repo: { name: "no database" },
    businessId: request.caller.businessId ?? BARBERSHOP,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Compose input and finalize: K-05 v1.3's row reads as doubles, the bundles the row was committed under

/** What main cannot give yet for turn 1's row (the module note). */
export const READER_WAITING: readonly { readonly roles: "none"; readonly waitsFor: string }[] = [
  {
    roles: "none",
    waitsFor:
      "the reader of a reply to a person who holds no role yet (K-05 v1.3 item 35: with none, refused): the architect's ruling, from T-1141's report",
  },
];

/** K-05 v1.3's read-outbox-row-s1-02.json answer (S1-02's row to Sam, the owner, after commit-s1-01-sam.json). */
export function outboxRowS102(): OutboxRowRead {
  return (contractFile("data-access/fixtures/read-outbox-row-s1-02.json") as { outcome: OutboxRowRead })
    .outcome;
}

/** K-05 v1.3's fixed-line-facts-s1-02.json answer (no opener mark; the opt-out line delivered before). */
export function fixedLineFactsS102(): FixedLineFactsRead {
  return (contractFile("data-access/fixtures/fixed-line-facts-s1-02.json") as { outcome: FixedLineFactsRead })
    .outcome;
}

/** Turn 1's first-text facts on T-1148's seed: no opener mark, and no phone row, so no opt-out line delivered. */
export function firstTextFacts(): FixedLineFactsRead {
  return { ...fixedLineFactsS102(), optOutLineDeliveredAt: null };
}

const BUNDLE_V0_DIR = new URL("../../../../bundles/v0/bundle/", import.meta.url);

/** Bundle v0 as bundles/v0 publishes it after T-1146 (…/2, with privacyLink): its manifest and flow A. */
export function publishedBundleV0(): BundleDocument {
  const read = (file: string): Json => JSON.parse(readFileSync(new URL(file, BUNDLE_V0_DIR), "utf8")) as Json;
  return { manifest: read("manifest.json"), flows: { A: read("flow/A.json") } };
}

/** The row read with its bundle the published bundle v0's id, so the row is read in it (the rest as K-05's fixture). */
export function rowUnderPublishedV0(row: OutboxRowRead = outboxRowS102()): OutboxRowRead {
  const bundleId = publishedBundleV0().manifest.bundleId as { hash: string; build: number };
  return { ...row, row: { ...row.row, bundleId } };
}

/** The doubles of K-05's row reads and finalize's writes, with what each was asked. */
export interface RowDoubles {
  readonly data: RowData;
  readonly binding: RowBinding;
  readonly held: HeldTurns;
  readonly reads: string[];
  readonly plans: WritePlanRequest[];
  readonly cancels: CancelClockRequest[];
}

export interface RowDoublesOptions {
  readonly row?: OutboxRowRead | RowErrorAnswer;
  readonly facts?: FixedLineFactsRead | RowErrorAnswer;
  readonly bundle?: BundleDocument;
}

/** K-05 v1.3's two reads answering as given (K-05's s1-02 fixtures by default), and writePlan and cancelClock taking each. */
export function rowDoubles(options: RowDoublesOptions = {}): RowDoubles {
  const reads: string[] = [];
  const plans: WritePlanRequest[] = [];
  const cancels: CancelClockRequest[] = [];
  const row = options.row ?? outboxRowS102();
  const facts = options.facts ?? fixedLineFactsS102();
  const data: RowData = {
    readOutboxRow: (request) => {
      reads.push(`readOutboxRow ${request.outboxRowId}@${request.businessId}`);
      return Promise.resolve(structuredClone(row));
    },
    readFixedLineFacts: (request) => {
      reads.push(`readFixedLineFacts ${request.outboxRowId}@${request.businessId}`);
      return Promise.resolve(structuredClone(facts));
    },
    writePlan: (request) => {
      plans.push(structuredClone(request));
      return Promise.resolve({
        result: "written",
        outboxRowId: request.outboxRowId,
        version: request.expectVersion + 1,
      });
    },
    cancelClock: (request) => {
      cancels.push(structuredClone(request));
      return Promise.reject(new Error("no question is withdrawn in these tests"));
    },
  };
  const held = new HeldTurns();
  const binding: RowBinding = {
    data,
    bundles: fakeBundles(options.bundle ?? sampleBundle("bundle-v0-skeleton.json")),
    held,
    now: () => "2026-10-19T18:05:07Z",
    log: () => undefined,
  };
  return { data, binding, held, reads, plans, cancels };
}

/** The face's calls with compose input and finalize bound over the row doubles (and the commit over its own). */
export function rowCalls(doubles: RowDoubles): TurnFaceCalls<unknown> {
  return {
    scope: noDatabaseScope(),
    commit: callDoubles().calls.commit,
    compose: composeInputDeps(doubles.binding),
    finalize: finalizeDeps(doubles.binding),
    held: doubles.held,
  };
}
