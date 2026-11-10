// What the turn face's tests of gate and commit, compose input and finalize use (T-1141). Never imported by the Worker.
// No database: K-05's calls are doubles over T-305's K-05 fake and T-318's safety world, each answering in K-05's own
// shapes; the bundle is K-01 v1's bundle-v0-skeleton.json, which K-09 v1.5's turn 1 fixtures pin. The code under test, the
// Tool API base, the gate and its limits as registered (limit 1 given the bundle's step cards), the commit, the walk,
// runCore and the safety service, is never stood in for. Values come only from the contracts' fixtures and the master's
// sample cast (rule 9).
//
// Round 2 (DL-364, DL-370): limit 1 passes turn 1's sign-up door since T-1183, and a row to someone with no role on the
// sign-up section is read by its line's audience since T-1184 (K-05 v1.5 item 44), so nothing of turn 1 waits here any
// more. K-05 v1.5's rowReader fixtures and schema, read below, are what rows.ts's reader mapping is held to.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

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
import { CONTRACTS_DIR, formatProblems } from "../validator";
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
  type RowReaderOutcome,
  type RowReaderRequest,
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
 * What main's commit answers beyond commit-s1-01.json, named and never faked: `written` lists the core action's own row,
 * the text's safety record, before the rows the fixture states. K-09 v1.5 default 134 leaves the core action's rows out
 * of `written` ("named in its response", as recordSafetyOutcome's outcomeId names it), while T-305's commit hands on
 * K-05 commitTurn's list whole (actions/src/commit, outside this card). Emptied once the commit leaves it out.
 */
export const CORE_ROW_IN_WRITTEN: readonly Json[] = [
  { table: "safety_outcomes", rowId: "safety-outcome-sam-s1-01", version: 1 },
];

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
// The gate's slot 1 on turn 1's part

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

/** A K-09 composeInput exchange: its request and its compose answer's input. */
export interface ComposeS102 {
  readonly request: Json;
  readonly outcome: { readonly input: Json };
}

/**
 * Compose input on outbox-s1-02-sam-1: the card's K-09 v1 compose-input-s1-02.json request, answered since T-1174 as
 * K-09 v1.6's compose-input-s1-02-v1.6.json states it (the same request; v1's input with S1-02's card lines as K-03 v1.1
 * term facts: "its answer changes, not the port", DL-355). Refused when the two requests differ.
 */
export function composeS102(): ComposeS102 {
  const v1 = fixture("compose-input-s1-02.json") as ComposeS102;
  const v16 = fixture("compose-input-s1-02-v1.6.json") as ComposeS102;
  if (JSON.stringify(v1.request) !== JSON.stringify(v16.request)) {
    throw new Error("compose-input-s1-02.json and its v1.6 twin ask different requests");
  }
  return { request: v1.request, outcome: v16.outcome };
}

/** K-05 v1.3's read-outbox-row-s1-02.json answer (S1-02's row to Sam, the owner, after commit-s1-01-sam.json). */
export function outboxRowS102(): OutboxRowRead {
  return (contractFile("data-access/fixtures/read-outbox-row-s1-02.json") as { outcome: OutboxRowRead })
    .outcome;
}

/**
 * Turn 1's row as it runs (K-05 v1.5 row-reader-s1-02-no-role.json's given): read-outbox-row-s1-02.json's answer with
 * recipient.roles empty, as T-1148's seed stores Sam (ADR-013 default 130): a person who holds no role yet.
 */
export function outboxRowTurnOne(): OutboxRowRead {
  const read = outboxRowS102();
  return { ...read, recipient: { ...read.recipient, roles: [] } };
}

// ---------------------------------------------------------------------------------------------------------------
// K-05 v1.5's rowReader: its fixtures and its schema (README item 44)

/** One rowReader exchange (K-05 v1.5 rowReader.exchange). */
export interface RowReaderExchange {
  readonly call: "rowReader";
  readonly given: Json;
  readonly request: RowReaderRequest;
  readonly outcome: RowReaderOutcome;
}

/** K-05 v1.5's accepted rowReader fixtures, by file name under contracts/data-access/fixtures/. */
export const ROW_READER_ACCEPTED = [
  "row-reader-s1-02-no-role.json",
  "row-reader-s1-02-owner.json",
  "row-reader-a5-05-tomas-no-role.json",
] as const;

/** K-05 v1.5's refused rowReader fixtures, under fixtures/invalid/, each with its accepted twin. */
export const ROW_READER_REFUSED = [
  { file: "refuse-row-reader-no-role-outside-section-1.json", twin: "row-reader-a5-05-tomas-no-role.json" },
  { file: "refuse-row-reader-role-read-by-line.json", twin: "row-reader-s1-02-owner.json" },
] as const;

/** A rowReader fixture of K-05 v1.5, freshly parsed, by its path under contracts/data-access/fixtures/. */
export function rowReaderFixture(file: string): RowReaderExchange {
  return contractFile(`data-access/fixtures/${file}`) as RowReaderExchange;
}

/** The K-01 v1 sample bundles a rowReader fixture's request may pin, by their file names under bundle/fixtures/. */
const SAMPLE_BUNDLES = ["bundle-v0-skeleton.json", "bundle-mini-a.json", "bundle-mini-b.json"];

/** The K-01 v1 sample bundle whose id a rowReader request pins (its bundleId), as the frontier's fake bundles. */
export function bundleOfRequest(request: RowReaderRequest): FakeBundles {
  for (const file of SAMPLE_BUNDLES) {
    const bundle = sampleBundle(file);
    const id = bundle.manifest.bundleId as { hash: string; build: number };
    if (id.hash === request.bundleId.hash && id.build === request.bundleId.build) return fakeBundles(bundle);
  }
  throw new Error("no K-01 sample bundle has the request's bundle id");
}

/**
 * The row read a rowReader request was read from: read-outbox-row-s1-02.json's answer with the request's row, bundle,
 * line and recipient (the read's other fields are what item 44 does not read).
 */
export function readOfRequest(request: RowReaderRequest): OutboxRowRead {
  const read = outboxRowS102();
  return {
    ...read,
    outboxRowId: request.outboxRowId,
    row: { ...read.row, bundleId: { ...request.bundleId } },
    line: { ...request.line },
    recipient: {
      ...read.recipient,
      personId: request.recipient.personId,
      roles: request.recipient.roles.map((role) => ({ ...role })),
    },
  };
}

/** Every contract schema under contracts/ (Ajv 2020-12, strict, as contracts:check runs them), loaded once. */
let contracts: Ajv2020 | undefined;

function contractSchemas(): Ajv2020 {
  if (contracts !== undefined) return contracts;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const files = readdirSync(CONTRACTS_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
    .filter((file) => !file.startsWith("generated") && !file.startsWith("scripts"))
    .filter((file) => !file.includes("node_modules"));
  for (const file of files) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(CONTRACTS_DIR, file), "utf8")) as object);
  }
  contracts = ajv;
  return ajv;
}

const DATA_ACCESS_V15_ID = "https://rosie.invalid/contracts/data-access/data-access.v1.5.schema.json";

/** The problems K-05 v1.5's rowReader.exchange, with item 44's rules, finds in an exchange; empty when accepted. */
export function rowReaderProblems(exchange: unknown): string[] {
  const validate = contractSchemas().getSchema(`${DATA_ACCESS_V15_ID}#/$defs/rowReader.exchange`);
  if (validate === undefined) throw new Error("K-05 v1.5 has no rowReader.exchange");
  return validate(exchange) ? [] : formatProblems(validate.errors);
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
