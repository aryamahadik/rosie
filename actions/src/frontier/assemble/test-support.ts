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

// ---------------------------------------------------------------------------------------------------------------
// The master's steps around K-01 v1's sample bundles, for the stakes walk (fixture set v1: rule 9)
//
// Each is a step of the master (scratch/fixture-v1-copy/engine/work/master/master-A.json, read-only) written by hand
// in K-01 v1's shape with the fields the frontier reads: its type, who and via, needs, gives, title, its branches (each
// label word for word, its own steps by id, its end) and its next. What the compiler (C-065 to C-070, not built yet)
// adds is filled the way K-01 v1 defines it: each branch's tag (branch.tag: "message: the model may choose it; lookup:
// code settles it; clock: a clock row settles it"), where a merging branch rejoins (the step after its split, in
// bundle-mini-a's section order: A5-01, A5-19, A5-04, A5-31; A6-01, A6-10, A6-14, A6-15), and a message effect for a
// listed step that tells someone (as bundle-mini-a's A6-02 '2 Another time' shows).

/** A step as K-01 v1 holds it (a test's hand-written one), by its id. */
export interface StepJson extends Json {
  id: string;
  branches?: Json[];
}

/** A merging branch as K-01 v1 holds it. */
function merging(
  label: string,
  tag: string,
  steps: string[],
  rejoinAt: string | null,
  effects: Json[] = [],
): Json {
  return { label, tag, steps, end: "merge", rejoinAt, answerFields: [], effects };
}

/**
 * A5-01 (master-A.json, from line 13165): the customer picks on the secure page, each pick a branch its card's Means
 * lines define (message). 'None' has no steps of its own and rejoins at A5-19.
 */
export const MASTER_A5_01: StepJson = {
  type: "split",
  id: "A5-01",
  who: "cust",
  to: "san",
  via: "page",
  needs: ["contact"],
  title: "Any package, plan or discount code?",
  branches: [
    merging("None", "message", [], "A5-19"),
    merging("A discount code", "message", ["A5-02"], "A5-19"),
    merging("A package or membership", "message", ["A5-03"], "A5-19"),
    merging("Buys a pack or membership", "message", ["A5-22"], "A5-19"),
    merging("A repeat plan", "message", ["A5-21"], "A5-19"),
  ],
  next: "A5-19",
};

/**
 * A5-19 (from line 13467): Rosie reads the plug-in's rules (via auto, needs pf.rules; "Plug-in silent: no document"),
 * so code settles it: lookup. 'Yes: everyone signs' lists A5-20, where everyone signs on the page.
 */
export const MASTER_A5_19: StepJson = {
  type: "split",
  id: "A5-19",
  who: "san",
  via: "auto",
  needs: ["pf.rules"],
  title: "Does it need a document signed?",
  branches: [
    merging("No", "lookup", [], "A5-04"),
    merging("Yes: everyone signs", "lookup", ["A5-20"], "A5-04"),
  ],
  next: "A5-04",
};

/**
 * A6-01 (from line 14470): it follows the choice made on the page (A4-98), "never decided again", so code settles it:
 * lookup. Its 'Sam's OK first' lists A6-02 alone, the step bundle-mini-a holds (whose own next is null).
 */
export const MASTER_A6_01: StepJson = {
  type: "split",
  id: "A6-01",
  who: "san",
  via: "auto",
  needs: ["money_before"],
  title: "Books now, or asks first",
  branches: [
    merging("Right away", "lookup", [], "A6-10"),
    merging("Sam's OK first", "lookup", ["A6-02"], "A6-10"),
  ],
  next: "A6-10",
};

/** A6-03 (lines 14527-14539), the one step of A6-02's '1 Accept': a plain step at the end of its list. */
export const MASTER_A6_03: StepJson = {
  id: "A6-03",
  who: "pay",
  via: "sync",
  title: "Charges what's due on the OK",
  next: null,
};

/**
 * A6-10 (lines 15276-15289, its branches below): Rosie writes the booking, system to system (via sync), and it gives booked; which branch
 * follows is the write's own outcome, so code settles it: lookup.
 */
export const MASTER_A6_10: StepJson = {
  type: "split",
  id: "A6-10",
  who: "san",
  via: "sync",
  needs: ["time_saved"],
  gives: ["booked"],
  title: "Writes the booking",
  branches: [
    merging("Yes", "lookup", [], "A6-14"),
    merging("Taken a moment ago", "lookup", ["A6-11"], "A6-14", [
      { kind: "message", ref: "A6-11", to: ["cust"] },
    ]),
    merging("The charge fails", "lookup", ["A6-32"], "A6-14", [
      { kind: "message", ref: "A6-32", to: ["cust"] },
    ]),
  ],
  next: "A6-14",
};

/** A6-10 as the master writes it (lines 15276-15289, its branches below, their steps by id): no tags, no rejoinAt. */
export const MASTER_A6_10_AS_WRITTEN: StepJson = {
  type: "split",
  id: "A6-10",
  who: "san",
  via: "sync",
  needs: ["time_saved"],
  gives: ["booked"],
  title: "Writes the booking",
  branches: [
    { label: "Yes", steps: [], end: "merge" },
    { label: "Taken a moment ago", steps: ["A6-11"], end: "merge" },
    { label: "The charge fails", steps: ["A6-32"], end: "merge" },
  ],
};

/** A sample bundle (a fresh copy) with more steps in its flow A, by id, and partial or not. */
export function withSteps(
  document: BundleDocument,
  steps: readonly StepJson[],
  partial = true,
): BundleDocument {
  const copy = structuredClone(document);
  copy.manifest.partial = partial;
  const flow = copy.flows.A;
  if (!isRecord(flow) || !isRecord(flow.steps)) throw new Error("the bundle holds no flow A");
  for (const step of steps) flow.steps[step.id] = structuredClone(step);
  return copy;
}
