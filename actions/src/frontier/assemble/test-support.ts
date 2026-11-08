// Doubles and helpers for the frontier's tests (T-291). Never imported by the Worker. No database and no KV: the repo
// is a fake that answers K-05 v1.2 readTurnState from seeded rows, holding its request and its answer to K-05 v1.2's
// frozen schema; the bundles are K-01 v1's sample bundles; the scope records each transaction like the Tool API base's
// recording scope. Values come only from the contracts' fixtures and the master's sample cast (Sam, Alex M., Ben T.,
// Lee's Barbershop; the 555-01xx range): rule 9.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { Span } from "../../../../runtime/src/trace";
import type { BusinessScope } from "../../tool-api/scope";
import { traceFor } from "../../tool-api/test-support";
import { createToolApi, type CallAnswer } from "../../tool-api/tool-api";
import {
  CONTRACTS_DIR,
  createToolApiValidator,
  formatProblems,
  loadToolApiSchemas,
  type ToolApiValidator,
} from "../../tool-api/validator";
import { createFrontierChecker, type FrontierChecker } from "./check";
import { frontierHandlers } from "./handler";
import type { FrontierLogLine } from "./log";
import {
  bundleKey,
  type BundleId,
  type DraftChoice,
  type FlowLetter,
  type FrontierBundles,
  type FrontierRepo,
  type FrontierSource,
  type OpenQuestionRow,
  type ReadTurnStateAnswer,
  type ReadTurnStateRequest,
  type SourceSlot,
  type Time,
  type TurnState,
  type VisitTimesAnswer,
  type VisitTimesRequest,
} from "./types";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as unknown;
}

/** A contract fixture, freshly parsed (a test may change its copy), by its path under contracts/. */
export function contractFixture(file: string): unknown {
  return readJson(file);
}

// ---------------------------------------------------------------------------------------------------------------
// K-05 v1.2's frozen schema, for the fake repo's request and answer

const DATA_ACCESS_V12_ID = "https://rosie.invalid/contracts/data-access/data-access.v1.2.schema.json";
const EXTRA_SCHEMAS = [
  "data-access/data-access.v1.1.schema.json",
  "data-access/data-access.v1.2.schema.json",
  "inbound-event/inbound-event.v1.schema.json",
];

let k05: Ajv2020 | undefined;

/** The problems K-05 v1.2's `$defs/<definition>` finds in `value`; empty when accepted. */
export function k05Problems(definition: string, value: unknown): string[] {
  if (k05 === undefined) {
    k05 = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const schema of [
      ...loadToolApiSchemas(),
      ...EXTRA_SCHEMAS.map((file) => readJson(file) as object),
    ]) {
      k05.addSchema(schema);
    }
  }
  const validate: ValidateFunction | undefined = k05.getSchema(`${DATA_ACCESS_V12_ID}#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`K-05 v1.2 has no definition ${definition}`);
  return validate(value) ? [] : formatProblems(validate.errors);
}

// ---------------------------------------------------------------------------------------------------------------
// The fake repo: K-05 v1.2 readTurnState from seeded rows

/** A row a fact may be read from: its columns and its version. */
export type SeedRow = Record<string, unknown> & { version: number };

export interface TurnSeed {
  handleId: string;
  handle: TurnState["handle"];
  persons: TurnState["persons"];
  roles: TurnState["roles"];
  phone: TurnState["phone"];
  /** Every live open question sent to the handle, at any business; a read returns its business's. */
  openQuestions: OpenQuestionRow[];
  /** The rows facts are read from, by table and row id (K-04 v1 seeds' values). */
  rows: Record<string, Record<string, SeedRow>>;
  /** Each booking's visit time; a booking left out has none read. */
  visits?: Record<string, Time>;
  readAt?: string;
}

/** What the fake repo saw, in order, with the business scope each read ran under. */
export type RepoCall =
  | { call: "readTurnState"; request: ReadTurnStateRequest; scope: string | null }
  | { call: "readVisitTimes"; request: VisitTimesRequest; scope: string | null };

export interface FakeRepo extends FrontierRepo {
  readonly calls: RepoCall[];
  /** The scope a read runs under; the frontier scope sets it. */
  scope: string | null;
  /** Answer the next readTurnState with this instead (an error K-05 v1.2 allows). */
  nextTurnState?: ReadTurnStateAnswer;
  /** Answer the next readVisitTimes with this instead. */
  nextVisits?: VisitTimesAnswer;
}

/** A repo answering K-05 v1.2 readTurnState from `seed`, each request and answer held to K-05 v1.2's frozen schema. */
export function fakeRepo(seed: TurnSeed): FakeRepo {
  const repo: FakeRepo = {
    calls: [],
    scope: null,
    readTurnState(request) {
      repo.calls.push({ call: "readTurnState", request: structuredClone(request), scope: repo.scope });
      const requestProblems = k05Problems("readTurnState.request", request);
      if (requestProblems.length > 0) {
        throw new Error(`readTurnState.request breaks K-05 v1.2: ${requestProblems.join("; ")}`);
      }
      if (repo.nextTurnState !== undefined) {
        const answer = repo.nextTurnState;
        delete repo.nextTurnState;
        return Promise.resolve(answer);
      }
      if (request.handleId !== seed.handleId) {
        return Promise.resolve({ error: "notFound", table: "handles", rowId: request.handleId });
      }
      const facts: TurnState["facts"] = [];
      for (const fact of request.facts) {
        const table = String(fact.table);
        const row = seed.rows[table]?.[fact.rowId];
        if (row === undefined) return Promise.resolve({ error: "notFound", table, rowId: fact.rowId });
        // K-05 v1.2's factValue.value has no type in the schema ("the column's value now, or null"), which the
        // generator writes as an object type; the schema check below holds the answer to the contract itself.
        const value = (row[fact.column] ?? null) as TurnState["facts"][number]["value"];
        facts.push({ ...fact, value, version: row.version });
      }
      const answer: TurnState = {
        result: "turnState",
        handleId: seed.handleId,
        handle: seed.handle,
        businessId: request.businessId,
        readAt: seed.readAt ?? "2026-10-19T14:05:04Z",
        persons: seed.persons,
        roles: seed.roles,
        phone: seed.phone,
        openQuestions: seed.openQuestions.filter((row) => row.businessId === request.businessId),
        bookings: [],
        pauses: [],
        consents: [],
        facts,
      };
      const answerProblems = k05Problems("readTurnState.response", answer);
      if (answerProblems.length > 0) {
        throw new Error(`the fake's answer breaks K-05 v1.2: ${answerProblems.join("; ")}`);
      }
      return Promise.resolve(structuredClone(answer));
    },
    readVisitTimes(request) {
      repo.calls.push({ call: "readVisitTimes", request: structuredClone(request), scope: repo.scope });
      if (repo.nextVisits !== undefined) {
        const answer = repo.nextVisits;
        delete repo.nextVisits;
        return Promise.resolve(answer);
      }
      return Promise.resolve({
        result: "visits",
        visits: request.bookingIds.map((bookingId) => ({
          bookingId,
          visitAt: seed.visits?.[bookingId] ?? null,
        })),
      });
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------------------------------------------
// The scope

export type ScopeEvent =
  { what: "begin" } | { what: "scope"; businessId: string } | { what: "commit" } | { what: "rollback" };

export interface FrontierScope extends BusinessScope<FakeRepo> {
  readonly events: ScopeEvent[];
}

/** A business scope over the fake repo that records each transaction; the repo reads under the scope it sets. */
export function frontierScope(repo: FakeRepo): FrontierScope {
  const events: ScopeEvent[] = [];
  return {
    events,
    async withBusiness(businessId, work) {
      events.push({ what: "begin" }, { what: "scope", businessId });
      repo.scope = businessId;
      try {
        const result = await work(repo);
        events.push({ what: "commit" });
        return result;
      } catch (error) {
        events.push({ what: "rollback" });
        throw error;
      } finally {
        repo.scope = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The bundles: K-01 v1's sample bundles

/** A whole sample bundle (K-01 v1's root): its manifest and its flow graphs. */
export interface BundleDocument {
  manifest: Json;
  flows: Partial<Record<FlowLetter, unknown>>;
}

/** One of K-01 v1's sample bundles (contracts/bundle/fixtures), freshly parsed. */
export function sampleBundle(file: string): BundleDocument {
  const document = readJson(`bundle/fixtures/${file}`);
  if (!isRecord(document) || !isRecord(document.manifest) || !isRecord(document.flows)) {
    throw new Error(`${file} is not a K-01 v1 bundle`);
  }
  return { manifest: document.manifest, flows: document.flows };
}

/** A bundle document's id, from its manifest. */
export function bundleIdOf(document: BundleDocument): BundleId {
  const id = document.manifest.bundleId;
  if (!isRecord(id) || typeof id.hash !== "string" || typeof id.build !== "number") {
    throw new Error("the manifest names no bundle id");
  }
  return { hash: id.hash, build: id.build };
}

export interface FakeBundles extends FrontierBundles {
  /** Each read, in order: the manifest or a flow, by bundle key. */
  readonly reads: string[];
}

/** Bundles answering from sample bundle documents, by their manifests' ids. */
export function fakeBundles(...documents: BundleDocument[]): FakeBundles {
  const byKey = new Map(documents.map((document) => [bundleKey(bundleIdOf(document)), document]));
  const reads: string[] = [];
  return {
    reads,
    manifest(bundleId) {
      reads.push(`${bundleKey(bundleId)}/manifest`);
      return Promise.resolve(structuredClone(byKey.get(bundleKey(bundleId))?.manifest ?? null));
    },
    flow(bundleId, flow) {
      reads.push(`${bundleKey(bundleId)}/flow/${flow}`);
      return Promise.resolve(structuredClone(byKey.get(bundleKey(bundleId))?.flows[flow] ?? null));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The log

export interface LogCapture {
  lines: FrontierLogLine[];
  sink: (line: FrontierLogLine) => void;
}

export function captureLog(): LogCapture {
  const lines: FrontierLogLine[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

/** Every string anywhere in a value, keys excluded. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (isRecord(value)) return Object.values(value).flatMap((item) => stringsIn(item));
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// K-09 v1's build-frontier-s1-02.json and its stored state

/** The bundle v0 skeleton's id, which build-frontier-s1-02.json's turn pins. */
export const BUNDLE_V0: BundleId = {
  hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
  build: 1,
};

export interface FrontierExchange {
  call: "buildFrontier";
  request: Json & {
    caller: Json & { businessId: string; traceId: string };
    turn: Json;
    targets: Json & { openQuestionIds: string[] };
  };
  outcome: Json & { context: Json & { choices: Json[] } };
}

/** K-09 v1's build-frontier-s1-02.json, freshly parsed. */
export function s102Exchange(): FrontierExchange {
  return readJson("tool-api/fixtures/build-frontier-s1-02.json") as FrontierExchange;
}

/** Lee's Barbershop as K-04 v1's seed-business-head.json holds it. */
export const LEES_BARBERSHOP: SeedRow = {
  id: "biz-lees-barbershop",
  name: "Lee's Barbershop",
  display_name: "Lee's Barbershop",
  status: "live",
  time_zone: "America/New_York",
  text_hours_start: "08:00",
  text_hours_end: "20:00",
  version: 3,
};

/** An open question row as K-05 v1.2 reads it (K-04 v1 open_questions), with the fields a test sets. */
export function openQuestionRow(
  row: Partial<OpenQuestionRow> & Pick<OpenQuestionRow, "id" | "step">,
): OpenQuestionRow {
  return {
    businessId: "biz-lees-barbershop",
    bookingId: null,
    personId: "person-sam",
    turnId: "turn-s1-01-sam-join",
    status: "open",
    options: [],
    readback: null,
    versionsRead: [],
    clock: null,
    sentAt: "2026-10-19T14:02:00Z",
    pollId: null,
    askCount: 1,
    bundleId: BUNDLE_V0,
    version: 1,
    ...row,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// One call through the Tool API base

let validator: ToolApiValidator | undefined;
let checker: FrontierChecker | undefined;

/** The Tool API's validator and the frontier's checker, made once for the tests. */
export function checks(): { validator: ToolApiValidator; checker: FrontierChecker } {
  validator ??= createToolApiValidator();
  checker ??= createFrontierChecker();
  return { validator, checker };
}

export interface CallOptions {
  seed?: TurnSeed;
  repo?: FakeRepo;
  bundles?: FakeBundles;
  sources?: readonly SourceSlot[];
}

/** What one call left: its answer (or what it threw), the repo's reads, the transaction, the log and the span. */
export interface Called {
  answer: { ok: true; value: CallAnswer } | { ok: false; error: unknown };
  repo: FakeRepo;
  scope: FrontierScope;
  log: LogCapture;
  spans: Span[];
  bundles: FakeBundles;
}

/** One buildFrontier call through the Tool API base, over the fake repo (Sam's state) and bundle v0 by default. */
export async function callBuildFrontier(request: unknown, options: CallOptions = {}): Promise<Called> {
  const repo = options.repo ?? fakeRepo(options.seed ?? samSeed());
  const scope = frontierScope(repo);
  const log = captureLog();
  const bundles = options.bundles ?? fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  const handlers = frontierHandlers<FakeRepo>({
    bundles,
    log: log.sink,
    checker: checks().checker,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
  });
  const api = createToolApi({ validator: checks().validator, scope, handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("buildFrontier", structuredClone(request), trace).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { answer, repo, scope, log, spans, bundles };
}

/** A fixture choice as a source offers it: without its id. */
export function draftOf(choice: Json): DraftChoice {
  return Object.fromEntries(Object.entries(choice).filter(([key]) => key !== "choiceId")) as DraftChoice;
}

/** A stand-in for a slot not built yet, offering the given fixture choices. */
export function standIn(name: string, choices: readonly Json[]): FrontierSource {
  return { name, offer: () => ({ openQuestions: [], choices: choices.map(draftOf), cards: [] }) };
}

/**
 * Sam's stored state at S1-02 (build-frontier-s1-02.json's note: the guard lists his two owner roles and the open
 * question): his phone handle, his person row and owner role at Lee's Barbershop, the question S1-02 sent to him at
 * 14:02 under bundle v0 (context-s1-02.json's open question), the business and his name (K-04 v1 seeds).
 */
export function samSeed(): TurnSeed {
  return {
    handleId: "handle-sam",
    handle: { kind: "phone", address: "+15555550100" },
    persons: [{ personId: "person-sam", language: "en", version: 1 }],
    roles: [{ roleId: "role-sam-barbershop-owner", personId: "person-sam", role: "owner", version: 1 }],
    phone: {
      number: "+15555550100",
      stopped: false,
      stopAt: null,
      chatOpen: true,
      chatWay: "imessage",
      linqContactAddedAt: "2026-10-19T14:02:00Z",
      pollVotedAt: null,
      optoutLineDeliveredAt: "2026-10-19T14:02:00Z",
      version: 1,
    },
    openQuestions: [openQuestionRow({ id: "oq-s1-02", step: "S1-02" })],
    rows: {
      businesses: { "biz-lees-barbershop": LEES_BARBERSHOP },
      persons: { "person-sam": { id: "person-sam", name: "Sam Lee", language: "en", version: 1 } },
    },
  };
}
