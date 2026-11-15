// T-1400 (the D-017 path audit's SR): staging binds the turn's directory over K-05 v1.11's readTurnParty through the job
// handle (./state-reads.ts), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key STATE_READS): this
// file's own database, migrated, with bundle v0 active and one handle seeded for each of the nine accepted
// read-turn-party-* fixtures (./state-reads.seed.ts: four exactly, five in their fixture's shape on this file's own
// ids, since six of the nine ask about one number in states one database cannot hold together), reached through its own
// pool pair only, HYPERDRIVE_JOB_STATE_READS and HYPERDRIVE_APP_STATE_READS, handed in as the env's HYPERDRIVE_JOB and
// HYPERDRIVE_APP behind doubles that count each read of a connection string. Each root here is built as the Worker's is
// (../root.ts workerRoot: composeRoot over stagingOptions(env)), through the two seams stagingOptions names: its handle
// (./part.ts stagingDb), so a test reads T-1254's counts and each call's timing line, and its builders, every part but
// this card's stood in by its nothing-bound answer, so a test sees this card's binding alone whatever the other parts
// bind (DL-776). The cases that go through workerRoot itself, every part's own builder with it, assert on this card's
// own reads and answers alone. Every database call a test makes of its own goes through T-1254's handle too.
//
//   - the mapping (turnPartyOf) on each fixture's own answer, as K-05 v1.11's binding line maps it: atBusiness field by
//     field, noBusiness with the zone UTC, unknown and every businessUndecided reason null, transient thrown;
//   - partyOf by direct call through the root (Root.turn.directory, the object the turn and the park read): the nine
//     fixtures' cases on this file's rows, each the fixture's K-05 answer (under the stand-in's ids where it is one) and
//     the party the binding line maps it to; one job-side client per call; the handle alone is sent, never the actor's
//     name; a kind K-06 does not have is refused before any statement;
//   - a turn's first run (runTurnLoop through that root's install(), every other input on its double, as
//     ../state-reads.worker.test.ts runs one): test owner 1's JOIN runs under biz-lees-barbershop, its texts' dates in
//     America/New_York, the frontier asked under that business and answering the sign-up door whose target is Lee's
//     Barbershop, as build-frontier-s1-01.json has it, and commits; the first text's number runs with no business and its
//     dates in UTC; the unknown number and each undecided case end unknownHandle with nothing opened, decided or written,
//     and the park (parkThroughRows) is refused the same way, while test owner 1's park parks under his party;
//   - failing: K-05's transient answer (the read's connection cut under it), the guard's refusal (the file's two
//     bindings crossed), a database that is not there (the pool's own HYPERDRIVE_JOB) and DB_SCHEMA set each throw, by a
//     call's name and SQLSTATE or the guard's labels alone, and a run ends noDirectory with nothing opened, read or
//     written;
//   - unbound (no HYPERDRIVE_JOB): partyOf fails closed (NoStateReadError "partyOf"), nothing read; idsOf and isStopped
//     fail closed (NoStateReadError) on every root, as before this card; production: the builder reads ENVIRONMENT alone,
//     the port stays closed, no binding read;
//   - HYPERDRIVE_APP is read 0 times throughout, opened equals ended after every test, no row count moves, and no span or
//     log line holds a 555-01xx number in any form.
// Test values only (rule 9): the contracts' fixtures, the master's sample cast and the fiction range's numbers.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import fixtureIndex from "@rosie/contracts/data-access/fixtures/index.json";
import firstText from "@rosie/contracts/data-access/fixtures/read-turn-party-first-text.json";
import handedOver from "@rosie/contracts/data-access/fixtures/read-turn-party-handed-over.json";
import oneRole from "@rosie/contracts/data-access/fixtures/read-turn-party-one-role.json";
import ownerRoleEnded from "@rosie/contracts/data-access/fixtures/read-turn-party-owner-role-ended.json";
import severalBusinesses from "@rosie/contracts/data-access/fixtures/read-turn-party-several-businesses.json";
import severalCompanies from "@rosie/contracts/data-access/fixtures/read-turn-party-several-companies.json";
import signUpBeforeBusiness from "@rosie/contracts/data-access/fixtures/read-turn-party-sign-up-before-business.json";
import testOwner1 from "@rosie/contracts/data-access/fixtures/read-turn-party-test-owner-1.json";
import unknownNumber from "@rosie/contracts/data-access/fixtures/read-turn-party-unknown.json";
import buildFrontierS101 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-01.json";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { Tx } from "@rosie/db/repo/scope";
import {
  readTurnParty,
  type ReadTurnPartyOutcome,
  type ReadTurnPartyRequest,
} from "@rosie/db/repo/turn-party";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import bundleV0Kv from "../../../../bundles/v0/bundle.kv.json";
import type { CommitAnswer, CommitContext, CommitTurnRequest, LeasedTurn, ParkingTurn } from "../../actor";
import { turnIdOf } from "../../actor/lease";
import type { PinnedBundle } from "../../bundle";
import { actorNameOf, type HandleRef, type SealingKeyStore } from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { openTrace, type Span } from "../../trace";
import { leaks } from "../../trace/hop-check";
import { parkThroughRows } from "../../turn/park";
import { checkedManifest, safetyNoFor, storedText } from "../../turn/test-support";
import { commitThroughToolApi, runTurnLoop, setTurnDeps } from "../../turn/turn";
import type { BuildFrontierAnswer, BuildFrontierRequest, TurnParty } from "../../turn/types";
import {
  composeRoot,
  environmentOf,
  lastTextSourceOf,
  NotJoinedError,
  withTextSource,
  workerRoot,
  type Root,
} from "../index";
import { NoStateReadError } from "../real";
import {
  BUNDLE_V0,
  fakeHandleTargets,
  JOIN_TEXT,
  skeletonFakes,
  TEST_OWNER_1,
  type SkeletonFakes,
} from "../test-support";
import { dbHandle, DbClosedError, DbGuardRefusal, type DbHandle } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type DbCallLine, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import {
  NO_BUSINESS_ZONE,
  NO_DIRECTORY_INPUTS,
  READ_TURN_PARTY_CALL,
  stagingDirectories,
  turnPartyOf,
  TurnPartyTransientError,
} from "./state-reads";
import {
  HANDED_OVER,
  NEW_OWNER_PERSON,
  ROLE_ENDED,
  SIGNING_UP,
  STAND_IN_BUSINESSES,
  STAND_INS,
  THREE_ROLES,
  TWO_COMPANIES,
  type StandIn,
} from "./state-reads.seed";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "STATE_READS";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own job binding: its database, rosie_rig_none, is never made, so a connect through it fails. */
const POOL_OWN_JOB = "HYPERDRIVE_JOB";

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

const UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/u;

// ---- the nine accepted fixtures, and their cases on this file's rows --------------------------------------------------

/** A readTurnParty exchange as its fixture file holds it. */
interface PartyFixture {
  readonly request: { readonly handle: HandleRef };
  readonly outcome: ReadTurnPartyOutcome;
}

const FIXTURES = {
  "read-turn-party-test-owner-1.json": testOwner1,
  "read-turn-party-one-role.json": oneRole,
  "read-turn-party-first-text.json": firstText,
  "read-turn-party-sign-up-before-business.json": signUpBeforeBusiness,
  "read-turn-party-unknown.json": unknownNumber,
  "read-turn-party-several-businesses.json": severalBusinesses,
  "read-turn-party-several-companies.json": severalCompanies,
  "read-turn-party-handed-over.json": handedOver,
  "read-turn-party-owner-role-ended.json": ownerRoleEnded,
} as unknown as Readonly<Record<string, PartyFixture>>;

function fixtureOf(name: string): PartyFixture {
  const found = FIXTURES[name];
  if (found === undefined) throw new Error(`this file holds no fixture ${name}`);
  return found;
}

/**
 * What the turn's directory answers for each fixture's own answer, as K-05 v1.11's binding line maps it, written out
 * here value for value: atBusiness as it stands, noBusiness with the zone UTC, unknown and businessUndecided null.
 */
const MAPPED: Readonly<Record<string, TurnParty | null>> = {
  "read-turn-party-test-owner-1.json": {
    handleId: "handle-sam",
    businessId: "biz-lees-barbershop",
    personId: "person-sam",
    zone: "America/New_York",
  },
  "read-turn-party-one-role.json": {
    handleId: "handle-riley",
    businessId: "biz-lees-barbershop",
    personId: "person-riley",
    zone: "America/New_York",
  },
  "read-turn-party-first-text.json": {
    handleId: "handle-gw-0108",
    businessId: null,
    personId: "person-gw-0108",
    zone: "UTC",
  },
  "read-turn-party-sign-up-before-business.json": {
    handleId: "handle-sam",
    businessId: null,
    personId: "person-sam",
    zone: "UTC",
  },
  "read-turn-party-unknown.json": null,
  "read-turn-party-several-businesses.json": null,
  "read-turn-party-several-companies.json": null,
  "read-turn-party-handed-over.json": null,
  "read-turn-party-owner-role-ended.json": null,
};

function mappedOf(name: string): TurnParty | null {
  const found = MAPPED[name];
  if (found === undefined) throw new Error(`this file maps no fixture ${name}`);
  return found;
}

/** The businessUndecided fixtures, with the reason each one's answer carries. */
const UNDECIDED: Readonly<Record<string, string>> = {
  "read-turn-party-several-businesses.json": "severalBusinesses",
  "read-turn-party-several-companies.json": "severalBusinesses",
  "read-turn-party-handed-over.json": "anotherOwner",
  "read-turn-party-owner-role-ended.json": "roleEnded",
};

/** One fixture's case on this file's rows. */
interface PartyCase {
  /** The fixture's file name. */
  readonly name: string;
  /** The handle a text carries: the fixture's own request's, or its stand-in's. */
  readonly handle: HandleRef;
  /** What K-05 answers on this file's rows: the fixture's own answer, under the stand-in's ids where it is one. */
  readonly answer: ReadTurnPartyOutcome;
  /** What the directory answers: the binding line's mapping of that answer. */
  readonly party: TurnParty | null;
  /** The stand-in whose rows hold the fixture's shape, or null where the fixture's own rows are seeded. */
  readonly standIn: StandIn | null;
}

/** A fixture whose own rows this file's database holds: its own request and answer. */
function exactly(name: string): PartyCase {
  const fixture = fixtureOf(name);
  return {
    name,
    handle: fixture.request.handle,
    answer: fixture.outcome,
    party: mappedOf(name),
    standIn: null,
  };
}

/**
 * A fixture in its shape on a stand-in's rows. Every Sam fixture answers handle-sam and person-sam; the stand-in's answer
 * differs in those two ids and in nothing else, and its party likewise.
 */
function standingIn(standIn: StandIn): PartyCase {
  const fixture = fixtureOf(standIn.fixture);
  const party = mappedOf(standIn.fixture);
  return {
    name: standIn.fixture,
    handle: standIn.handle,
    answer: { ...fixture.outcome, handleId: standIn.handleId, personId: standIn.personId },
    party: party === null ? null : { ...party, handleId: standIn.handleId, personId: standIn.personId },
    standIn,
  };
}

const TEST_OWNER_1_CASE = exactly("read-turn-party-test-owner-1.json");
const FIRST_TEXT_CASE = exactly("read-turn-party-first-text.json");
const UNKNOWN_CASE = exactly("read-turn-party-unknown.json");

/** The nine cases, in the card's order. */
const CASES: readonly PartyCase[] = [
  TEST_OWNER_1_CASE,
  exactly("read-turn-party-one-role.json"),
  FIRST_TEXT_CASE,
  standingIn(SIGNING_UP),
  UNKNOWN_CASE,
  standingIn(THREE_ROLES),
  standingIn(TWO_COMPANIES),
  standingIn(HANDED_OVER),
  standingIn(ROLE_ENDED),
];

/** The cases the directory answers null for: the unknown number and each undecided one. */
const NO_PARTY_CASES = CASES.filter((each) => each.party === null);

/** Test owner 1, as the fixtures name him. */
const SAM = TEST_OWNER_1_CASE.handle;
const SAM_PARTY = mappedOf("read-turn-party-test-owner-1.json");

/** Every number a case's handle holds, in each form a number could leak in. */
const NUMBER_FORMS = CASES.flatMap(({ handle: { address } }) => [
  address,
  address.slice(1),
  address.slice(2),
  `${address.slice(5, 8)}-${address.slice(8)}`,
]);
const ANY_FICTION_NUMBER = /55555501[0-9]{2}|555-01[0-9]{2}/u;

// ---- bundle v0 and the JOIN run, as the recordings hold them ----------------------------------------------------------

/** Bundle v0's manifest as bundles/v0 publishes it. */
function manifestText(): string {
  const found = bundleV0Kv.find((part) => part.key.endsWith("/manifest"));
  if (found === undefined) throw new Error("bundles/v0 holds no manifest");
  return found.value;
}

/** The JOIN run's own text (ai/recordings/contexts/join-s1-01.json): its event id, words and send time. */
const [JOIN_RUN_TEXT] = joinRunContext.texts;
if (JOIN_RUN_TEXT === undefined) throw new Error("the JOIN run's recorded context holds no text");
const JOIN = { eventId: JOIN_RUN_TEXT.eventId, sentAt: JOIN_RUN_TEXT.sentAt.utc } as const;

const TURN_ONE = buildFrontierS101 as unknown as {
  readonly request: BuildFrontierRequest & {
    readonly targets: unknown;
    readonly texts: readonly { readonly sentAt: { readonly zone: string } }[];
  };
  readonly outcome: { readonly context: { readonly choices: readonly Record<string, unknown>[] } };
};

// ---- what the whole file captures: every span and every log line ------------------------------------------------------

/** Every span a test's turn or park wrote, and every line written to the console or as a call's timing, across the file. */
const SPANS: Span[] = [];
const LOGGED: string[] = [];
/** The lines of the test that is running. */
let testLog: string[] = [];

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

// ---- the env a root is built over -------------------------------------------------------------------------------------

/** A double over a pool binding that counts the reads of its connection string, and gives the pool binding's. */
interface CountedBinding {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

function counted(binding: Hyperdrive): CountedBinding {
  const reads = { n: 0 };
  return {
    binding: {
      get connectionString(): string {
        reads.n += 1;
        return binding.connectionString;
      },
    },
    reads,
  };
}

interface TestEnv {
  readonly env: StagingEnv;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
  /** The counting double handed in as HYPERDRIVE_JOB; null where the env has none. */
  readonly job: CountedBinding | null;
  /** The counting double handed in as HYPERDRIVE_APP, in every env. */
  readonly app: CountedBinding;
}

interface EnvOptions {
  readonly environment?: string;
  /** The pool binding handed in as HYPERDRIVE_JOB (default: this file's own); null for none. */
  readonly job?: string | null;
  readonly schema?: string;
}

/**
 * Every env a test built, the envs of the roots that bind this card's part alone, and every handle: checked after each
 * test (HYPERDRIVE_APP's string never read; by this card's part, not by its name either; opened equals ended).
 */
const ENVS: TestEnv[] = [];
const DIRECTORY_ONLY_ENVS: TestEnv[] = [];
const HANDLES: Pick<DbHandle, "counts">[] = [];

/**
 * Every part but this card's, stood in by its nothing-bound answer (each stub's own, as T-1257 made it), so a root built
 * with these shows this card's binding alone, whatever the other parts bind once their cards land (DL-776).
 */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  turn: () => NO_TURN_CALL_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  bundleSafety: () => null,
  gate: () => null,
  rows: () => NO_ROW_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
};

/** The Worker's env as wrangler.jsonc's vars give it, with this file's pair behind counting doubles. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const jobName = options.job === undefined ? JOB : options.job;
  const job = jobName === null ? null : counted(poolBinding(jobName));
  const app = counted(poolBinding(APP));
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: options.schema ?? "",
    GIT_SHA: "test-sha",
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    HYPERDRIVE_APP: app.binding,
  };
  const env = new Proxy(values, {
    get(target, name, receiver): unknown {
      if (typeof name === "string") names.push(name);
      return Reflect.get(target, name, receiver);
    },
    has(target, name): boolean {
      if (typeof name === "string") names.push(name);
      return Reflect.has(target, name);
    },
  });
  const made: TestEnv = { env: env as unknown as StagingEnv, names, job, app };
  ENVS.push(made);
  return made;
}

/** A handle of the test's own on this file's job binding (T-1254's, its quiet socket), for a read or a cut of its own. */
function ownHandle(): DbHandle {
  const handle = dbHandle({ ENVIRONMENT: "staging", DB_SCHEMA: "", HYPERDRIVE_JOB: poolBinding(JOB) });
  HANDLES.push(handle);
  return handle;
}

interface Staged {
  /** The root's one handle (T-1254's, through ./part.ts): its counts are the root's. */
  readonly db: StagingDb;
  /** What stagingOptions gave: this card's inputs, every other part's null. */
  readonly inputs: StagingInputs;
  /** Each call's timing line the handle wrote, in order. */
  readonly lines: () => DbCallLine[];
}

/** The root's handle over the test's env, and staging's inputs with this card's part the only one bound. */
function stagedOver(testEnv: TestEnv): Staged {
  const written: string[] = [];
  const db = stagingDb(testEnv.env, {
    write: (line) => {
      written.push(line);
      LOGGED.push(line);
    },
  });
  HANDLES.push(db);
  DIRECTORY_ONLY_ENVS.push(testEnv);
  const inputs = stagingOptions(testEnv.env, { db, builders: EVERY_OTHER_PART_UNBOUND });
  return { db, inputs, lines: () => written.map((line) => JSON.parse(line) as DbCallLine) };
}

interface Rooted extends Staged {
  readonly root: Root;
}

/**
 * A root built as workerRoot builds the Worker's (composeRoot over stagingOptions(env)), over the test's env, with its
 * handle kept for the test to read, and this card's part (./state-reads.ts stagingDirectories, as STAGING_BUILDERS holds
 * it) the only one bound.
 */
function rootOver(testEnv: TestEnv): Rooted {
  const staged = stagedOver(testEnv);
  const root = composeRoot({
    environment: environmentOf(testEnv.env),
    actors: null,
    vars: testEnv.env,
    ...staged.inputs,
  });
  return { ...staged, root };
}

interface Turned extends Rooted {
  readonly fakes: SkeletonFakes;
}

/**
 * The same root with every other input on its double (../test-support.ts skeletonFakes, as
 * ../state-reads.worker.test.ts's rootFor hands them), so a run of a turn goes on past its directory, and a test sees
 * that no key, model, database double or line is reached where a run must end before them. The state reads' and the plan
 * calls' other inputs (bundleSafety, handleDirectory, stoppedFlags, planCalls) stay null, as that file leaves them.
 */
function turnRootOver(
  testEnv: TestEnv,
  fakes: SkeletonFakes = skeletonFakes(),
  handleTargets = fakes.handleTargets.call,
): Turned {
  const staged = stagedOver(testEnv);
  const root = composeRoot({
    environment: environmentOf(testEnv.env),
    actors: null,
    vars: testEnv.env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    ...staged.inputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    retryQueue: fakes.retryQueue,
    armingCalls: fakes.arming.calls,
  });
  return { ...staged, root, fakes };
}

/** How many calls each double the root was handed has taken: a key, a model, the database or the line. */
function reached(fakes: SkeletonFakes): Record<string, number> {
  return {
    handleKeys: fakes.handleKeys.requests.length,
    chatOpens: fakes.dispatch.chatOpens.length,
    safetyModels: fakes.models.calls.length,
    commits: fakes.turnRows.commits.length,
    parks: fakes.turnRows.parks.length,
    bundleReads: fakes.bundleReads.reads.length,
    targets: fakes.handleTargets.requests.length,
    frontierReads: fakes.frontier.reads.length,
    decideModels: fakes.decide.calls.length,
    gateScopes: fakes.gate.scopes.length,
    composeScopes: fakes.compose.scopes.length,
    composerModels: fakes.composer.calls.length,
    finalizeScopes: fakes.finalize.scopes.length,
    planWrites: fakes.finalize.writes.length,
    claims: fakes.dispatch.claims.length,
    sendStates: fakes.dispatch.stateReads.length,
    linqSends: fakes.linq.requests.length,
    arms: fakes.arming.arms.length,
  };
}

function nothingReached(fakes: SkeletonFakes): Record<string, number> {
  return Object.fromEntries(Object.keys(reached(fakes)).map((double) => [double, 0]));
}

// ---- a run of a turn, as the lease hands it ---------------------------------------------------------------------------

interface Leased {
  readonly turn: LeasedTurn;
  /** Every span the turn's trace kept, in order. */
  readonly spans: Span[];
  /** Every commit the run sent through its lease, with the answer it got, in order. */
  readonly commits: { request: CommitTurnRequest; answer: CommitAnswer }[];
  /** The same turn as the lease hands it to the park, after its third lapse with no commit. */
  readonly parking: ParkingTurn;
}

/**
 * A run of a turn as the lease hands it (LeasedTurn), built as ../../turn/test-support.ts testTurn builds one, on the
 * text's own trace id (the real frontier port's base checks that a call names the trace it runs in): one text from
 * `handle`, the JOIN run's own (its event id, words and send time, so the turn id is the recorded run's), sealed by the
 * gateway's own hand-off under `keys`; bundle v0's manifest as its pinned bundle's; its commit the lease's, emulated
 * (the turn's own commit hook with a CommitContext of no hold); and each text's safety result as the lease answers it
 * from the actor's kept results: safety-no.json's under the text's event id.
 */
async function leasedTurn(handle: HandleRef, keys: SealingKeyStore): Promise<Leased> {
  const traceId = crypto.randomUUID();
  const entry = await storedText(
    { eventId: JOIN.eventId, body: JOIN_TEXT, sentAt: JOIN.sentAt, traceId },
    handle,
    keys,
    BUNDLE_V0,
    1,
  );
  const spans: Span[] = [];
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: BUNDLE_V0,
    incomingTraceId: traceId,
    sink: (span) => {
      spans.push(span);
      SPANS.push(span);
    },
  });
  const turnId = await turnIdOf([JOIN.eventId]);
  trace.setTurn(turnId);
  const context: CommitContext = { holds: [], unread: [] };
  const commits: Leased["commits"] = [];
  const bundle: PinnedBundle = {
    bundleId: BUNDLE_V0,
    manifest: await checkedManifest({ manifest: JSON.parse(manifestText()) as unknown }, BUNDLE_V0),
    flow: () => Promise.reject(new Error("the turn reads no flow here")),
    trade: () => Promise.reject(new Error("the turn reads no trade here")),
    reads: () => [],
  };
  const turn: LeasedTurn = {
    turnId,
    eventIds: [JOIN.eventId],
    entries: [entry],
    traceId,
    joinedTraceIds: [],
    tries: 1,
    restart: false,
    leaseUntil: 60_000,
    signal: new AbortController().signal,
    async commit(request) {
      let answer: CommitAnswer;
      if (request.turn.id !== turnId) answer = { error: "wrongTurn" };
      else {
        try {
          answer = await commitThroughToolApi(request, context);
        } catch {
          answer = { error: "noAnswer" };
        }
      }
      commits.push({ request, answer });
      return answer;
    },
    replied: () => Promise.resolve(),
    resultsOf: (asked) =>
      Promise.resolve(
        [...new Set(asked)]
          .filter((eventId) => eventId === JOIN.eventId)
          .map((eventId) => safetyNoFor(eventId)),
      ),
    bundleId: BUNDLE_V0,
    bundle,
    trace,
    holds: context.holds,
  };
  const parking: ParkingTurn = {
    turnId,
    eventIds: [JOIN.eventId],
    entries: [entry],
    traceId,
    joinedTraceIds: [],
    tries: 3,
    bundleId: BUNDLE_V0,
    trace,
  };
  return { turn, spans, commits, parking };
}

/** One buildFrontier the turn handed the root: the request as the turn made it, and what the frontier port answered. */
interface WatchedFrontier {
  readonly request: BuildFrontierRequest;
  /** What the root's frontier port answered (or threw), once it has. */
  answer: unknown;
}

/**
 * Watches the turn's buildFrontier on a root whose actor ports are installed (call it after `root.install()`), as
 * ../test-support.ts watchGate watches the gate: each call the turn makes is kept, as the turn made it, then goes on to
 * the root's own call unchanged, its answer kept beside it. A test's observer only.
 *
 * And the one thing the root's lease hooks do for a run the lease starts that a run started here goes without: they keep
 * the run's last text's service and chat id under its trace, and the root's gateAndCommit puts them on the request's
 * turn (../turn-chats.ts; K-09 v1.5 default 135). Here the same two values, read from the turn's last text by the same
 * function, are put on the request the same way before it goes on to the root's own gateAndCommit, unchanged otherwise.
 */
function watchRun(root: Root, turn: LeasedTurn): { readonly calls: WatchedFrontier[]; restore(): void } {
  const calls: WatchedFrontier[] = [];
  const source = lastTextSourceOf(turn);
  const restore = setTurnDeps({
    ...root.turn,
    toolApi: {
      ...root.turn.toolApi,
      async buildFrontier(request, trace) {
        const call: WatchedFrontier = { request: structuredClone(request), answer: undefined };
        calls.push(call);
        try {
          call.answer = await root.turn.toolApi.buildFrontier(request, trace);
        } catch (error) {
          call.answer = error;
          throw error;
        }
        return call.answer as BuildFrontierAnswer;
      },
      gateAndCommit: (request, at, trace) =>
        root.turn.toolApi.gateAndCommit(withTextSource(request, source), at, trace),
    },
  });
  return { calls, restore };
}

interface FirstRun {
  readonly outcome: Awaited<ReturnType<typeof runTurnLoop>>;
  readonly frontier: WatchedFrontier[];
}

/** One run of the turn through the root's installed ports, its frontier calls watched. */
async function firstRun(root: Root, turn: LeasedTurn): Promise<FirstRun> {
  const restore = root.install();
  const watch = watchRun(root, turn);
  try {
    return { outcome: await runTurnLoop(turn), frontier: watch.calls };
  } finally {
    watch.restore();
    restore();
  }
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** What a promise settled with: kept, so a call started before a wait never rejects with nothing to catch it. */
type Settled<T> = { readonly answered: T } | { readonly failed: unknown };

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (answered) => ({ answered }),
    (failed: unknown) => ({ failed }),
  );
}

/** The directory's request for a handle, as the turn and the park make it. */
const requestOf = (handle: HandleRef): { actorName: string; handle: HandleRef } => ({
  actorName: actorNameOf(handle),
  handle,
});

/** K-05 v1.11's own answer for a handle on this file's rows, read on the runtime side through a handle of the test's own. */
function k05Answer(handle: HandleRef): Promise<ReadTurnPartyOutcome> {
  return ownHandle().runtime(READ_TURN_PARTY_CALL, (sql) =>
    readTurnParty(sql, { handle } as ReadTurnPartyRequest),
  );
}

/** The row count of each table the read reads, or a turn's commit or park writes. */
interface RowCounts {
  readonly businesses: number;
  readonly persons: number;
  readonly handles: number;
  readonly person_handles: number;
  readonly person_roles: number;
  readonly companies: number;
  readonly turns: number;
  readonly outbox_rows: number;
  readonly event_log: number;
}

/**
 * Those row counts in this file's database, read on the runtime side through a handle of the test's own (rosie_job with
 * no business scope sees every business's rows).
 */
async function rowCounts(): Promise<RowCounts> {
  const rows = await ownHandle().runtime(
    "rowCounts",
    (sql) => sql<RowCounts[]>`
      select (select count(*) from businesses)::int as businesses,
             (select count(*) from persons)::int as persons,
             (select count(*) from handles)::int as handles,
             (select count(*) from person_handles)::int as person_handles,
             (select count(*) from person_roles)::int as person_roles,
             (select count(*) from companies)::int as companies,
             (select count(*) from turns)::int as turns,
             (select count(*) from outbox_rows)::int as outbox_rows,
             (select count(*) from event_log)::int as event_log`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error("the row counts were not read");
  return { ...row };
}

/** What the seed wrote (./state-reads.seed.ts), and nothing since: no test of this file writes a row. */
const SEEDED_ROWS: RowCounts = {
  // Lee's Barbershop, and the stand-ins' seven.
  businesses: 8,
  // Sam, Riley, the first text's person, the five stand-ins and the hand-over's new owner.
  persons: 9,
  handles: 8,
  person_handles: 8,
  // Riley's, the three live owner roles, the new owner's and the ended one.
  person_roles: 6,
  // Lee's Barbershop's, and the stand-ins' six.
  companies: 7,
  turns: 0,
  outbox_rows: 0,
  event_log: 0,
};

/**
 * A backend of this database, of this login, that waits on a lock: the read under way. Asked until there is one, each
 * time on a fresh reading (inside a transaction PostgreSQL keeps the first one it gave until the transaction ends).
 */
async function waitingBackend(tx: Tx): Promise<number> {
  for (let asked = 0; asked < 400; asked += 1) {
    await tx`select pg_stat_clear_snapshot()`;
    const waiting = await tx<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and usename = current_user and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'`;
    const [only] = waiting;
    if (waiting.length === 1 && only !== undefined) return only.pid;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("no read ever waited on the lock");
}

/**
 * Starts `read` (one readTurnParty for a handle a person writes from) and cuts its connection under it: a job-side client
 * of the test's own locks person_roles (rosie_job may: it holds UPDATE on it), so the read waits at item 52's third
 * read; the one backend of this database that then waits on a lock is the read's, and it is ended (pg_terminate_backend,
 * which a login may send its own sessions; never a backend of another database). The read's statement in flight fails
 * with its connection lost, which K-05 answers transient. Resolves with what `read` settled with, after the lock is gone.
 */
async function cutUnder<T>(read: () => Promise<T>): Promise<Settled<T>> {
  const started = await ownHandle().runtime("cutTheRead", (sql) =>
    sql.begin(async (tx) => {
      await tx`lock table person_roles in access exclusive mode`;
      const reading = settled(read());
      const pid = await waitingBackend(tx);
      const ended = await tx<{ ended: boolean }[]>`select pg_terminate_backend(${pid}) as ended`;
      if (ended[0]?.ended !== true) throw new Error("the read's backend was not ended");
      // Handed out in an object, so the transaction ends without waiting for the read.
      return { reading };
    }),
  );
  return started.reading;
}

/** Whether `text` holds `part` as a whole name (not inside a longer name, such as rosie inside rosie_job). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/**
 * The texts an error gives away: its message, its stack but for the frames (code locations), its own fields as JSON, each
 * own property's value, and the error as a string.
 */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  const fields = error as unknown as Record<string, unknown>;
  const own = Object.getOwnPropertyNames(error)
    .filter((name) => name !== "stack")
    .map((name) => {
      // A property that holds no JSON value (undefined, a function) gives no text.
      const text = JSON.stringify(fields[name]) as string | undefined;
      return text ?? "";
    });
  return [error.message, stack, JSON.stringify(error), String(error), ...own];
}

/** No text holds the binding's string, host, user, password or database, nor a number of the fiction range. */
function expectNothingOf(binding: { readonly connectionString: string }, error: unknown): void {
  const url = new URL(binding.connectionString);
  const parts = [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of textsOf(error)) {
    for (const part of parts) {
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
    }
    expect(ANY_FICTION_NUMBER.test(text), "a text holds a number").toBe(false);
  }
}

/** Each timing line is the runtime side's read: HYPERDRIVE_JOB, the login rosie_worker_job, on no trace. */
function expectPartyReads(lines: readonly DbCallLine[], reads: number): void {
  expect(lines).toHaveLength(reads);
  for (const line of lines) {
    expect(line).toEqual({
      level: "info",
      msg: "dbCall",
      trace_id: null,
      call: READ_TURN_PARTY_CALL,
      side: "runtime",
      binding: "HYPERDRIVE_JOB",
      login: "rosie_worker_job",
      connect: { at: expect.stringMatching(UTC_TEXT) as string, ms: expect.any(Number) as number },
      guard: { at: expect.stringMatching(UTC_TEXT) as string, ms: expect.any(Number) as number },
      environment: "staging",
      version: "test-sha",
    });
  }
}

/** The JSON lines among a test's console lines whose `msg` is this one, in order. */
function jsonLinesOf(lines: readonly string[], msg: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === "object" && value !== null && (value as { msg?: unknown }).msg === msg) {
      found.push(value as Record<string, unknown>);
    }
  }
  return found;
}

beforeEach(() => {
  testLog = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    testLog.push(line);
    LOGGED.push(line);
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
  // The job side only: HYPERDRIVE_APP's connection string is never read for this read, and this card's part never reads
  // HYPERDRIVE_APP by its name either; no binding named HYPERDRIVE is read at all.
  for (const made of ENVS) {
    expect(made.app.reads.n).toBe(0);
    expect(made.names).not.toContain("HYPERDRIVE");
  }
  for (const made of DIRECTORY_ONLY_ENVS) expect(made.names).not.toContain("HYPERDRIVE_APP");
});

// ---- the rig ----------------------------------------------------------------------------------------------------------

describe("this file's database on the rig", () => {
  it("is this run's own, and the nine cases are K-05 v1.11's nine accepted readTurnParty fixtures, four on their own rows and five on a stand-in's", () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_state_reads$/u);
    const accepted = (
      fixtureIndex as unknown as {
        fixtures: { file: string; def?: string; expect: string }[];
      }
    ).fixtures
      .filter((entry) => entry.expect === "accept" && entry.def === "readTurnParty.exchange")
      .map((entry) => entry.file);
    expect(accepted).toHaveLength(9);
    expect(CASES.map((each) => each.name).sort()).toEqual([...accepted].sort());
    expect(Object.keys(FIXTURES).sort()).toEqual([...accepted].sort());
    expect(CASES.filter((each) => each.standIn === null).map((each) => each.name)).toEqual([
      "read-turn-party-test-owner-1.json",
      "read-turn-party-one-role.json",
      "read-turn-party-first-text.json",
      "read-turn-party-unknown.json",
    ]);
    expect(STAND_INS).toHaveLength(5);
    // Each case asks about a handle of its own, every number a whole one of the fiction range.
    const numbers = CASES.map((each) => each.handle.address);
    expect(new Set(numbers).size).toBe(9);
    for (const number of numbers) expect(number).toMatch(/^\+155555501[0-9]{2}$/u);
    // A stand-in's fixture asks about test owner 1's number and answers his ids: what its stand-in differs in.
    for (const standIn of STAND_INS) {
      const fixture = fixtureOf(standIn.fixture);
      expect(fixture.request.handle).toEqual(SAM);
      expect(fixture.outcome).toMatchObject({ handleId: "handle-sam", personId: "person-sam" });
      expect(standIn.handle.address).not.toBe(SAM.address);
    }
    // No stand-in's business is the barbershop, so test owner 1's party stands beside them.
    const standInBusinesses: string[] = [
      ...STAND_IN_BUSINESSES.threeRoles,
      ...STAND_IN_BUSINESSES.twoCompanies,
      STAND_IN_BUSINESSES.handedOver,
      STAND_IN_BUSINESSES.roleEnded,
    ];
    expect(standInBusinesses).toHaveLength(7);
    expect(standInBusinesses).not.toContain(SAM_PARTY?.businessId);
    expect(STAND_INS.map((standIn) => standIn.personId)).not.toContain(NEW_OWNER_PERSON);
  });

  it("holds the rows the seed's header lists, and nothing a turn wrote", async () => {
    expect(await rowCounts()).toEqual(SEEDED_ROWS);
  });
});

// ---- the mapping ------------------------------------------------------------------------------------------------------

describe("turnPartyOf: K-05 v1.11's answer as the binding line maps it, on each fixture's own answer", () => {
  it("atBusiness as it stands, field by field: read-turn-party-test-owner-1 and read-turn-party-one-role", () => {
    for (const name of ["read-turn-party-test-owner-1.json", "read-turn-party-one-role.json"]) {
      const { outcome } = fixtureOf(name);

      const party = turnPartyOf(outcome);

      expect(party, name).toStrictEqual(mappedOf(name));
      // As it stands: the fixture's own four fields, and nothing else.
      expect(party, name).toStrictEqual(outcome);
      expect(Object.keys(party ?? {}).sort(), name).toEqual(["businessId", "handleId", "personId", "zone"]);
    }
  });

  it("noBusiness with business null and the zone UTC (default 101): read-turn-party-first-text and read-turn-party-sign-up-before-business", () => {
    expect(NO_BUSINESS_ZONE).toBe("UTC");
    for (const name of ["read-turn-party-first-text.json", "read-turn-party-sign-up-before-business.json"]) {
      const { outcome } = fixtureOf(name);
      expect(outcome, name).toMatchObject({ businessId: null, zone: null });

      const party = turnPartyOf(outcome);

      expect(party, name).toStrictEqual(mappedOf(name));
      expect(party, name).toStrictEqual({ ...outcome, zone: "UTC" });
    }
  });

  it("unknown as the port's null, and every businessUndecided reason as the port's null: never a party with a business picked or with business null", () => {
    expect(fixtureOf("read-turn-party-unknown.json").outcome).toEqual({
      handleId: null,
      businessId: null,
      personId: null,
      zone: null,
    });
    expect(turnPartyOf(fixtureOf("read-turn-party-unknown.json").outcome)).toBeNull();
    for (const [name, reason] of Object.entries(UNDECIDED)) {
      const { outcome } = fixtureOf(name);
      expect(outcome, name).toEqual({
        error: "businessUndecided",
        reason,
        handleId: "handle-sam",
        personId: "person-sam",
      });

      expect(turnPartyOf(outcome), name).toBeNull();
    }
    // The three reasons K-05 names, each on its own.
    expect(new Set(Object.values(UNDECIDED))).toEqual(
      new Set(["anotherOwner", "roleEnded", "severalBusinesses"]),
    );
  });

  it("transient as a thrown error that carries the call's name and the SQLSTATE alone, and an error K-05 does not name is thrown the same way", () => {
    let thrown: unknown;
    try {
      turnPartyOf({ error: "transient", sqlstate: "40001" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TurnPartyTransientError);
    expect(thrown).toMatchObject({
      name: "TurnPartyTransientError",
      call: "readTurnParty",
      sqlstate: "40001",
      message: "readTurnParty: the database could not answer now (transient, SQLSTATE 40001)",
    });
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual([
      "call",
      "message",
      "name",
      "sqlstate",
      "stack",
    ]);
    // Whatever stands where a SQLSTATE should is never handed on.
    const odd = new TurnPartyTransientError(SAM.address);
    expect(odd.sqlstate).toBeNull();
    expect(odd.message).toBe("readTurnParty: the database could not answer now (transient)");
    // An answer whose error is none of K-05's two fails closed: thrown, never a party and never null.
    const unnamed = { error: "notFound", table: "handles", rowId: "handle-sam" } as unknown;
    expect(() => turnPartyOf(unnamed as ReadTurnPartyOutcome)).toThrow(TurnPartyTransientError);
  });

  it("hands on the party's four fields alone, whatever else an answer holds", () => {
    const more = {
      ...fixtureOf("read-turn-party-test-owner-1.json").outcome,
      address: SAM.address,
      reason: "severalBusinesses",
      businesses: ["biz-lees-barbershop", "biz-t1400-another"],
    } as unknown as ReadTurnPartyOutcome;

    expect(turnPartyOf(more)).toStrictEqual(mappedOf("read-turn-party-test-owner-1.json"));
  });
});

// ---- partyOf by direct call ---------------------------------------------------------------------------------------------

describe("partyOf through a root composed for staging (Root.turn.directory): K-05 v1.11 item 52 through the job handle", () => {
  it.each(CASES)(
    "$name: K-05 answers the fixture's answer on this file's rows, and the directory the party the binding line maps it to",
    async ({ name, handle, answer, party, standIn }) => {
      const testEnv = envOf();
      const { root, db, inputs, lines } = rootOver(testEnv);
      // Nothing was read to build the root but the environment and the binding's presence: no connection string.
      expect(testEnv.job?.reads.n).toBe(0);
      expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
      expect(inputs.turnDirectory).not.toBeNull();

      // The rows stand in the fixture's case: db/repo's own read answers the fixture's answer (its own, or under the
      // stand-in's two ids), reason included.
      expect(await k05Answer(handle), name).toEqual(answer);
      if (standIn === null) expect(answer).toBe(fixtureOf(name).outcome);

      const found = await root.turn.directory.partyOf(requestOf(handle));

      expect(found, name).toStrictEqual(party);
      // One short-lived client for the call, its connection string read at that call, on the job side.
      expectPartyReads(lines(), 1);
      expect(testEnv.job?.reads.n).toBe(1);
      expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0, connectionsPeak: 1 });
    },
  );

  it("each call reads the rows again on a client of its own: nothing is remembered for a root", async () => {
    const testEnv = envOf();
    const { root, db, lines } = rootOver(testEnv);

    const first = await root.turn.directory.partyOf(requestOf(SAM));
    const second = await root.turn.directory.partyOf(requestOf(SAM));
    const none = await root.turn.directory.partyOf(requestOf(UNKNOWN_CASE.handle));

    expect(first).toStrictEqual(SAM_PARTY);
    expect(second).toStrictEqual(SAM_PARTY);
    expect(second).not.toBe(first);
    expect(none).toBeNull();
    expectPartyReads(lines(), 3);
    expect(testEnv.job?.reads.n).toBe(3);
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0, connectionsPeak: 1 });
  });

  it("sends the handle alone, its kind and its address, never the actor's name: another actor name answers the same, another kind for the same address answers null, and a kind K-06 does not have is refused before any statement", async () => {
    const { root, db } = rootOver(envOf());
    const directory = root.turn.directory;

    // The actor's name is not what the read goes by: a name that is no handle's answers test owner 1's party all the same.
    expect(await directory.partyOf({ actorName: "t1400-no-such-actor", handle: SAM })).toStrictEqual(
      SAM_PARTY,
    );
    // The kind is sent with the address: test owner 1's number named as an email handle is no K-04 handle (default 96).
    expect(await directory.partyOf(requestOf({ kind: "email", address: SAM.address }))).toBeNull();
    expect(await directory.partyOf(requestOf({ kind: "email", address: "nobody@example.com" }))).toBeNull();
    // A kind K-06 does not have, and an address in neither of its forms: db/repo's own refusal, naming the field.
    const badKind = await rejectionOf(directory.partyOf(requestOf({ kind: "fax", address: SAM.address })));
    expect(badKind).toBeInstanceOf(TypeError);
    expect((badKind as Error).message).toBe("readTurnParty: handle.kind is phone or email");
    const badAddress = await rejectionOf(directory.partyOf(requestOf({ kind: "phone", address: "0100" })));
    expect(badAddress).toBeInstanceOf(TypeError);
    for (const error of [badKind, badAddress]) {
      for (const text of textsOf(error)) expect(ANY_FICTION_NUMBER.test(text)).toBe(false);
    }
    expect(db.counts()).toMatchObject({ opened: 5, ended: 5, connectionsOpen: 0 });
  });

  it("the Worker's own root (workerRoot over the env, every part's own builder) hands the turn this directory: test owner 1's party, the read's timing one line on the Worker's log", async () => {
    const testEnv = envOf();

    const root = workerRoot(testEnv.env);

    expect(root.environment).toBe("staging");
    expect(await root.turn.directory.partyOf(requestOf(SAM))).toStrictEqual(SAM_PARTY);
    expect(await root.turn.directory.partyOf(requestOf(UNKNOWN_CASE.handle))).toBeNull();
    // This card's own reads alone: its two calls, each one dbCall line (labels and numbers only) on console.log.
    const lines = (jsonLinesOf(testLog, "dbCall") as unknown as DbCallLine[]).filter(
      (line) => line.call === READ_TURN_PARTY_CALL,
    );
    expectPartyReads(lines, 2);
  });
});

// ---- a turn's first run ---------------------------------------------------------------------------------------------

describe("a turn's first run through the root's installed ports, every other input on its double", () => {
  it("test owner 1's JOIN runs under biz-lees-barbershop with its texts' dates in America/New_York: the frontier is asked under that business and answers the sign-up door whose target is Lee's Barbershop, as build-frontier-s1-01.json has it, and the turn commits", async () => {
    const { root, fakes, lines } = turnRootOver(envOf());
    const leased = await leasedTurn(SAM, root.turn.keys);
    expect(leased.turn.turnId).toBe(joinRunContext.turnId);

    const { outcome, frontier } = await firstRun(root, leased.turn);

    // The run's first read was this card's: one readTurnParty on the job side.
    expectPartyReads(lines(), 1);
    // The frontier's request is the party's: the business, the person and the handle the directory gave, the text's
    // date in the business's zone, as build-frontier-s1-01.json's request has them.
    expect(frontier).toHaveLength(1);
    const [call] = frontier;
    expect(call?.request).toMatchObject({
      caller: {
        kind: "turn",
        turnId: leased.turn.turnId,
        businessId: TURN_ONE.request.caller.businessId,
        personId: TURN_ONE.request.caller.personId,
      },
      turn: { id: leased.turn.turnId, handleId: TURN_ONE.request.turn.handleId },
      texts: [{ eventId: JOIN.eventId, sentAt: { utc: JOIN.sentAt, zone: "America/New_York" } }],
      targets: TURN_ONE.request.targets,
    });
    expect(TURN_ONE.request.caller).toMatchObject({
      businessId: SAM_PARTY?.businessId,
      personId: SAM_PARTY?.personId,
    });
    expect(TURN_ONE.request.turn.handleId).toBe(SAM_PARTY?.handleId);
    expect(TURN_ONE.request.texts.map((text) => text.sentAt.zone)).toEqual([SAM_PARTY?.zone]);
    // Its stored state was read under that business, and no other.
    expect(fakes.frontier.reads.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fakes.frontier.reads.map((read) => read.scope))).toEqual(new Set(["biz-lees-barbershop"]));
    // Its answer is turn 1's: the one sign-up door to S1-01, about Lee's Barbershop.
    expect((call?.answer as { context?: { choices?: unknown } }).context?.choices).toEqual(
      TURN_ONE.outcome.context.choices,
    );
    expect(TURN_ONE.outcome.context.choices).toEqual([
      expect.objectContaining({
        kind: "door",
        door: "signUp",
        step: "S1-01",
        target: {
          businessId: "biz-lees-barbershop",
          businessName: "Lee's Barbershop",
          bookingId: null,
          visitAt: null,
        },
      }),
    ]);
    // Decide was given the JOIN run's own recorded context, its text's date in America/New_York among it.
    expect(fakes.decide.decideCalls).toEqual([joinRunContext]);
    // And the turn committed once, S1-01's one part, under the party's handle.
    expect(outcome).toMatchObject({
      result: "committed",
      gateCalls: 1,
      reread: false,
      answer: { repeated: false, parts: [{ choiceId: "c-01", result: "committed" }] },
    });
    expect(leased.commits).toHaveLength(1);
    expect(fakes.turnRows.commits).toHaveLength(1);
    expect(fakes.turnRows.commits[0]).toMatchObject({
      turn: { id: leased.turn.turnId, handleId: "handle-sam" },
    });
    expect(fakes.gate.scopes).toEqual(["biz-lees-barbershop"]);
  });

  it("the first text's number runs with business null and its dates in UTC: the frontier's request names no business and the text's date in UTC, and nothing commits", async () => {
    const fakes = skeletonFakes();
    // The guard's targets double holds the first text's handle beside test owner 1's, each a first text, under the ids
    // its fixture answers.
    expect(FIRST_TEXT_CASE.answer).toMatchObject({ handleId: "handle-gw-0108", personId: "person-gw-0108" });
    const targets = fakeHandleTargets([
      TEST_OWNER_1,
      { handle: FIRST_TEXT_CASE.handle, handleId: "handle-gw-0108", personId: "person-gw-0108" },
    ]);
    const { root, lines } = turnRootOver(envOf(), fakes, targets.call);
    const leased = await leasedTurn(FIRST_TEXT_CASE.handle, root.turn.keys);

    const { outcome, frontier } = await firstRun(root, leased.turn);

    expectPartyReads(lines(), 1);
    // The run went on under the party the directory gave: the guard read the handle's targets by its K-04 id ...
    expect(targets.requests).toEqual([{ handleId: "handle-gw-0108" }]);
    // ... and the frontier's request names no business, the first text's person and handle, and its date in UTC.
    expect(frontier).toHaveLength(1);
    expect(frontier[0]?.request).toMatchObject({
      caller: { kind: "turn", businessId: null, personId: "person-gw-0108" },
      turn: { handleId: "handle-gw-0108" },
      texts: [{ eventId: JOIN.eventId, sentAt: { utc: JOIN.sentAt, zone: "UTC" } }],
    });
    // Nothing is read under a business, and nothing commits. (Today the run ends at the frontier: the Tool API base
    // refuses a call naming no business, noBusinessScope, which is its own rule and no part of this card's.)
    expect(fakes.frontier.reads.filter((read) => read.scope !== "")).toEqual([]);
    expect(outcome).toMatchObject({ result: "notCommitted", gateCalls: 0 });
    expect(leased.commits).toEqual([]);
    expect(fakes.turnRows.commits).toEqual([]);
    expect(leased.spans.map((span) => span.business_id ?? null)).not.toContain("biz-lees-barbershop");
  });

  it.each(NO_PARTY_CASES)(
    "$name: the run ends unknownHandle with nothing opened, decided or written, and the park is refused the same way",
    async ({ handle }) => {
      const before = await rowCounts();
      const { root, fakes, lines } = turnRootOver(envOf());
      // Sealed under a key store of the test's own, so the root's key double shows that the text was never opened.
      const leased = await leasedTurn(handle, fakeKeyStore());

      const { outcome, frontier } = await firstRun(root, leased.turn);

      expect(outcome).toEqual({ result: "notCommitted", why: "unknownHandle", gateCalls: 0, replies: null });
      expect(frontier).toEqual([]);
      expect(leased.commits).toEqual([]);
      expect(leased.spans).toEqual([]);
      expect(reached(fakes)).toEqual(nothingReached(fakes));

      const parked = await parkThroughRows(root.turn, leased.parking);

      expect(parked).toEqual({ error: "unknownHandle" });
      expect(leased.spans).toMatchObject([
        {
          hop: "lease",
          outcome: "refused",
          error_code: "unknownHandle",
          decided: { parked: false },
          rows: [],
        },
      ]);
      // The park's span names no business: none was picked for the handle.
      expect(leased.spans.map((span) => span.business_id ?? null)).toEqual([null]);
      expect(reached(fakes)).toEqual(nothingReached(fakes));
      // Two reads, the run's and the park's, and nothing written.
      expectPartyReads(lines(), 2);
      expect(await rowCounts()).toEqual(before);
    },
  );

  it("the park asks the same directory and gets the same mapping: test owner 1's turn parks under his handle, his person and biz-lees-barbershop", async () => {
    const { root, fakes, lines } = turnRootOver(envOf());
    const leased = await leasedTurn(SAM, fakeKeyStore());

    const parked = await parkThroughRows(root.turn, leased.parking);

    expect(parked).toMatchObject({ result: "parked", repeated: false });
    expectPartyReads(lines(), 1);
    expect(fakes.turnRows.parks).toHaveLength(1);
    expect(fakes.turnRows.parks[0]).toMatchObject({
      turn: { id: leased.turn.turnId, handleId: "handle-sam", tries: 3 },
      outboxRows: [
        {
          recipientHandleId: "handle-sam",
          recipientPersonId: "person-sam",
          businessId: "biz-lees-barbershop",
        },
      ],
      events: [{ businessId: "biz-lees-barbershop" }],
    });
    expect(leased.spans).toMatchObject([
      { hop: "lease", outcome: "ok", business_id: "biz-lees-barbershop", decided: { parked: true } },
    ]);
  });
});

// ---- bound but failing ------------------------------------------------------------------------------------------------

describe("bound but failing: every failure is thrown, and a run ends noDirectory with nothing opened, read or written", () => {
  it("K-05's transient answer (the read's connection cut under it, through the handle): partyOf throws TurnPartyTransientError with the SQLSTATE alone, and a run ends noDirectory", async () => {
    const before = await rowCounts();
    const { root, fakes, db, lines } = turnRootOver(envOf());

    const direct = await cutUnder(() => root.turn.directory.partyOf(requestOf(SAM)));

    if (!("failed" in direct)) throw new Error("the read answered though its connection was cut");
    expect(direct.failed).toBeInstanceOf(TurnPartyTransientError);
    expect(direct.failed).toMatchObject({ call: "readTurnParty" });
    const { sqlstate } = direct.failed as TurnPartyTransientError;
    // PostgreSQL's own word for an ended backend, or a connection lost before it arrived.
    expect(["57P01", "08006"]).toContain(sqlstate);
    expect((direct.failed as Error).message).toBe(
      `readTurnParty: the database could not answer now (transient, SQLSTATE ${String(sqlstate)})`,
    );
    expectNothingOf(poolBinding(JOB), direct.failed);

    const leased = await leasedTurn(SAM, fakeKeyStore());
    const run = await cutUnder(() => firstRun(root, leased.turn));

    if (!("answered" in run)) throw new Error("the run threw");
    expect(run.answered.outcome).toEqual({
      result: "notCommitted",
      why: "noDirectory",
      gateCalls: 0,
      replies: null,
    });
    expect(run.answered.frontier).toEqual([]);
    expect(leased.commits).toEqual([]);
    expect(leased.spans).toEqual([]);
    expect(reached(fakes)).toEqual(nothingReached(fakes));
    // Each read's guard had passed (its timing line is written) before its connection was cut; every client was ended.
    expectPartyReads(lines(), 2);
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
    // The rows are read again at the next call: nothing of the failure is kept.
    expect(await root.turn.directory.partyOf(requestOf(SAM))).toStrictEqual(SAM_PARTY);
  });

  it("the file's two bindings crossed (HYPERDRIVE_JOB holding the Tool API's login): the guard refuses the read before it runs, so it never runs as rosie_app; partyOf throws the refusal and a run ends noDirectory", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ job: APP });
    const { root, fakes, db, lines } = turnRootOver(testEnv);

    const refused = await rejectionOf(root.turn.directory.partyOf(requestOf(SAM)));

    expect(refused).toBeInstanceOf(DbGuardRefusal);
    expect(refused).toMatchObject({ side: "runtime", binding: "HYPERDRIVE_JOB" });
    expect((refused as DbGuardRefusal).checks).toContain("session_user");
    expectNothingOf(poolBinding(APP), refused);

    const leased = await leasedTurn(SAM, fakeKeyStore());
    const { outcome, frontier } = await firstRun(root, leased.turn);

    expect(outcome).toEqual({ result: "notCommitted", why: "noDirectory", gateCalls: 0, replies: null });
    expect(frontier).toEqual([]);
    expect(leased.commits).toEqual([]);
    expect(leased.spans).toEqual([]);
    expect(reached(fakes)).toEqual(nothingReached(fakes));
    // The park is refused the same way.
    expect(await parkThroughRows(root.turn, leased.parking)).toEqual({ error: "noDirectory" });
    expect(reached(fakes)).toEqual(nothingReached(fakes));
    // Each refusal's one log line: the side, the binding's name and the failed checks' labels (T-1254); no timing line.
    const refusals = jsonLinesOf(testLog, "dbGuardRefused");
    expect(refusals).toHaveLength(3);
    for (const line of refusals) {
      expect(line).toMatchObject({ level: "error", side: "runtime", binding: "HYPERDRIVE_JOB" });
      expect(Object.keys(line).sort()).toEqual(["binding", "checks", "level", "msg", "side"]);
    }
    expect(lines()).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("a database that is not there (the pool's own HYPERDRIVE_JOB, on rosie_rig_none) and DB_SCHEMA set: each is thrown by the call's name and its SQLSTATE or reason alone, and a run ends noDirectory", async () => {
    const before = await rowCounts();
    const notThere = turnRootOver(envOf({ job: POOL_OWN_JOB }));
    const schemaSet = envOf({ schema: "preview_t1400" });
    const withSchema = turnRootOver(schemaSet);

    const noDatabase = await rejectionOf(notThere.root.turn.directory.partyOf(requestOf(SAM)));

    expect(noDatabase).toBeInstanceOf(DataAccessDatabaseError);
    expect(noDatabase).toMatchObject({ call: "readTurnParty", code: "3D000", table: null, constraint: null });
    expect((noDatabase as Error).message).toBe(
      "readTurnParty: the database refused the call (SQLSTATE 3D000)",
    );
    expectNothingOf(poolBinding(POOL_OWN_JOB), noDatabase);

    const closed = await rejectionOf(withSchema.root.turn.directory.partyOf(requestOf(SAM)));

    expect(closed).toBeInstanceOf(DbClosedError);
    expect(closed).toMatchObject({
      call: "readTurnParty",
      side: "runtime",
      binding: "HYPERDRIVE_JOB",
      reason: "dbSchemaSet",
    });
    // No client is opened through the binding while DB_SCHEMA is set: its string is read 0 times.
    expect(schemaSet.job?.reads.n).toBe(0);

    for (const { root, fakes } of [notThere, withSchema]) {
      const leased = await leasedTurn(SAM, fakeKeyStore());
      const { outcome } = await firstRun(root, leased.turn);
      expect(outcome).toEqual({ result: "notCommitted", why: "noDirectory", gateCalls: 0, replies: null });
      expect(leased.spans).toEqual([]);
      expect(reached(fakes)).toEqual(nothingReached(fakes));
    }
    expect(notThere.lines()).toEqual([]);
    expect(withSchema.lines()).toEqual([]);
    expect(notThere.db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    expect(withSchema.db.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- unbound, idsOf and isStopped, production -------------------------------------------------------------------------

describe("unbound: the directory is null, so partyOf fails closed as it always has", () => {
  it("HYPERDRIVE_JOB not bound and HYPERDRIVE_APP bound: NoStateReadError partyOf at once, nothing read, HYPERDRIVE_APP read 0 times, and a run ends noDirectory", async () => {
    const testEnv = envOf({ job: null });
    const { root, fakes, db, inputs, lines } = turnRootOver(testEnv);

    expect(stagingDirectories({ env: testEnv.env, db })).toBe(NO_DIRECTORY_INPUTS);
    expect([inputs.turnDirectory, inputs.handleDirectory, inputs.stoppedFlags]).toEqual([null, null, null]);
    await expect(root.turn.directory.partyOf(requestOf(SAM))).rejects.toThrow(
      new NoStateReadError("partyOf"),
    );
    const leased = await leasedTurn(SAM, fakeKeyStore());
    const { outcome } = await firstRun(root, leased.turn);
    expect(outcome).toEqual({ result: "notCommitted", why: "noDirectory", gateCalls: 0, replies: null });
    expect(reached(fakes)).toEqual(nothingReached(fakes));

    // Only the job binding's presence was asked for; HYPERDRIVE_APP by no name (checked after each test, and here).
    expect(new Set(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE")))).toEqual(
      new Set(["HYPERDRIVE_JOB"]),
    );
    expect(testEnv.app.reads.n).toBe(0);
    expect(lines()).toEqual([]);
    expect(testLog).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
  });
});

describe("idsOf and isStopped: no K-05 call names their reads, so both stay closed", () => {
  it("through the root this card binds, and through the Worker's own, each still fails closed with NoStateReadError, with no client opened", async () => {
    const testEnv = envOf();
    const { root, db, inputs, lines } = rootOver(testEnv);
    const actor = actorNameOf(SAM);

    expect(inputs.turnDirectory).not.toBeNull();
    expect([inputs.handleDirectory, inputs.stoppedFlags]).toEqual([null, null]);
    for (const of of [root, workerRoot(envOf().env)]) {
      await expect(of.safety.directory.idsOf(actor)).rejects.toThrow(new NoStateReadError("idsOf"));
      await expect(Promise.resolve().then(() => of.safety.isStopped(actor))).rejects.toThrow(
        new NoStateReadError("isStopped"),
      );
      // The PostgreSQL-down path's directory is the same read.
      await expect(of.outage.directory.idsOf(actor)).rejects.toThrow(new NoStateReadError("idsOf"));
    }
    expect(lines()).toEqual([]);
    expect(jsonLinesOf(testLog, "dbCall")).toEqual([]);
    expect(testEnv.job?.reads.n).toBe(0);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
  });
});

describe("production's environment", () => {
  it("with both bindings: the builder gives nothing and reads ENVIRONMENT alone, the state-reads port stays closed (NotJoinedError) through the Worker's own root, and no binding is read", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ environment: "production" });

    // The builder alone, were it ever handed production's env: every input null, ENVIRONMENT read and nothing else.
    const alone = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(alone);
    expect(stagingDirectories({ env: testEnv.env, db: alone })).toBe(NO_DIRECTORY_INPUTS);
    expect(testEnv.names).toEqual(["ENVIRONMENT"]);

    const root = workerRoot(testEnv.env);

    expect(root.environment).toBe("production");
    const actor = actorNameOf(SAM);
    const closed = new NotJoinedError("stateReads");
    await expect(Promise.resolve().then(() => root.turn.directory.partyOf(requestOf(SAM)))).rejects.toThrow(
      closed,
    );
    await expect(Promise.resolve().then(() => root.safety.directory.idsOf(actor))).rejects.toThrow(closed);
    await expect(Promise.resolve().then(() => root.safety.isStopped(actor))).rejects.toThrow(closed);
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app.reads.n]).toEqual([0, 0]);
    expect(jsonLinesOf(testLog, "dbCall")).toEqual([]);
    expect(alone.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- nothing leaks, nothing written -----------------------------------------------------------------------------------

describe("the span and log capture of every test above", () => {
  it("holds no 555-01xx number in any form, so no address, actor name or request; no row count moved; and no unhandled rejection reached this isolate", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // The capture is not empty: the turns' and parks' spans and every read's timing line are in it.
    expect(SPANS.length).toBeGreaterThanOrEqual(6);
    expect(SPANS.map((span) => span.hop)).toEqual(expect.arrayContaining(["lease", "frontier", "guard"]));
    const partyLines = (jsonLinesOf(LOGGED, "dbCall") as unknown as DbCallLine[]).filter(
      (line) => line.call === READ_TURN_PARTY_CALL,
    );
    expect(partyLines.length).toBeGreaterThanOrEqual(25);
    expect(jsonLinesOf(LOGGED, "dbGuardRefused").length).toBeGreaterThanOrEqual(3);

    expect(NUMBER_FORMS).toHaveLength(36);
    expect(leaks(SPANS, [...NUMBER_FORMS])).toEqual([]);
    const lowered = LOGGED.map((line) => line.toLowerCase());
    for (const form of NUMBER_FORMS) {
      expect(
        lowered.filter((line) => line.includes(form.toLowerCase())),
        "a log line holds a number",
      ).toEqual([]);
    }
    expect(
      lowered.filter(
        (line) => ANY_FICTION_NUMBER.test(line) || /\+[0-9]{7,15}/u.test(line) || line.includes("phone:+"),
      ),
    ).toEqual([]);
    expect(lowered.filter((line) => line.includes("@example.com"))).toEqual([]);
    expect(await rowCounts()).toEqual(SEEDED_ROWS);
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
