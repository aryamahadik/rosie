// T-1398: staging's gate reads (./tool-api-gate.ts; the D-017 path audit's P4a; the lead's notes DL-397, DL-757, DL-760,
// DL-761, DL-768 and DL-776), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key TOOL_API_GATE) and
// through its pool bindings only (vitest.config.ts): this file's pair, HYPERDRIVE_JOB_TOOL_API_GATE and
// HYPERDRIVE_APP_TOOL_API_GATE, the two Worker logins on this file's own database (migrated, bundle v0 published and
// active, seeded by ./tool-api-gate.seed.ts), and the pool's own pair, which names rosie_rig_none, never made. Each test
// hands the binding (stagingGateReads) or a root built as workerRoot builds the Worker's (composeRoot over stagingOptions)
// an env of its own whose HYPERDRIVE_JOB and HYPERDRIVE_APP are doubles over pool bindings that count the reads of their
// connection strings, with the seed's made-up SEALING_WRAP_KEY.
//
// A root here binds this card's part and the two parts its proofs need beside it, each by its own builder (DL-776): T-1395's
// turn calls (./k05-turn.ts: the gate's one commitTurn through the turn-row port, and the bundle reads the gate and the
// check read the turn's bundle through) and T-1397's one BundleSafety adapter (./bundle-safety.ts: the source of
// SafetyDeps.words, bundle v0 pinned through its own check). Every other part is stood in by its nothing-bound answer, and
// the cases that count what is read as the root is built stand those two in too, so they hold in any merge order.
//
//   - Turn 1's gate (K-09 v1.5 commit-s1-01.json's request, under the turn id the lease hashes and bundle v0) commits
//     once: its turns row, S1-01's thread, S1-02's question, its clock row, its outbox row and the No record (its words
//     sealed under Sam's existing key) are in this file's database; the same request again answers the first commit with
//     nothing written. The scope ran as rosie_worker_app under the call's business, and the commit as rosie_worker_job, read
//     on the client commitTurn's call used (the guard's login, on the call's timing line: ADR-014 line 198).
//   - The reads as their K-05 fixtures: read-safety-outcome-of-event-s1-01 (nothing before the commit), business-zone-
//     barbershop, business-owner-phone-first (on the runtime side), read-open-holds-other-business (unread under another
//     business's scope); and a gate whose text's outcome another business holds is held, its one part answered held.
//   - SafetyDeps.words: from the adapter's checked bundle v0, word for word, null for a line it holds no words for; before
//     any check it is no port (notBuilt). A record whose line asks the danger question commits with bundle v0 checked and
//     answers notBuilt with nothing written before any check.
//   - A rerun's pinned bundle, checked before the gate's face runs (T-1453): a turn's rerun keeps the id its turn stored
//     and runs no check (the real pin over a HandleActor's storage), so in a fresh isolate the gate awaits the adapter's
//     check for that id, then the record whose line asks the danger question commits with v0's words (on main it answered
//     notBuilt); a warm isolate's kept bundle is asked once and read again nowhere; a check whose read fails keeps nothing
//     and fails the gate before its scope opens; a refused bundle is kept nowhere and still answers notBuilt; with no
//     adapter, and with no reads at all, the gate does what it did.
//   - The read-only sealer: seals under an existing key; a person with no key is refused (noSealingKey) and no key is made;
//     with SEALING_WRAP_KEY left out the seal fails with its code alone. Through the gate, either writes nothing.
//   - Connections: two gates side by side, each holding its Tool API client while its seal and commit (and two scopes' owner
//     reads and seals) open runtime-side clients, finish under T-1254's cap; six gates at once, at most three holding a Tool
//     API client, finish with 6 connections at most; opened equals ended after every test.
//   - Failing closed: bindings left out (null input, inside the Tool API base, nothing read); the pool's own HYPERDRIVE_APP
//     (the call's name and SQLSTATE only); a read's error answer thrown (a business this database does not hold); production
//     (no binding read, the gate port closed).
//   - The scope's start (T-1410), through a root with every other part stood in (DL-776): once the guard has passed, the
//     scope's client lost under it (ended first: postgres.js's CONNECTION_ENDED) makes the gate answer K-09's transient,
//     its handler never run and nothing written; a session refused at its start (3D000, 42501, 55000, as postgres.js rejects
//     the begin with PostgreSQL's refusal naming this file's database) is thrown scrubbed under gateAndCommit, never
//     transient and never under withBusiness.
//   - No line written while this file runs holds a text's words, a number, an address, the wrapping key, a sealed value,
//     a chat id or a fixed line's words, and no rejection is left unhandled.
//   - T-1470 (card F2), the walk's question read and the kinds reads the gate binds for an answer to S1-02's question.
//     This rig holds bundle v0 and no bundle v1, so no second turn is walked here (that is T-1468's local proof, and
//     ../gate-binding.test.ts proves the gate port's binding); what is proven is each read on its own client, role and
//     scope, on the seed's catalog rows and its one live S1-02 question: the gate holds `questions` and `kinds.reads`
//     and no stop port; the question read as rosie_worker_app inside the gate's scope answers the live question with its
//     row's version, and null under another business's scope, for another handle and for an id that is not live; inside
//     one held scope the catalog is read on a second Tool API client and item 79 on a runtime-side one, one after the
//     other, 2 connections at most; with every slot's scope held, each reads the catalog and ends (its client takes no
//     slot), 6 connections at most; a failed item 79 read is KindsReadError as thrown, and no line holds its row id.
//   - T-1516 (DL-1033 ruling 8; CQ-360), the stop home's reads the gate binds beside the kinds reads, shared by S1-03's,
//     S1-74's and S1-08's writers: the gate holds `stop.reads`, StopHomeReads' five members exactly; inside one held
//     scope, homes/stop's readStop (the writers' own read) for the asked owner reads the handle, the person's handles,
//     the phone row and the people behind the handle and their consent rows, each on a runtime-side client of its own
//     (rosie_worker_job), one after another, 2 connections at most, and answers that handle's own reading as this
//     database holds it; through the pool's own HYPERDRIVE_JOB the first read fails with its call's name and SQLSTATE
//     alone and the scope's client is ended; nothing is written, and no line holds the asked owner's number. The walk
//     of an answer settled as "One isn't on the list yet" or "Not a service we book" over these reads is
//     ../gate-binding.test.ts's (this rig holds no bundle v1).
//   - T-1519 (DL-1048, DL-1051), the walk's chat read the gate binds for S1-01 (K-05 v1.10 item 51 readChatHandle): the
//     gate holds `readChatHandle`; turn 1's gate asks it once on the runtime side (no thread holds Sam's chat yet, so
//     the thread is inserted as before); after turn 1, inside one held scope, Sam's chat id answers Sam's own phone handle
//     (the thread turn 1 wrote) and a chat id no thread holds answers none, each read on a runtime-side client of its own
//     (rosie_worker_job) named readChatHandle on its timing line, 2 connections at most, nothing written; through the
//     pool's own HYPERDRIVE_JOB the read fails with its call's name and SQLSTATE alone. A returning number's JOIN through
//     the walk is ../gate-binding.test.ts's and the turn face's PostgreSQL proof (pg/thread.int.test.ts).
//   - T-1494 (H2a; DL-1033, DL-1096, DL-1111), the one-kind path's reads the gate binds beside the kinds and stop reads,
//     in the roster-owner world staging's real phone texts in (the seed runs db/seeds/roster-owner.ts as it is for one
//     fiction-range number): the gate holds `companies`, CompaniesReads' four members; inside one held scope item 79 and
//     the catalog by id are read on runtime-side clients (rosie_worker_job) and item 72 on a second Tool API client
//     (rosie_worker_app), one after another, 2 connections at most, nothing written; a failed item 79 read is
//     CompaniesReadError as thrown, and no line holds its row id. Then the walk itself, on bundle v2 (its registry row
//     seeded, the run's pinned bundle its own manifest, flow A and plumber's overlay as bundles/v2 holds them): the
//     roster owner's one-kind "Plumbing" to S1-02's question, through realGate over staging's gate reads and the root's
//     turn-row port, commits once: S1-02's question answered, one listed pick placed under the owner's company and
//     business with plumber's company kind beside the barber one, its 11 text blocks under that business, S1-08's row
//     (step S1-08, line 0, no question), S1-09's question and its row, and no S1-04 question or row; every call on its
//     side, one after another, 2 connections at most (connectionsPeak, against ./db.ts CONNECTIONS_PER_CLIENT, 1).
//   - T-1485 (H2b; DL-1033, DL-1122), S1-04's writer bound on staging's gate, the party rule's flag off: the seed's second
//     roster owner (place 2 of the same set) answers its S1-02 question with "Barbershop, plumbing, electrical" on bundle
//     v2 through realGate, which asks S1-04 (three picks, none placed, barber's overlay read once); its S1-04 row's send
//     is played on the runtime side (one delivered part, then K-05's armClock), so the question is open at version 2.
//     Sam's own two-company answer ("Plumbing and electrical share Lee Home Services", commit-s1-04-some-share.json)
//     then fails closed inside the Tool API base: realGate rejects with CompaniesRefusedError secondCompany, its message
//     and fields labels alone, after one scope, its seal, item 79 and the kinds' names by id (item 26), with no item 72,
//     no S1-08 read, no commit sent and nothing written, the
//     question still open, and no line holding the owner's words or number. "They all share one company"
//     (commit-s1-04.json) then commits once: S1-04's question answered at its version, the three picks placed under the
//     owner's company and business, plumber's and electrician's company kinds beside barber's, the barbershop's 11
//     blocks given the business, S1-08's row and S1-09's question and its row; every call on its side, one after another,
//     2 connections at most.
//   - T-1540 (S1-09 design card 8 extended to S1-10; DL-1179), S1-09's, S1-76's and S1-10's ports the gate binds beside
//     the kinds, stop and one-kind reads (`listing`: GateListingReads' five members; LINK_HOST and BASE_PATH read at each
//     gate call, never as the root is built), in the roster-owner world: the seed's third and fourth roster owners, each
//     with its phone row as the gateway's receipt leaves it and S1-09's question live at its business under bundle v3.
//     The third answers with the demo listing ("Lee's Barbershop in Springfield, I'm the owner") through realGate over
//     staging's gate reads, the root's turn-row port, one HeldLinks and the gate's clock: one commit, S1-09's question
//     answered, the typed name written, the read-back row (S1-09, line 1), an accounts row (the chat's number), one
//     page_links row holding the code's sha256 alone, S1-10's row (line 2), no question and no clock (the walk waits),
//     and the HeldLinks holding https://rosfield.com/test/<32 hex> for S1-10's row. The fourth answers with a made-up
//     name and town: S1-76's row and one listing_match review item (Claim: owner. Reason: no listing.) through the
//     listing paging reader, then S1-10's rows. Every call on its side, one after another, 2 connections at most; no line
//     holds the words, a number, a link or a code. Then the listing paging reader inside a held scope: the review item
//     only under its own business, the head's version and zone of the scope's business alone, another business's refused
//     or none with no client opened. T-1494's "Plumbing" walk and T-1485's walks run unchanged with the ports bound.
// Test values only (rule 9): the master's sample cast, the fixtures' ids and words, whole fiction-range 555-01xx numbers,
// made-up ids, and the seed's made-up wrapping key.
import { KEYED_SAFETY_IDS } from "@rosie/actions/src/domain/safety/ids";
import { readStop, type StopHomeReads } from "@rosie/actions/src/homes/stop/reads";
import { NotBuiltError } from "@rosie/actions/src/tool-api/errors";
import {
  CompaniesReadError,
  CompaniesRefusedError,
} from "@rosie/actions/src/tool-api/journey-1/companies/errors";
import type { CompaniesReads } from "@rosie/actions/src/tool-api/journey-1/companies/reads";
import { KindsReadError } from "@rosie/actions/src/tool-api/journey-1/kinds/errors";
import { listingSummaryOf } from "@rosie/actions/src/tool-api/journey-1/listing/summary";
import { TurnFaceReadError, TurnFaceRefusedError } from "@rosie/actions/src/tool-api/turn-face/errors";
import { HeldLinks } from "@rosie/actions/src/tool-api/turn-face/held";
import businessOwnerPhoneFirst from "@rosie/contracts/data-access/fixtures/business-owner-phone-first.json";
import businessZoneBarbershop from "@rosie/contracts/data-access/fixtures/business-zone-barbershop.json";
import readOpenHoldsOtherBusiness from "@rosie/contracts/data-access/fixtures/read-open-holds-other-business.json";
import readSafetyOutcomeOfEventS101 from "@rosie/contracts/data-access/fixtures/read-safety-outcome-of-event-s1-01.json";
import safetyBusinessOwnLine from "@rosie/contracts/model/fixtures/safety-business-own-line.json";
import commitS101 from "@rosie/contracts/tool-api/fixtures/commit-s1-01.json";
import commitS102 from "@rosie/contracts/tool-api/fixtures/commit-s1-02.json";
import commitS102UnmappedEnd from "@rosie/contracts/tool-api/fixtures/commit-s1-02-unmapped-end.json";
import commitS104 from "@rosie/contracts/tool-api/fixtures/commit-s1-04.json";
import commitS104SomeShare from "@rosie/contracts/tool-api/fixtures/commit-s1-04-some-share.json";
import { readActiveBundle } from "@rosie/db/repo/bundles";
import { armClock, DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { Sql } from "@rosie/db/repo/scope";
import { SealingError, unsealText } from "@rosie/db/repo/sealing";
import { runInDurableObject } from "cloudflare:test";
import { env as poolEnv, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import bundleV2FlowA from "../../../../bundles/v2/bundle/flow/A.json";
import bundleV2Manifest from "../../../../bundles/v2/bundle/manifest.json";
import barberV2 from "../../../../bundles/v2/bundle/trade/barber.json";
import electricianV2 from "../../../../bundles/v2/bundle/trade/electrician.json";
import plumberV2 from "../../../../bundles/v2/bundle/trade/plumber.json";
import bundleV3FlowA from "../../../../bundles/v3/bundle/flow/A.json";
import bundleV3Manifest from "../../../../bundles/v3/bundle/manifest.json";
import type { HandleActor } from "../../actor";
import { turnIdOf } from "../../actor/lease";
import {
  BundleError,
  BundlePins,
  setBundleDeps,
  type BundleDeps,
  type BundleKv,
  type Manifest,
  type PinnedBundle,
  type PinRequest,
  type TradeOverlay,
  type TurnPin,
} from "../../bundle";
import { openTrace, type BundleId, type Span, type TraceContext } from "../../trace";
import { composeRoot, NoDatabaseError, NotJoinedError, workerRoot, type Root } from "../index";
import { realGate, type BundleSafetyLines, type GateReads } from "../real";
import { BUNDLE_V0, bundleV0FixedLine, SAM_CHAT } from "../test-support";
import { answeringBundleOf, BundleUnreadableError } from "./bundle-safety";
import { bundleOf, V0_FLOW_A, withoutWords, type SeedBundle } from "./bundle-safety.seed";
import { CONNECTIONS_PER_CLIENT, DB_SIDES, dbHandle } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { ListingPagingScopeError } from "./listing-paging";
import { NO_MODEL_READER_INPUTS } from "./models";
import { NO_STAGING_INPUTS, stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";
import { sealingWrapKeys } from "./secrets";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { GATE_CALLS, GATE_CLIENTS_AT_ONCE, stagingGateReads, type GatePart } from "./tool-api-gate";
import {
  ASK_RECORD,
  ASKED,
  BARBERSHOP,
  BUNDLE_V2_ID,
  BUNDLE_V3_ID,
  CATALOG,
  LISTING_OWNER,
  MADE_UP_OWNER,
  MULTI_KIND,
  NO_KEY,
  NO_WRAP_KEY,
  ONE_KIND,
  OTHER_BUSINESS_RECORD,
  SAM,
  SAM_EMAIL,
  seededKindDefaults,
  SIDE_BY_SIDE,
  SIX_AT_ONCE,
  TEST_WRAP_KEY,
  WRAP_KEY_NAME,
  writeOwnerRows,
  YOGA_STUDIO,
} from "./tool-api-gate.seed";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "TOOL_API_GATE";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own pair: its database, rosie_rig_none, is never made, so a connect through either fails. */
const POOL_JOB = "HYPERDRIVE_JOB";
const POOL_APP = "HYPERDRIVE_APP";
/** The connections a Worker may hold open at once (infra/spikes/hyperdrive-host/worker.mjs line 77). */
const WORKER_CONNECTIONS = 6;

/** A run through the Workers runtime's own steps and PostgreSQL: a resource guard above the project's default. */
const TEST_MS = 60_000;

/** Bundle v0 as the rig published it: the one bundle this file's database holds, active. */
const V0 = BUNDLE_V0;

type Json = Record<string, unknown>;

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- what this file's isolate wrote and rejected ---------------------------------------------------------------------

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

/** Every line written on the console and by a handle while this file's tests ran, and the running test's own. */
const everyLine: string[] = [];
let lines: string[] = [];
/** Every span a test's trace wrote. */
const SPANS: Span[] = [];

/** Every handle a test made, and every env a test built: checked after each test. */
const HANDLES: StagingDb[] = [];
const ENVS: TestEnv[] = [];

beforeEach(() => {
  lines = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    lines.push(line);
    everyLine.push(line);
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(keep);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended, its sockets with it.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
  // No binding named HYPERDRIVE is ever read, and SEALING_WRAP_KEY only by the resolver, at a seal.
  for (const made of ENVS) expect(made.names).not.toContain("HYPERDRIVE");
});

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A written line as the JSON it is; a line that is none fails the test. */
function parsed(line: string): Json {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("a log line is not a JSON object");
  return value;
}

// ---- envs and doubles ------------------------------------------------------------------------------------------------

interface Counted {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

/** A double over a pool binding that counts the reads of its connection string (and gives the pool binding's). */
function counted(binding: Hyperdrive): Counted {
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
  /** The counting doubles handed in as HYPERDRIVE_JOB and HYPERDRIVE_APP; null where the env has none or the pool's own. */
  readonly job: Counted | null;
  readonly app: Counted | null;
}

interface EnvOptions {
  readonly environment?: string;
  /** The pool binding handed in as HYPERDRIVE_JOB (default: this file's own); null for none. */
  readonly job?: string | null;
  /** The pool binding handed in as HYPERDRIVE_APP (default: this file's own); null for none. */
  readonly app?: string | null;
  /** False: SEALING_WRAP_KEY left out of the env. */
  readonly wrapKey?: boolean;
}

/** An env of the test's own: staging's vars, this file's pair behind counting doubles and the made-up wrapping key. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const jobName = options.job === undefined ? JOB : options.job;
  const appName = options.app === undefined ? APP : options.app;
  const job = jobName === null ? null : counted(poolBinding(jobName));
  const app = appName === null ? null : counted(poolBinding(appName));
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    // T-1540: staging's link host (wrangler.jsonc vars), which the listing ports read at each gate call, never as built.
    LINK_HOST: "rosfield.com",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    ...(options.wrapKey === false ? {} : { [WRAP_KEY_NAME]: TEST_WRAP_KEY }),
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    ...(app === null ? {} : { HYPERDRIVE_APP: app.binding }),
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

/** The handle over an env, each of its timing lines kept in `written`. */
function handleOver(env: StagingEnv, written: Json[]): StagingDb {
  const db = stagingDb(env, {
    write: (line) => {
      everyLine.push(line);
      written.push(parsed(line));
    },
  });
  HANDLES.push(db);
  return db;
}

/**
 * Every part off the gate's path, stood in by its nothing-bound answer (each stub's own, as T-1257 made it; DL-776): a
 * root built with these binds this card's part, T-1395's turn calls and T-1397's adapter, each by its own builder.
 */
const OFF_THE_GATE_PATH: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
};

/** Every part but this card's stood in (DL-776): what such a build reads is stagingOptions' and this part's alone. */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  ...OFF_THE_GATE_PATH,
  turn: () => NO_TURN_CALL_INPUTS,
  bundleSafety: () => null,
};

interface Rooted {
  readonly root: Root;
  /** The root's one handle (T-1254's, through ./part.ts): its counts are the root's. */
  readonly db: StagingDb;
  readonly inputs: StagingInputs;
  /** Each call's timing line the handle wrote, in order. */
  readonly written: Json[];
  /** This card's input, as stagingOptions gave it. */
  readonly gate: GateReads;
  /** T-1397's one adapter, as stagingOptions gave it. */
  readonly adapter: BundleSafetyLines;
}

/**
 * A root built as workerRoot builds the Worker's (composeRoot over stagingOptions(env)), over the test's env, on `db`
 * (whose timing lines are kept in `written`), with this card's part, T-1395's and T-1397's bound by their own builders.
 */
function rootOn(testEnv: TestEnv, db: StagingDb, written: Json[]): Rooted {
  const inputs = stagingOptions(testEnv.env, { db, builders: OFF_THE_GATE_PATH });
  const root = composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });
  const { gateReads, bundleSafety } = inputs;
  if (gateReads === null || bundleSafety === null)
    throw new Error("the gate's path is bound on this file's pair");
  return { root, db, inputs, written, gate: gateReads, adapter: bundleSafety };
}

/** rootOn over a handle of the root's own, its timing lines kept. */
function rootOver(testEnv: TestEnv): Rooted {
  const written: Json[] = [];
  return rootOn(testEnv, handleOver(testEnv.env, written), written);
}

/** bundle v0 through T-1397's check, as the pin asks it, over the root's bound bundle port. */
async function checkV0(rooted: Rooted): Promise<void> {
  await rooted.adapter.checkPin({ bundleId: { ...V0 }, bundles: rooted.root.ports.bundles });
  expect(answeringBundleOf(rooted.adapter)).toEqual(V0);
}

/** One timing line as [call, side, binding, login]. */
type CallOn = readonly [unknown, unknown, unknown, unknown];

/** A call on the Tool API's side: a client from HYPERDRIVE_APP, as rosie_worker_app. */
const onApp = (call: string): CallOn => [call, "toolApi", DB_SIDES.toolApi.binding, DB_SIDES.toolApi.login];
/** A call on the runtime side: a client from HYPERDRIVE_JOB, as rosie_worker_job. */
const onJob = (call: string): CallOn => [call, "runtime", DB_SIDES.runtime.binding, DB_SIDES.runtime.login];

/** Each call a handle timed, in order, its every line labels and numbers only. */
function callsOf(written: readonly Json[]): CallOn[] {
  for (const line of written) {
    expect(Object.keys(line).sort()).toEqual([
      "binding",
      "call",
      "connect",
      "environment",
      "guard",
      "level",
      "login",
      "msg",
      "side",
      "trace_id",
      "version",
    ]);
    expect(line).toMatchObject({ level: "info", msg: "dbCall", environment: "staging", version: "test-sha" });
  }
  return written.map((line) => [line.call, line.side, line.binding, line.login]);
}

/** The test's own handle on this file's pair (T-1254's, each client on its quiet socket). */
const own = dbHandle(
  {
    ENVIRONMENT: "staging",
    DB_SCHEMA: "",
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
  },
  { log: () => undefined },
);

/** The made-up wrapping key, as the resolver gives it, for the test's own reads of what was sealed. */
const TEST_KEYS = { resolve: (name: string) => (name === WRAP_KEY_NAME ? TEST_WRAP_KEY : undefined) };

const COUNTED_TABLES = [
  "turns",
  "threads",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "safety_outcomes",
  "safety_holds",
  "sealing_keys",
  "persons",
  "handles",
  "event_log",
] as const;

type RowCounts = Record<(typeof COUNTED_TABLES)[number], number>;

/** The row count of every table a gate could write, as the runtime side reads it with no scope. */
function rowCounts(): Promise<RowCounts> {
  return own.runtime("rowCounts", async (sql) => {
    const out: Partial<RowCounts> = {};
    for (const table of COUNTED_TABLES) {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
      out[table] = row?.n ?? -1;
    }
    return out as RowCounts;
  });
}

/** The counts after a commit that wrote these rows on top of `before`. */
const plus = (before: RowCounts, more: Partial<RowCounts>): RowCounts => {
  const out = { ...before };
  for (const [table, n] of Object.entries(more)) out[table as keyof RowCounts] += n;
  return out;
};

// ---- what an error gives away (as T-1254's test searches it) ---------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** The texts an error gives away: its message, its stack but for the frames, its own fields as JSON, and as a string. */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  const fields = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key): [string, unknown] => [key, Reflect.get(error, key)]),
  );
  return [error.message, stack, JSON.stringify(error), JSON.stringify({ ...fields, stack }), String(error)];
}

/** Whether `text` holds `part` as a whole name (not inside a longer name). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/** The parts of a binding's string no text may hold: the string, its host, user, password and database. */
function placeOf(binding: { readonly connectionString: string }): string[] {
  const url = new URL(binding.connectionString);
  return [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
}

/** Every text holds none of the binding's string, host, user, password or database. */
function expectNothingOf(binding: { readonly connectionString: string }, texts: readonly string[]): void {
  const parts = placeOf(binding);
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of texts) {
    for (const part of parts)
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
  }
}

// ---- the gates' requests ---------------------------------------------------------------------------------------------

/** Nothing open at commit time (the lease's CommitContext): no hold and no unread text. */
const NOTHING_OPEN = { holds: [], unread: [] };

/** K-09 v1.5 commit-s1-01.json as this file reads it. */
const S1_01 = commitS101 as unknown as {
  readonly request: Json;
  readonly outcome: Json & { readonly parts: readonly Json[] };
};

/** commit-s1-01.json's own ids, as its request and outcome name them. */
const FIXTURE = {
  turnId: "turn-s1-01-sam",
  traceId: "trace-sam-0000",
  eventId: "evt-sam-s1-01",
  outcomeId: "safety-outcome-sam-s1-01",
} as const;

/** Whose first text a gate commits: a handle, its person, its number, its text and its chat. */
interface FirstTexter {
  readonly handleId: string;
  readonly personId: string;
  readonly number: string;
  readonly eventId: string;
  readonly chatId: string;
}

/** Test owner 1's first text, as commit-s1-01.json names it. */
const TURN_ONE: FirstTexter = {
  handleId: SAM.handleId,
  personId: SAM.personId,
  number: SAM.number,
  eventId: FIXTURE.eventId,
  chatId: SAM_CHAT,
};

/** One gate call: its K-09 request, its turn id and the trace it runs in. */
interface GateCall {
  readonly request: Json;
  readonly turnId: string;
  readonly trace: TraceContext;
}

/** A trace of its own under bundle v0, set to the turn, its spans kept. */
function traced(turnId: string): TraceContext {
  const trace = openTrace({ openedBy: "textWebhook", bundleId: { ...V0 }, sink: (span) => SPANS.push(span) });
  trace.setTurn(turnId);
  return trace;
}

/**
 * commit-s1-01.json's request for `who`'s first text: every id of the fixture's swapped for the texter's wherever the
 * request names it as a whole string, under the turn id the lease hashes from its event ids (CQ-09), on a trace of its
 * own, the turn, its context and decide's result pinned to bundle v0 (as calls.int.test.ts pins them). `record` false:
 * the text's record does not ride in this commit. `businessId`: the caller's business, where it is not the fixture's.
 */
async function firstTextGate(
  who: FirstTexter,
  options: { readonly record?: boolean; readonly businessId?: string } = {},
): Promise<GateCall> {
  const turnId = await turnIdOf([who.eventId]);
  const trace = traced(turnId);
  const pairs: readonly (readonly [string, string])[] = [
    [FIXTURE.turnId, turnId],
    [FIXTURE.traceId, trace.traceId],
    [FIXTURE.eventId, who.eventId],
    [SAM.handleId, who.handleId],
    [SAM.personId, who.personId],
    [SAM_CHAT, who.chatId],
    [SAM.number, who.number],
    ...(options.businessId === undefined ? [] : [[BARBERSHOP, options.businessId] as const]),
  ];
  let text = JSON.stringify(S1_01.request);
  for (const [from, to] of pairs) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  const request = JSON.parse(text) as Json & {
    turn: Json;
    input: { decided: { context: Json; decide: Json } };
    core: unknown[];
  };
  request.turn.bundleId = { ...V0 };
  request.input.decided.context.bundleId = { ...V0 };
  request.input.decided.decide.bundleId = { ...V0 };
  if (options.record === false) request.core = [];
  return { request, turnId, trace };
}

/** The ask record's text again (ASK_RECORD), its record a turn's one core action: a repeat whose line asks. */
async function askGate(): Promise<GateCall> {
  const { eventId } = ASK_RECORD;
  const turnId = await turnIdOf([eventId]);
  const trace = traced(turnId);
  const caller = {
    kind: "turn",
    turnId,
    requestId: turnId,
    businessId: BARBERSHOP,
    personId: SAM.personId,
    traceId: trace.traceId,
  };
  const read = structuredClone(safetyBusinessOwnLine);
  const [label] = read.read.labels;
  if (label === undefined) throw new Error("safety-business-own-line.json holds a label");
  const safety = { ...read, eventId, read: { labels: [{ ...label, tense: ASK_RECORD.tense }] } };
  const request = {
    caller,
    turn: {
      id: turnId,
      handleId: SAM.handleId,
      eventIds: [eventId],
      bundleId: { ...V0 },
      traceId: trace.traceId,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "coreOnly" },
    core: [
      {
        call: "recordSafetyOutcome",
        request: { caller, safety, handleId: SAM.handleId, bookingId: null, sentByActor: null },
      },
    ],
    now: "2026-10-19T18:31:05Z",
  };
  return { request, turnId, trace };
}

/** One gateAndCommit through the root's turn face, as the turn makes it (a closed port's throw as a rejection). */
async function gateOn(root: Root, call: GateCall): Promise<unknown> {
  return root.turn.toolApi.gateAndCommit(call.request as never, NOTHING_OPEN, call.trace);
}

/** An instant in UTC ending in Z (formats.v1 utc). */
const UTC_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;

/** The fixture's ids, built from the run's turn id instead (K-09 v1.5 default 131), as hop 8's test builds them. */
function asRun<T>(value: T, turnId: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll('-sam-1"', `-${turnId}-1"`)) as T;
}

/** commit-s1-01.json's outcome for a first text committed under `turnId`, its record's id the service's keyed one. */
async function committedFirstText(who: FirstTexter, turnId: string): Promise<Json> {
  const outcomeId = await KEYED_SAFETY_IDS.rowId("outcome", who.eventId);
  const outcome = JSON.parse(
    JSON.stringify(asRun(S1_01.outcome, turnId))
      .replaceAll(JSON.stringify(FIXTURE.turnId), JSON.stringify(turnId))
      .replaceAll(JSON.stringify(FIXTURE.outcomeId), JSON.stringify(outcomeId)),
  ) as Json & { written: { outboxRows: Json[] } };
  return {
    ...outcome,
    committedAt: expect.stringMatching(UTC_INSTANT) as string,
    written: {
      ...outcome.written,
      outboxRows: outcome.written.outboxRows.map((row) => ({
        ...row,
        commitSeq: expect.any(Number) as number,
      })),
    },
  };
}

/** A first text's rows as this file's database holds them, read on the runtime side. */
function firstTextRows(who: FirstTexter, turnId: string): Promise<Json> {
  return own.runtime("firstTextRows", async (sql) => {
    const [turn] = await sql<Json[]>`
      select state, handle_id, event_ids, trace_id, bundle_hash as hash, bundle_build as build from turns
      where id = ${turnId}
    `;
    const [thread] = await sql<Json[]>`
      select handle_id, kind, booking_id, linq_chat_id, reply_address from threads where id = ${`thread-s1-01-${turnId}-1`}
    `;
    const [question] = await sql<Json[]>`
      select status, step, handle_id, person_id, business_id from open_questions where id = ${`oq-s1-02-${turnId}-1`}
    `;
    const [clock] = await sql<Json[]>`
      select kind, state, open_question_id from clock_rows where id = ${`clock-oq-s1-02-${turnId}-1`}
    `;
    const [outbox] = await sql<Json[]>`
      select turn_id, state, channel, send_class, open_question_id, recipient_handle_id, plan from outbox_rows
      where id = ${`outbox-s1-02-${turnId}-1`}
    `;
    const [record] = await sql<Json[]>`
      select id, turn_id, business_id, handle_id, person_id, outcomes, labels from safety_outcomes
      where event_id = ${who.eventId}
    `;
    return { turn, thread, question, clock, outbox, record };
  });
}

/** What firstTextRows reads for a first text committed as commit-s1-01.json states it. */
async function firstTextStored(who: FirstTexter, turnId: string, traceId: string): Promise<Json> {
  return {
    turn: {
      state: "committed",
      handle_id: who.handleId,
      event_ids: [who.eventId],
      trace_id: traceId,
      ...V0,
    },
    thread: {
      handle_id: who.handleId,
      kind: "chat",
      booking_id: null,
      linq_chat_id: who.chatId,
      reply_address: null,
    },
    question: {
      status: "waiting",
      step: "S1-02",
      handle_id: who.handleId,
      person_id: who.personId,
      business_id: BARBERSHOP,
    },
    clock: { kind: "question", state: "waiting", open_question_id: `oq-s1-02-${turnId}-1` },
    outbox: {
      turn_id: turnId,
      state: "planned",
      channel: "imessage",
      send_class: "quick_reply",
      open_question_id: `oq-s1-02-${turnId}-1`,
      recipient_handle_id: who.handleId,
      plan: null,
    },
    record: {
      id: await KEYED_SAFETY_IDS.rowId("outcome", who.eventId),
      turn_id: turnId,
      business_id: BARBERSHOP,
      handle_id: who.handleId,
      person_id: who.personId,
      outcomes: ["No"],
      labels: ["No"],
    },
  };
}

/** What one first text's commit writes, on top of the counts before it (its event-log entries apart). */
const FIRST_TEXT_ROWS: Partial<RowCounts> = {
  turns: 1,
  threads: 1,
  open_questions: 1,
  clock_rows: 1,
  outbox_rows: 1,
  safety_outcomes: 1,
};

/**
 * Counts compared, the event log by whether it grew: a commit that writes rows appends their entries, and one that writes
 * its turn row alone appends none (the turn row has no entry of its own).
 */
async function expectCountsAfter(
  before: RowCounts,
  more: Partial<RowCounts>,
  log: "grows" | "same",
): Promise<RowCounts> {
  const after = await rowCounts();
  expect({ ...after, event_log: 0 }).toEqual({ ...plus(before, more), event_log: 0 });
  if (log === "grows") expect(after.event_log).toBeGreaterThan(before.event_log);
  else expect(after.event_log).toBe(before.event_log);
  return after;
}

// ---- side by side ----------------------------------------------------------------------------------------------------

interface HeldOpen {
  readonly db: StagingDb;
  /**
   * From now on each runtime-side call waits until `n` Tool API clients are in use at once (each past its guard, inside
   * its call), then every call runs as it came: so each Tool API client is held while the runtime-side calls run.
   */
  arm(n: number): void;
  /** The most Tool API clients in use at once since the wrapper was made. */
  toolApiPeak(): number;
}

/** A root (rootOn) whose handle's runtime-side calls wait as `arm` says (heldOpen), and that wrapper. */
function rootHeldOpen(testEnv: TestEnv): { readonly rooted: Rooted; readonly held: HeldOpen } {
  const written: Json[] = [];
  const held = heldOpen(handleOver(testEnv.env, written));
  return { rooted: rootOn(testEnv, held.db, written), held };
}

/** A handle whose runtime-side calls wait as `arm` says. Only the order is held: every call is the handle's own. */
function heldOpen(db: StagingDb): HeldOpen {
  let inUse = 0;
  let peak = 0;
  let wanted = 0;
  let release: () => void = () => undefined;
  let open: Promise<void> = Promise.resolve();
  return {
    arm(n) {
      wanted = n;
      open = new Promise((resolve) => {
        release = resolve;
      });
    },
    toolApiPeak: () => peak,
    db: {
      toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
        return db.toolApi(
          call,
          async (sql) => {
            inUse += 1;
            peak = Math.max(peak, inUse);
            if (inUse >= wanted) release();
            try {
              return await fn(sql);
            } finally {
              inUse -= 1;
            }
          },
          traceId,
        );
      },
      async runtime<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
        await open;
        return db.runtime(call, fn, traceId);
      },
      counts: () => db.counts(),
    },
  };
}

// ---- the secrets no line may hold -----------------------------------------------------------------------------------

/** Every number of this file's handles, in each form a number could leak in (each whole number as it is, then cut). */
const NUMBER_FORMS = [
  SAM,
  ...SIDE_BY_SIDE,
  ...SIX_AT_ONCE,
  NO_WRAP_KEY,
  NO_KEY,
  ONE_KIND,
  MULTI_KIND,
  // T-1540: the two S1-09 owners.
  LISTING_OWNER,
  MADE_UP_OWNER,
].flatMap(({ number }) => [number, number.slice(1), number.slice(2)]);

/** The words a text, a read or a seal holds here, and the fixed lines' words bundle v0 holds. */
const WORDS = [
  ...(
    S1_01.request.input as { decided: { context: { texts: { words: string }[] } } }
  ).decided.context.texts.map((text) => text.words),
  ...safetyBusinessOwnLine.read.labels.map((label) => label.evidence),
  "t1398 words to seal",
  // T-1494: the one-kind owner's text.
  "Plumbing",
  // T-1485: the multi-kind owner's three texts, and the company name the refused one gives.
  "Barbershop, plumbing, electrical",
  "They all share one company",
  "Plumbing and electrical share Lee Home Services",
  "Lee Home Services",
  // T-1540: the S1-09 owners' texts, and the names and towns they give.
  "Lee's Barbershop in Springfield, I'm the owner",
  "Springfield",
  "Maple Corner Cuts, Riverton",
  "Maple Corner Cuts",
  "Riverton",
  ...["safetyAsk", "safetyEmergency", "safetyCrisis", "outage"].map((id) => bundleV0FixedLine(id)),
];

/** (T-1540) The secure links' codes S1-10's writer minted in this file's tests: none may reach a line. */
const LINK_CODES: string[] = [];

/** The sealed values read back in this file's tests, as base64 and hex: none may reach a line. */
const SEALED: string[] = [];

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64Of = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** No text holds a word, a number, the address, the wrapping key, a chat id or a sealed value. */
function expectNoSecrets(texts: readonly string[]): void {
  const secrets = [
    ...WORDS,
    ...NUMBER_FORMS,
    SAM_EMAIL.address,
    TEST_WRAP_KEY,
    SAM_CHAT,
    ...[...SIDE_BY_SIDE, ...SIX_AT_ONCE].map((texter) => texter.chatId),
    // T-1485: the roster owners' chat ids too.
    ONE_KIND.chatId,
    MULTI_KIND.chatId,
    // T-1540: the S1-09 owners' chat ids, a secure link's start, and every code S1-10's writer minted.
    LISTING_OWNER.chatId,
    MADE_UP_OWNER.chatId,
    "https://rosfield.com/test/",
    ...LINK_CODES,
    ...SEALED,
  ];
  for (const text of texts) {
    for (const secret of secrets) expect(text, "a line holds a secret").not.toContain(secret);
  }
}

// ---- this file's database --------------------------------------------------------------------------------------------

describe("this file's database: the walking skeleton's rows, the made-up key's rows and the two records", () => {
  it("the rig made this file's database with bundle v0 active; the seed made Sam's key and each texter's under the made-up SEALING_WRAP_KEY, none for the no-key person, and wrote the two records", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_tool_api_gate$/u);
    const active = await own.runtime("readActiveBundle", (sql) => readActiveBundle(sql));
    expect(active).toMatchObject({ result: "active", bundleId: V0 });

    const stored = await own.runtime("seeded", async (sql) => ({
      keys: await sql<{ person_id: string; wrapping_key_name: string }[]>`
        select person_id, wrapping_key_name from sealing_keys order by person_id collate "C"
      `,
      samRoles: await sql<{ id: string }[]>`select id from person_roles where person_id = ${SAM.personId}`,
      records: await sql<{ event_id: string; business_id: string; outcomes: string[]; tenses: string[] }[]>`
        select event_id, business_id, outcomes, tenses from safety_outcomes order by event_id
      `,
      lineRow: await sql<{ id: string; send_class: string }[]>`
        select id, send_class from outbox_rows where turn_id = ${ASK_RECORD.turnId}
      `,
    }));
    const keyed = [
      SAM.personId,
      ...[...SIDE_BY_SIDE, ...SIX_AT_ONCE, NO_WRAP_KEY].map((each) => each.personId),
      // T-1494: the roster owner's, made at its first sight after the roster-owner set ran.
      ONE_KIND.personId,
      // T-1485: the second roster owner's, made the same way.
      MULTI_KIND.personId,
      // T-1540: the two S1-09 owners', made the same way.
      LISTING_OWNER.personId,
      MADE_UP_OWNER.personId,
    ];
    expect(stored.keys).toEqual(
      keyed.sort().map((personId) => ({ person_id: personId, wrapping_key_name: WRAP_KEY_NAME })),
    );
    expect(stored.keys.map((key) => key.person_id)).not.toContain(NO_KEY.personId);
    // T-1148's Sam: no role, so turn 1 is a first text.
    expect(stored.samRoles).toEqual([]);
    expect(stored.records).toEqual([
      {
        event_id: ASK_RECORD.eventId,
        business_id: BARBERSHOP,
        outcomes: [ASK_RECORD.outcome],
        tenses: ["unknown"],
      },
      {
        event_id: OTHER_BUSINESS_RECORD.eventId,
        business_id: YOGA_STUDIO,
        outcomes: ["No"],
        tenses: ["now"],
      },
    ]);
    expect(stored.lineRow).toEqual([
      { id: await KEYED_SAFETY_IDS.rowId("line", ASK_RECORD.eventId), send_class: "safety" },
    ]);
  });
});

// ---- built ---------------------------------------------------------------------------------------------------------

describe("built on staging: the six pieces, and nothing read but the environment and the two bindings' presence", () => {
  it("with both bindings: reads ENVIRONMENT, then each binding's presence, and no connection string or secret; holds scope, readOpenHolds, the seven safety reads, the sealer and the words, and no reader of its own", () => {
    const testEnv = envOf();
    const written: Json[] = [];
    const db = handleOver(testEnv.env, written);
    const adapter: BundleSafetyLines = {
      fixedLine: () => null,
      outcomeLine: () => null,
      dangerWords: () => [],
      checkPin: () => Promise.resolve(),
    };
    const part: GatePart = {
      env: testEnv.env,
      db,
      keys: sealingWrapKeys(testEnv.env),
      bundleSafety: adapter,
    };

    const reads = stagingGateReads(part);

    expect(testEnv.names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
    expect([testEnv.job?.reads.n, testEnv.app?.reads.n]).toEqual([0, 0]);
    expect(Object.keys(reads ?? {}).sort()).toEqual([
      "companies",
      "keywordDoor",
      "kinds",
      "listing",
      "questions",
      "readChatHandle",
      "readOpenHolds",
      "safetyReads",
      "scope",
      "sealer",
      "stop",
      "words",
    ]);
    // T-1540: S1-09's, S1-76's and S1-10's ports, GateListingReads' five members exactly; LINK_HOST and BASE_PATH are
    // read at each gate call, never as the root is built (the names read above).
    expect(Object.keys(reads?.listing ?? {}).sort()).toEqual([
      "linkPlace",
      "mobileId",
      "paging",
      "places",
      "reads",
    ]);
    expect(Object.keys(reads?.listing?.reads ?? {}).sort()).toEqual([
      "businessHead",
      "setupOnFile",
      "turnCompany",
    ]);
    expect(Object.keys(reads?.listing?.mobileId ?? {}).sort()).toEqual([
      "account",
      "turnCompany",
      "turnHandle",
    ]);
    expect(Object.keys(reads?.listing?.paging ?? {})).toEqual(["reader"]);
    // T-1494: the one-kind path's reads (item 79, item 72 and the catalog by id), CompaniesReads' four members exactly.
    expect(Object.keys(reads?.companies ?? {}).sort()).toEqual([
      "businessKinds",
      "kindDefaults",
      "kindNames",
      "pickedKinds",
    ]);
    // T-1519: the walk's chat read (K-05 v1.10 item 51), one function.
    expect(typeof reads?.readChatHandle).toBe("function");
    // T-1470: the walk's question read, and the kinds reads alone (items 78 and 79).
    expect(Object.keys(reads?.questions ?? {})).toEqual(["liveQuestion"]);
    expect(Object.keys(reads?.kinds ?? {})).toEqual(["reads"]);
    expect(reads?.kinds?.stop).toBeUndefined();
    expect(Object.keys(reads?.kinds?.reads ?? {}).sort()).toEqual(["catalog", "pickedKinds"]);
    // T-1516: the stop home's reads beside them (DL-1033 ruling 8), StopHomeReads' five members exactly.
    expect(Object.keys(reads?.stop ?? {})).toEqual(["reads"]);
    expect(Object.keys(reads?.stop?.reads ?? {}).sort()).toEqual([
      "consentsOfPersons",
      "handle",
      "handleIdsOfPerson",
      "personIdsOfHandle",
      "phoneOfHandle",
    ]);
    expect(Object.keys(reads?.safetyReads ?? {}).sort()).toEqual([
      "businessOwner",
      "businessZone",
      "hold",
      "holdOfOutcome",
      "outboxRowWritten",
      "outcome",
      "outcomeOfEvent",
    ]);
    // No adapter: the words are left out, the safety service's own default (notBuilt for a line that asks).
    expect(Object.keys(stagingGateReads({ ...part, bundleSafety: null }) ?? {}).sort()).toEqual([
      "companies",
      "keywordDoor",
      "kinds",
      "listing",
      "questions",
      "readChatHandle",
      "readOpenHolds",
      "safetyReads",
      "scope",
      "sealer",
      "stop",
    ]);
    // No call was made to build it.
    expect(written).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
    expect(GATE_CLIENTS_AT_ONCE * 2 * CONNECTIONS_PER_CLIENT).toBe(WORKER_CONNECTIONS);
  });

  it("through stagingOptions with every other part stood in (DL-776): it reads only ENVIRONMENT (stagingOptions' own check, then this part's) and the two presences, and its part is handed the one adapter the bundleSafety builder made, whose lines its words read", () => {
    const testEnv = envOf();
    const words = new Map([["safetyAsk", "t1398 stand-in words"]]);
    const adapter: BundleSafetyLines = {
      fixedLine: (id) => {
        const text = words.get(id);
        return text === undefined ? null : { id, text };
      },
      outcomeLine: () => null,
      dangerWords: () => [],
      checkPin: () => Promise.resolve(),
    };
    const handed: GatePart[] = [];
    const inputs = stagingOptions(testEnv.env, {
      db: handleOver(testEnv.env, []),
      builders: {
        ...EVERY_OTHER_PART_UNBOUND,
        bundleSafety: () => adapter,
        gate: (part) => {
          handed.push(part);
          return stagingGateReads(part);
        },
      },
    });

    expect(testEnv.names).toEqual(["ENVIRONMENT", "ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
    expect([testEnv.job?.reads.n, testEnv.app?.reads.n]).toEqual([0, 0]);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.bundleSafety).toBe(adapter);
    expect(inputs.bundleSafety).toBe(adapter);
    const gate = inputs.gateReads;
    if (gate === null) throw new Error("the gate is bound with both bindings");
    expect(gate.words?.fixedLine("safetyAsk")).toEqual({ id: "safetyAsk", text: "t1398 stand-in words" });
    expect(gate.words?.fixedLine("safetyCrisis")).toBeNull();
    // Nothing else of its input but the six pieces, T-1470's two, T-1516's stop reads, T-1519's chat read, T-1494's
    // one-kind reads and T-1540's listing ports.
    expect(Object.keys(gate).sort()).toEqual([
      "companies",
      "keywordDoor",
      "kinds",
      "listing",
      "questions",
      "readChatHandle",
      "readOpenHolds",
      "safetyReads",
      "scope",
      "sealer",
      "stop",
      "words",
    ]);
  });

  it("unbound: with neither binding, or either alone, the input is null, with nothing read but ENVIRONMENT and the presences", () => {
    for (const bindings of [
      { job: null, app: null },
      { job: JOB, app: null },
      { job: null, app: APP },
    ]) {
      const testEnv = envOf(bindings);
      const db = handleOver(testEnv.env, []);
      const reads = stagingGateReads({
        env: testEnv.env,
        db,
        keys: sealingWrapKeys(testEnv.env),
        bundleSafety: null,
      });
      expect(reads, JSON.stringify(bindings)).toBeNull();
      expect(testEnv.names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
      expect([testEnv.job?.reads.n ?? 0, testEnv.app?.reads.n ?? 0]).toEqual([0, 0]);
    }
  });
});

// ---- the reads before turn 1 -----------------------------------------------------------------------------------------

describe("the reads as their K-05 fixtures, before turn 1 commits", () => {
  it("the scope runs as rosie_worker_app under the call's business; read-safety-outcome-of-event-s1-01 finds nothing for Sam's first text; business-zone-barbershop; readOpenHolds lists the text unread while no record of it is stored", async () => {
    const { gate, written, db } = rootOver(envOf());
    const read = await gate.scope.withBusiness(BARBERSHOP, async (repo) => {
      const tx = repo as Sql;
      const [who] = await tx<{ session_login: string; current_login: string; scope: string | null }[]>`
        select session_user::text as session_login, current_user::text as current_login,
               current_setting('rosie.business_id', true) as scope
      `;
      return {
        who,
        outcome: await gate.safetyReads.outcomeOfEvent(
          repo,
          structuredClone(readSafetyOutcomeOfEventS101.request),
        ),
        zone: await gate.safetyReads.businessZone(repo, structuredClone(businessZoneBarbershop.request)),
        open: await gate.readOpenHolds(repo, {
          handleId: SAM.handleId,
          businessId: BARBERSHOP,
          eventIds: [FIXTURE.eventId],
        }),
      };
    });

    const login = DB_SIDES.toolApi.login;
    expect(read.who).toEqual({ session_login: login, current_login: login, scope: BARBERSHOP });
    // The fixtures' answers, but for readAt: the database's own now, where each fixture's is its given clock.
    expect(read.outcome).toEqual({
      ...readSafetyOutcomeOfEventS101.outcome,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
    });
    expect(read.zone).toEqual({
      ...businessZoneBarbershop.outcome,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
    });
    // A text with no record is named to readOpenHolds and listed unread (ADR-015 line 113).
    expect(read.open).toEqual({
      result: "openHolds",
      handleId: SAM.handleId,
      businessId: BARBERSHOP,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
      holds: [],
      unreadEventIds: [FIXTURE.eventId],
    });
    // One client, on the Tool API's side, for the whole call: the In reads ran on its transaction.
    expect(callsOf(written)).toEqual([onApp(GATE_CALLS.scope)]);
    expect(written.map((line) => line.trace_id)).toEqual([null]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0, connectionsPeak: 1 });
  });
});

// ---- the words and the danger question ---------------------------------------------------------------------------

describe("SafetyDeps.words from T-1397's adapter, read at each call, only from a bundle its check passed", () => {
  it("before any check the words are no port: the ask record's repeat (a line that asks the danger question) answers notBuilt and writes nothing; once bundle v0 passes the check its words are v0's, word for word, and the same gate commits, its record a repeat naming the first line", async () => {
    const before = await rowCounts();
    const rooted = rootOver(envOf());
    const { root, adapter } = rooted;
    const words = rooted.gate.words;
    if (words === undefined) throw new Error("the gate's part is handed the adapter");

    // No check passed in this root's adapter: no bundle's words are known.
    expect(answeringBundleOf(adapter)).toBeNull();
    expect(() => words.fixedLine("safetyAsk")).toThrow(NotBuiltError);
    const lineId = await KEYED_SAFETY_IDS.rowId("line", ASK_RECORD.eventId);
    expect(await gateOn(root, await askGate())).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(await rowCounts()).toEqual(before);

    await checkV0(rooted);
    for (const id of ["safetyAsk", "safetyEmergency", "safetyCrisis", "outage"]) {
      expect(words.fixedLine(id), id).toEqual({ id, text: bundleV0FixedLine(id) });
    }
    expect(words.fixedLine("t1398-no-such-line")).toBeNull();

    const call = await askGate();
    const answer = await gateOn(root, call);
    expect(answer).toMatchObject({
      result: "committed",
      turnId: call.turnId,
      repeated: false,
      parts: [],
      core: [
        {
          call: "recordSafetyOutcome",
          error: null,
          response: {
            outcomeId: await KEYED_SAFETY_IDS.rowId("outcome", ASK_RECORD.eventId),
            outcomes: [ASK_RECORD.outcome],
            hold: null,
            safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: lineId },
            told: [],
            nothingBooks: false,
            repeated: true,
          },
        },
      ],
      written: { written: [], outboxRows: [], promoted: [] },
    });
    // The record was a repeat: only the turn row is new, no record, hold, line row or entry.
    await expectCountsAfter(before, { turns: 1 }, "same");
  });
});

// ---- a rerun's pinned bundle, checked before the gate's face runs (T-1453) ----------------------------------------
//
// The turn's pin checks the bundle it reads as active (../real.ts checkedPin), but a rerun keeps the id its turn stored and
// runs no check (../../bundle/pin.ts), so in a fresh isolate (an alarm's rerun after a deploy) the adapter has passed no
// check and the gate's words know no bundle. Here each run's pin is the real pin over a HandleActor's own storage, reading
// through a root's `pin` as root.install() sets it, and the gate is the root's own (../real.ts realGate over the root's gate
// reads, its turn-row port's commitTurn and its bound bundle port), the run's pinned bundle found for the call's trace as
// the root's lease hooks keep it (../pinned-runs.ts). Each gate is the ask record's repeat (its line asks the danger
// question, so the words are read) in a turn of its own: that text and one with no record.

type Namespace = DurableObjectNamespace<HandleActor>;

/** Whole fiction-range numbers (555-01xx), one per HandleActor whose storage holds a turn's pins here. */
const PIN_ACTOR_PHONES: readonly string[] = [
  "+15555550171",
  "+15555550172",
  "+15555550173",
  "+15555550174",
  "+15555550175",
  "+15555550176",
];
let pinActors = 0;

/** A HandleActor of its own for each turn, so no turn's pins meet another's stored rows. */
function pinActor(): DurableObjectStub<HandleActor> {
  const ns = (exports as unknown as { HandleActor: Namespace }).HandleActor;
  const phone = PIN_ACTOR_PHONES[pinActors];
  pinActors += 1;
  if (phone === undefined) throw new Error("more turns than fiction-range numbers in PIN_ACTOR_PHONES");
  return ns.get(ns.idFromName(`phone:${phone}`));
}

/** What the lease hands the pin for a run of `call`'s turn: its first run (try 1), or a rerun after a lapse (try 2). */
function pinRequestOf(call: GateCall, tries: number): PinRequest {
  return {
    turnId: call.turnId,
    traceId: call.trace.traceId,
    joinedTraceIds: [],
    texts: 2,
    tries,
    restart: false,
    leaseMs: 60_000,
    arrivedUnder: { ...V0 },
  };
}

/**
 * One run's pin by the real pin over the actor's own storage, reading through `deps` (a root's `pin`, as root.install()
 * sets it, and the KV `deps` names); each lease span it records is kept in `spans`. The actor has no BUNDLES binding.
 */
async function pinRun(
  actor: DurableObjectStub<HandleActor>,
  deps: BundleDeps,
  request: PinRequest,
  spans: Json[],
): Promise<TurnPin> {
  const restore = setBundleDeps(deps);
  try {
    const pin = await runInDurableObject(actor, (_actor, state) =>
      new BundlePins({
        storage: state.storage,
        now: () => 3000,
        kv: () => null,
        spanSink: () => (span: Span) => {
          spans.push(span as unknown as Json);
        },
      }).pin(request, new AbortController().signal),
    );
    if (pin === null) throw new Error("the run pinned no bundle");
    return pin;
  } finally {
    restore();
  }
}

/** Each run's lease span, as [tries, bundle id, bundleKept]. */
const leaseRuns = (spans: readonly Json[]): unknown[][] =>
  spans
    .filter((span) => span.hop === "lease")
    .map((span) => [(span.decided as Json).tries, span.bundle_id, (span.decided as Json).bundleKept]);

/**
 * `call`'s turn pinned twice on one actor's storage: its first run through `first` (the isolate whose check let the
 * bundle through), then its rerun through `rerun` (a fresh isolate's root after a deploy, or the same one), which keeps
 * the stored id. The rerun's pin.
 */
async function pinnedRerun(first: BundleDeps, rerun: BundleDeps, call: GateCall): Promise<TurnPin> {
  const actor = pinActor();
  const spans: Json[] = [];
  await pinRun(actor, first, pinRequestOf(call, 1), spans);
  const pin = await pinRun(actor, rerun, pinRequestOf(call, 2), spans);
  // One bundle for the turn: the rerun kept the id its first run stored, and its pin ran no check.
  expect(leaseRuns(spans)).toEqual([
    [1, V0, false],
    [2, V0, true],
  ]);
  expect(pin.bundleId).toEqual(V0);
  return pin;
}

/**
 * The gate as the root builds it (../real.ts realGate; ../root.ts composeRoot's gate inputs): the root's gate reads, its
 * turn-row port's commitTurn and its bound bundle port (or `bundles`), with `pinned` as the bundle the call's run pinned.
 */
function pinnedGate(
  gate: { readonly root: Root; readonly reads: GateReads | null },
  call: GateCall,
  pinned: PinnedBundle,
  bundles?: BundleDeps,
): Promise<unknown> {
  return realGate({
    reads: gate.reads,
    commitTurn: (request) => gate.root.ports.turnRow.commitTurn(request),
    bundles: () => bundles ?? gate.root.ports.bundles,
    pinnedOf: (trace) => (trace === call.trace ? pinned : null),
  }).gateAndCommit(call.request as never, NOTHING_OPEN, call.trace);
}

/**
 * The ask record's repeat (ASK_RECORD: a record whose line asks the danger question) as the one core action of a turn of
 * its own, a rerun's (try 2): that text and `other`, a text with no record, under `bundleId` (bundle v0 unless named).
 */
async function askTurnGate(other: string, bundleId: BundleId = V0): Promise<GateCall> {
  const eventIds = [ASK_RECORD.eventId, other];
  const turnId = await turnIdOf(eventIds);
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: { ...bundleId },
    sink: (span) => SPANS.push(span),
  });
  trace.setTurn(turnId);
  const caller = {
    kind: "turn",
    turnId,
    requestId: turnId,
    businessId: BARBERSHOP,
    personId: SAM.personId,
    traceId: trace.traceId,
  };
  const read = structuredClone(safetyBusinessOwnLine);
  const [label] = read.read.labels;
  if (label === undefined) throw new Error("safety-business-own-line.json holds a label");
  const safety = {
    ...read,
    eventId: ASK_RECORD.eventId,
    read: { labels: [{ ...label, tense: ASK_RECORD.tense }] },
  };
  const request = {
    caller,
    turn: {
      id: turnId,
      handleId: SAM.handleId,
      eventIds,
      bundleId: { ...bundleId },
      traceId: trace.traceId,
      joinedTraceIds: [],
      tries: 2,
    },
    input: { kind: "coreOnly" },
    core: [
      {
        call: "recordSafetyOutcome",
        request: { caller, safety, handleId: SAM.handleId, bookingId: null, sentByActor: null },
      },
    ],
    now: "2026-10-19T18:31:05Z",
  };
  return { request, turnId, trace };
}

/**
 * The ask record's repeat committed under `call`'s turn, as far as the gate's answer says it: its first line named
 * (safetyEmergency's row), nothing written.
 */
async function askCommitted(call: GateCall): Promise<Json> {
  return {
    result: "committed",
    turnId: call.turnId,
    repeated: false,
    parts: [],
    core: [
      {
        call: "recordSafetyOutcome",
        error: null,
        response: {
          outcomeId: await KEYED_SAFETY_IDS.rowId("outcome", ASK_RECORD.eventId),
          outcomes: [ASK_RECORD.outcome],
          hold: null,
          safetyLine: {
            fixedLineId: "safetyEmergency",
            outboxRowId: await KEYED_SAFETY_IDS.rowId("line", ASK_RECORD.eventId),
          },
          told: [],
          nothingBooks: false,
          repeated: true,
        },
      },
    ],
    written: { written: [], outboxRows: [], promoted: [] },
  };
}

/** The adapters' check lines among `written` (./bundle-safety.ts: one JSON line each on console.log), in order. */
const checkLinesOf = (written: readonly string[]): Json[] =>
  written
    .flatMap((line) => (line.startsWith("{") ? [parsed(line)] : []))
    .filter((line) => line.msg === "bundleSafetyCheck");

/** A bundle port over `port`'s registry whose every K-05 call is named in `made` (and nothing else changed). */
function countedPort(port: BundleDeps, made: string[]): BundleDeps {
  return {
    ...(port.kv === undefined ? {} : { kv: port.kv }),
    registry: {
      readActiveBundle: (request) => {
        made.push("readActiveBundle");
        return port.registry.readActiveBundle(request);
      },
      readBundleValue: (request) => {
        made.push(`readBundleValue ${request.key.split("/").slice(3).join("/")}`);
        return port.registry.readBundleValue(request);
      },
    },
  };
}

/** The actor's BUNDLES KV, as a double holding `bundle`'s values as a publish writes them. */
function kvHolding(bundle: Pick<SeedBundle, "values">): BundleKv {
  const held = new Map(bundle.values.map((value) => [value.key, value.text]));
  return { get: (key) => Promise.resolve(held.get(key) ?? null) };
}

describe("a rerun's pinned bundle is checked before the gate's face runs (T-1453)", () => {
  it("a rerun in a fresh isolate: its pin kept bundle v0 and ran no check, so the gate awaits this isolate's check for that id before its scope opens; the ask record's repeat then commits with v0's words (on main it answered notBuilt)", async () => {
    const before = await rowCounts();
    // The turn's first run: pinned in another isolate, whose check let bundle v0 through.
    const first = rootOver(envOf());
    // Its rerun: an alarm in a fresh isolate after a deploy, a root of its own and the one adapter it made.
    const fresh = rootOver(envOf());
    const call = await askTurnGate("evt-t1453-rerun");

    const rerun = await pinnedRerun(first.root.pin, fresh.root.pin, call);

    // The rerun's pin ran no check: this isolate's adapter has passed none, and its words know no bundle.
    expect(answeringBundleOf(first.adapter)).toEqual(V0);
    expect(answeringBundleOf(fresh.adapter)).toBeNull();
    const words = fresh.gate.words;
    if (words === undefined) throw new Error("the gate's part is handed the adapter");
    expect(() => words.fixedLine("safetyAsk")).toThrow(NotBuiltError);
    const checksBefore = checkLinesOf(lines).length;
    const calledBefore = fresh.written.length;

    const answer = await pinnedGate({ root: fresh.root, reads: fresh.gate }, call, rerun.bundle);

    expect(answer).toMatchObject(await askCommitted(call));
    // The check, for the stored id, read bundle v0 once (PostgreSQL's copy: no BUNDLES here) before the scope opened.
    expect(checkLinesOf(lines).slice(checksBefore)).toEqual([
      expect.objectContaining({
        level: "info",
        bundle_id: V0,
        outcome: "passed",
        parts: ["manifest", "flow/A"],
        from: ["postgres", "postgres"],
        answers_for: V0,
      }),
    ]);
    expect(callsOf(fresh.written.slice(calledBefore)).slice(0, 3)).toEqual([
      onJob("readBundleValue"),
      onJob("readBundleValue"),
      onApp(GATE_CALLS.scope),
    ]);
    // The words now answer for the stored bundle, word for word.
    expect(answeringBundleOf(fresh.adapter)).toEqual(V0);
    for (const id of ["safetyAsk", "safetyEmergency", "safetyCrisis"]) {
      expect(words.fixedLine(id), id).toEqual({ id, text: bundleV0FixedLine(id) });
    }
    // A repeat: only the turn row is new.
    await expectCountsAfter(before, { turns: 1 }, "same");
  });

  it("a warm isolate: the turn's first run pinned v0 through this isolate's own check, so the gate's check for the stored id passes at once: asked once, no bundle value read and no check line", async () => {
    const before = await rowCounts();
    const testEnv = envOf();
    const rooted = rootOver(testEnv);
    const call = await askTurnGate("evt-t1453-warm");
    const rerun = await pinnedRerun(rooted.root.pin, rooted.root.pin, call);
    expect(answeringBundleOf(rooted.adapter)).toEqual(V0);
    // The gate's part over the root's one adapter, each check it asks named.
    const asked: unknown[] = [];
    const adapter = rooted.adapter;
    const counting: BundleSafetyLines = {
      fixedLine: (id) => adapter.fixedLine(id),
      outcomeLine: (outcome) => adapter.outcomeLine(outcome),
      dangerWords: () => adapter.dangerWords(),
      checkPin: (request) => {
        asked.push(request.bundleId);
        return adapter.checkPin(request);
      },
    };
    const reads = stagingGateReads({
      env: testEnv.env,
      db: rooted.db,
      keys: sealingWrapKeys(testEnv.env),
      bundleSafety: counting,
    });
    const made: string[] = [];
    const checksBefore = checkLinesOf(lines).length;
    const calledBefore = rooted.written.length;

    const answer = await pinnedGate(
      { root: rooted.root, reads },
      call,
      rerun.bundle,
      countedPort(rooted.root.ports.bundles, made),
    );

    expect(answer).toMatchObject(await askCommitted(call));
    expect(asked).toEqual([V0]);
    // Kept already: nothing read for the check, no line written, and the scope's call is the gate's first.
    expect(made).toEqual([]);
    expect(checkLinesOf(lines).slice(checksBefore)).toEqual([]);
    expect(callsOf(rooted.written.slice(calledBefore))[0]).toEqual(onApp(GATE_CALLS.scope));
    await expectCountsAfter(before, { turns: 1 }, "same");
  });

  it("a failed check: the bound bundle port loses its read (K-05's transient), so the check keeps nothing and the gate fails as for any read, before its scope opens and with nothing written; the next gate, with the read back, commits", async () => {
    const before = await rowCounts();
    const first = rootOver(envOf());
    const fresh = rootOver(envOf());
    const call = await askTurnGate("evt-t1453-lost");
    const rerun = await pinnedRerun(first.root.pin, fresh.root.pin, call);
    const lost: BundleDeps = {
      registry: {
        readActiveBundle: (request) => fresh.root.ports.bundles.registry.readActiveBundle(request),
        readBundleValue: () => Promise.resolve({ error: "transient", sqlstate: "08006" }),
      },
    };
    const checksBefore = checkLinesOf(lines).length;
    const calledBefore = fresh.written.length;

    const thrown = await rejectionOf(
      pinnedGate({ root: fresh.root, reads: fresh.gate }, call, rerun.bundle, lost),
    );

    expect(thrown).toBeInstanceOf(BundleUnreadableError);
    expect(thrown).toMatchObject({ code: "transient", call: "readBundleValue", sqlstate: "08006" });
    expect(answeringBundleOf(fresh.adapter)).toBeNull();
    expect(checkLinesOf(lines).slice(checksBefore)).toEqual([
      expect.objectContaining({
        level: "error",
        bundle_id: V0,
        outcome: "unreadable",
        error_code: "transient",
        answers_for: null,
      }),
    ]);
    // No call was made: the gate's scope never opened.
    expect(fresh.written.slice(calledBefore)).toEqual([]);
    expect(await rowCounts()).toEqual(before);

    // The lease runs the turn again: with the read back, the check passes and the same gate commits.
    expect(await pinnedGate({ root: fresh.root, reads: fresh.gate }, call, rerun.bundle)).toMatchObject(
      await askCommitted(call),
    );
    await expectCountsAfter(before, { turns: 1 }, "same");
  });

  it("a refused bundle: the run's stored bundle is one the check refuses (its safetyAsk line has no words), so it is kept nowhere and the ask record's repeat still answers notBuilt, with nothing written", async () => {
    const before = await rowCounts();
    const rooted = rootOver(envOf());
    const refused = await bundleOf(13, { A: V0_FLOW_A }, withoutWords("safetyAsk"));
    const kv = kvHolding(refused);
    const port = rooted.root.ports.bundles;
    // The turn's id stored under that bundle (K-05's active id answered as it, its values in the actor's BUNDLES KV).
    const activeRefused: BundleDeps = {
      kv,
      registry: {
        readActiveBundle: () =>
          Promise.resolve({
            result: "active",
            bundleId: { ...refused.bundleId },
            manifestKey: `bundle/${refused.bundleId.hash}/${String(refused.bundleId.build)}/manifest`,
            activatedAt: "2026-11-14T12:00:00Z",
          }),
        readBundleValue: (request) => port.registry.readBundleValue(request),
      },
    };
    const call = await askTurnGate("evt-t1453-refused", refused.bundleId);
    const pin = await pinRun(pinActor(), activeRefused, pinRequestOf(call, 1), []);
    expect(pin.bundleId).toEqual(refused.bundleId);
    const checksBefore = checkLinesOf(lines).length;

    const answer = await pinnedGate({ root: rooted.root, reads: rooted.gate }, call, pin.bundle, {
      registry: port.registry,
      kv,
    });

    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(checkLinesOf(lines).slice(checksBefore)).toEqual([
      expect.objectContaining({
        level: "error",
        bundle_id: refused.bundleId,
        outcome: "refused",
        checks: ["safetyAskWords"],
        answers_for: null,
      }),
    ]);
    expect(answeringBundleOf(rooted.adapter)).toBeNull();
    expect(await rowCounts()).toEqual(before);
  });

  it("unchanged with no adapter and with no reads: staging's gate part holds the check on its words only with an adapter; with none the rerun's gate reads no bundle and answers notBuilt as before; with no reads (production, unbound) it fails closed inside the base, the bundle port never asked", async () => {
    const before = await rowCounts();
    // With the adapter the words carry its check; with none there are no words, and nothing to check.
    const built = rootOver(envOf());
    expect(typeof built.gate.words?.checkPin).toBe("function");
    const testEnv = envOf();
    const written: Json[] = [];
    const db = handleOver(testEnv.env, written);
    const inputs = stagingOptions(testEnv.env, {
      db,
      builders: { ...OFF_THE_GATE_PATH, bundleSafety: () => null },
    });
    const reads = inputs.gateReads;
    if (reads === null) throw new Error("the gate's part is bound on this file's pair");
    expect(reads.words).toBeUndefined();
    const root = composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });
    const call = await askTurnGate("evt-t1453-unchanged");
    const rerun = await pinnedRerun(built.root.pin, root.pin, call);
    const made: string[] = [];
    const calledBefore = written.length;

    const answer = await pinnedGate(
      { root, reads },
      call,
      rerun.bundle,
      countedPort(root.ports.bundles, made),
    );

    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(made).toEqual([]);
    expect(callsOf(written.slice(calledBefore))[0]).toEqual(onApp(GATE_CALLS.scope));

    // No reads at all: the gate fails closed inside the base before anything is read, the bundle port never asked.
    const thrown = await rejectionOf(
      realGate({
        reads: null,
        commitTurn: () => Promise.reject(new NoDatabaseError("commitTurn")),
        bundles: () => countedPort(root.ports.bundles, made),
        pinnedOf: (trace) => (trace === call.trace ? rerun.bundle : null),
      }).gateAndCommit(call.request as never, NOTHING_OPEN, call.trace),
    );
    expect(thrown).toEqual(new NoDatabaseError("gateAndCommit"));
    expect(made).toEqual([]);
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- turn 1's gate ------------------------------------------------------------------------------------------------

/** Turn 1's call and its sealed record's bytes, kept for the tests after it. */
let turnOne: GateCall | null = null;

describe("turn 1's gate: K-09 v1.5 commit-s1-01.json's request commits once, through PostgreSQL", () => {
  it(
    "commits its turns row and the rows commit-s1-01.json names (the thread, S1-02's question, its clock row, the outbox row, the No record sealed under Sam's own key); the scope ran as rosie_worker_app and the commit as rosie_worker_job; the same turn id again answers the first commit with nothing written",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const rooted = rootOver(envOf());
      await checkV0(rooted);
      const checked = rooted.written.length;
      const call = await firstTextGate(TURN_ONE);
      turnOne = call;

      const first = await gateOn(rooted.root, call);

      expect(first).toEqual(await committedFirstText(TURN_ONE, call.turnId));
      await expectCountsAfter(before, FIRST_TEXT_ROWS, "grows");
      expect(await firstTextRows(TURN_ONE, call.turnId)).toEqual(
        await firstTextStored(TURN_ONE, call.turnId, call.trace.traceId),
      );

      // The record's words, sealed under Sam's existing key, open under it again with the made-up wrapping key.
      const sealed = await own.runtime("sealedWords", async (sql) => {
        const [row] = await sql<{ sealed_words: Uint8Array | null }[]>`
          select sealed_words from safety_outcomes where event_id = ${TURN_ONE.eventId}
        `;
        if (row?.sealed_words == null) throw new Error("the record's words are sealed");
        const bytes = new Uint8Array(row.sealed_words);
        return { bytes, words: await unsealText(sql, TEST_KEYS, SAM.personId, bytes) };
      });
      SEALED.push(base64Of(sealed.bytes), hexOf(sealed.bytes));
      expect(JSON.parse(sealed.words)).toEqual({
        labels: [{ evidence: "", atRisk: "nobody", writer: "the person at the handle" }],
        dangerWords: [],
      });

      // Each call of the gate: the scope's client first, as rosie_worker_app, held for the whole call; every other on the
      // runtime side, as rosie_worker_job: the bundle reads, the seal and the commit, whose line is on the turn's trace.
      const gateLines = rooted.written.slice(checked);
      const calls = callsOf(gateLines);
      expect(calls[0]).toEqual(onApp(GATE_CALLS.scope));
      expect(calls.at(-1)).toEqual(onJob("commitTurn"));
      expect(calls.filter(([, side]) => side === "toolApi")).toEqual([onApp(GATE_CALLS.scope)]);
      expect(calls.filter(([, side]) => side === "runtime")).toEqual(
        calls.filter(([, side]) => side === "runtime").map(([name]) => onJob(String(name))),
      );
      expect(calls.map(([name]) => name)).toContain(GATE_CALLS.seal);
      // T-1519: S1-01's walk asked the chat read once, on the runtime side; no thread held Sam's chat, so it inserted.
      expect(calls.filter(([name]) => name === GATE_CALLS.chatHandle)).toEqual([
        onJob(GATE_CALLS.chatHandle),
      ]);
      expect(gateLines.at(-1)?.trace_id).toBe(call.trace.traceId);
      // ADR-014 line 198: the commit's current_user is the login its client's guard read, rosie_worker_job.
      expect(gateLines.at(-1)?.login).toBe("rosie_worker_job");
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({
        opened: rooted.written.length,
        ended: rooted.written.length,
        connectionsOpen: 0,
      });
      expect(counts.connectionsPeak).toBe(2 * CONNECTIONS_PER_CLIENT);

      // The same turn id again: K-05 answers the first commit, repeated, and nothing is written.
      const written = await rowCounts();
      const again = await gateOn(rooted.root, { ...call, request: structuredClone(call.request) });
      expect(again).toMatchObject({ result: "committed", turnId: call.turnId, repeated: true });
      expect((again as { written: { written: unknown[] } }).written.written).toEqual([]);
      expect(await rowCounts()).toEqual(written);
    },
  );
});

// ---- after turn 1: the other business, and the owner ---------------------------------------------------------------

describe("after turn 1: another business's scope, a text whose outcome another business holds, and the owner", () => {
  it("read-open-holds-other-business: under the yoga studio's scope Sam's first text, whose record is the barbershop's, counts as unread and no hold is listed; under the barbershop's it is read", async () => {
    const { gate } = rootOver(envOf());
    const ask = (businessId: string) =>
      gate.scope.withBusiness(businessId, (repo) =>
        gate.readOpenHolds(repo, { handleId: SAM.handleId, businessId, eventIds: [FIXTURE.eventId] }),
      );

    // The fixture's answer on this world: Sam's handle and his first text in place of Alex's (evt-alex-0204's record is
    // the barbershop's there, as Sam's is here).
    expect(readOpenHoldsOtherBusiness.request.businessId).toBe(YOGA_STUDIO);
    expect(await ask(YOGA_STUDIO)).toEqual({
      ...readOpenHoldsOtherBusiness.outcome,
      handleId: SAM.handleId,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
      unreadEventIds: [FIXTURE.eventId],
    });
    expect(await ask(BARBERSHOP)).toMatchObject({ holds: [], unreadEventIds: [] });
  });

  it("so every routine part is held: a gate whose text's outcome the yoga studio holds, its record not riding in the commit, answers its one part held (no limit checked) and writes its turn row alone", async () => {
    const before = await rowCounts();
    const { root } = rootOver(envOf());
    const call = await firstTextGate(
      { ...TURN_ONE, eventId: OTHER_BUSINESS_RECORD.eventId },
      { record: false },
    );

    const answer = await gateOn(root, call);

    expect(answer).toMatchObject({
      result: "committed",
      turnId: call.turnId,
      repeated: false,
      parts: [{ part: 0, choiceId: "c-01", result: "held" }],
      core: [],
      written: { written: [], outboxRows: [], promoted: [] },
    });
    const [part] = (answer as { parts: { limits: { result: string }[] }[] }).parts;
    expect(part?.limits.map((limit) => limit.result)).toEqual(Array.from({ length: 6 }, () => "notChecked"));
    await expectCountsAfter(before, { turns: 1 }, "same");
  });

  it("business-owner-phone-first: with Sam the barbershop's owner and his proven email handle, the owner is read on the runtime side as rosie_worker_job, his phone handle first", async () => {
    await own.runtime("writeOwnerRows", writeOwnerRows);
    const { gate, written, db } = rootOver(envOf());

    const owner = await gate.safetyReads.businessOwner(structuredClone(businessOwnerPhoneFirst.request));

    expect(owner).toEqual({
      ...businessOwnerPhoneFirst.outcome,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
    });
    expect(callsOf(written)).toEqual([onJob(GATE_CALLS.businessOwner)]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  });
});

// ---- the read-only sealer -------------------------------------------------------------------------------------------

describe("the read-only sealer: an existing key only, the wrapping key by name at each seal, every error scrubbed", () => {
  it("seals under Sam's existing key (the bytes open with it again) and makes no key; refuses a person with no key (noSealingKey) and makes none; each seal on a runtime-side client of its own", async () => {
    const before = await rowCounts();
    const { gate, written } = rootOver(envOf());

    const sealed = await gate.sealer.seal("t1398 words to seal", SAM.personId);
    SEALED.push(base64Of(sealed), hexOf(sealed));
    expect(await own.runtime("unseal", (sql) => unsealText(sql, TEST_KEYS, SAM.personId, sealed))).toBe(
      "t1398 words to seal",
    );

    const refused = await rejectionOf(gate.sealer.seal("t1398 words to seal", NO_KEY.personId));
    expect(refused).toBeInstanceOf(TurnFaceRefusedError);
    expect(refused).toMatchObject({ fault: "noSealingKey" });
    for (const text of textsOf(refused)) expect(text).not.toContain(NO_KEY.personId);

    expect(await rowCounts()).toEqual(before);
    expect(callsOf(written)).toEqual([onJob(GATE_CALLS.seal), onJob(GATE_CALLS.seal)]);
  });

  it("through the gate, a first text whose writer holds no key fails closed (noSealingKey) and writes nothing", async () => {
    const before = await rowCounts();
    const { root } = rootOver(envOf());
    const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_KEY)));
    expect(thrown).toBeInstanceOf(TurnFaceRefusedError);
    expect(thrown).toMatchObject({ fault: "noSealingKey" });
    expect(await rowCounts()).toEqual(before);
  });

  it("with SEALING_WRAP_KEY left out of the env: the seal fails with its code alone (wrapping_key_missing, the fixed words) and, through the gate, the commit writes nothing", async () => {
    const before = await rowCounts();
    const testEnv = envOf({ wrapKey: false });
    const { root, gate, written } = rootOver(testEnv);

    const direct = await rejectionOf(gate.sealer.seal("t1398 words to seal", NO_WRAP_KEY.personId));
    const viaGate = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));

    for (const thrown of [direct, viaGate]) {
      expect(thrown).toBeInstanceOf(SealingError);
      expect(thrown).toMatchObject({ name: "SealingError", code: "wrapping_key_missing" });
      expect((thrown as Error).message).toBe(new SealingError("wrapping_key_missing").message);
      expect(Object.keys(thrown as Error).sort()).toEqual(["code", "name"]);
      for (const text of textsOf(thrown)) expect(text).not.toContain(NO_WRAP_KEY.personId);
    }
    // The secret was asked for by its name alone, at the seal; the seal's call is named on its timing line.
    expect(testEnv.names.filter((name) => name === WRAP_KEY_NAME).length).toBeGreaterThanOrEqual(2);
    expect(callsOf(written).filter(([name]) => name === GATE_CALLS.seal)).toEqual([
      onJob(GATE_CALLS.seal),
      onJob(GATE_CALLS.seal),
    ]);
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- side by side -------------------------------------------------------------------------------------------------

describe("gates side by side (the audit's two rows composed side by side; critic_collisions N2, critic_size N6; DL-760, DL-761)", () => {
  it(
    "two gates at once, two seeded handles' first texts, each holding its Tool API client while its seal and commit open runtime-side clients, and two scopes at once each holding its client while the owner's read and a seal open theirs: every call finishes under the cap, 4 connections at once, opened equal to ended",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const { rooted, held: wrapper } = rootHeldOpen(envOf());
      await checkV0(rooted);

      wrapper.arm(SIDE_BY_SIDE.length);
      const calls = await Promise.all(SIDE_BY_SIDE.map((texter) => firstTextGate(texter)));
      const answers = await Promise.all(calls.map((call) => gateOn(rooted.root, call)));
      for (const [at, texter] of SIDE_BY_SIDE.entries()) {
        const call = calls[at];
        if (call === undefined) throw new Error("a call for each texter");
        expect(answers[at], texter.handleId).toEqual(await committedFirstText(texter, call.turnId));
        expect(await firstTextRows(texter, call.turnId)).toEqual(
          await firstTextStored(texter, call.turnId, call.trace.traceId),
        );
      }
      expect(wrapper.toolApiPeak()).toBe(2);
      expect(rooted.db.counts()).toMatchObject({ connectionsOpen: 0, connectionsPeak: 4 });

      // Two scopes at once, each reading the owner and sealing on the runtime side while its own transaction is held.
      wrapper.arm(2);
      const both = await Promise.all(
        [SAM.personId, SIDE_BY_SIDE[0]?.personId ?? ""].map((personId) =>
          rooted.gate.scope.withBusiness(BARBERSHOP, async () => {
            const owner = await rooted.gate.safetyReads.businessOwner({ businessId: BARBERSHOP });
            const sealed = await rooted.gate.sealer.seal("t1398 words to seal", personId);
            SEALED.push(base64Of(sealed), hexOf(sealed));
            return owner;
          }),
        ),
      );
      expect(both).toMatchObject([
        { result: "businessOwner", owner: businessOwnerPhoneFirst.outcome.owner },
        { result: "businessOwner", owner: businessOwnerPhoneFirst.outcome.owner },
      ]);

      const counts = rooted.db.counts();
      expect(counts).toMatchObject({
        opened: rooted.written.length,
        ended: rooted.written.length,
        connectionsOpen: 0,
      });
      expect(counts.connectionsPeak).toBe(2 * 2 * CONNECTIONS_PER_CLIENT);
      expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
      await expectCountsAfter(
        before,
        {
          turns: 2,
          threads: 2,
          open_questions: 2,
          clock_rows: 2,
          outbox_rows: 2,
          safety_outcomes: 2,
        },
        "grows",
      );
    },
  );

  it(
    "six gates at once, six seeded handles' first texts: at most 3 hold a Tool API client at once and the others wait; all six commit, the connections at once stay at 6 or fewer, and opened equals ended",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const { rooted, held: wrapper } = rootHeldOpen(envOf());
      await checkV0(rooted);
      const calls = await Promise.all(SIX_AT_ONCE.map((texter) => firstTextGate(texter)));

      // Every runtime-side call waits until as many Tool API clients are in use as the binding lets at once: each of
      // those holds its client while its seal and commit run, the worst the binding allows.
      wrapper.arm(Math.min(SIX_AT_ONCE.length, GATE_CLIENTS_AT_ONCE));
      const answers = await Promise.all(calls.map((call) => gateOn(rooted.root, call)));

      for (const [at, texter] of SIX_AT_ONCE.entries()) {
        const call = calls[at];
        if (call === undefined) throw new Error("a call for each texter");
        expect(answers[at], texter.handleId).toEqual(await committedFirstText(texter, call.turnId));
      }
      expect(wrapper.toolApiPeak()).toBe(GATE_CLIENTS_AT_ONCE);
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({
        opened: rooted.written.length,
        ended: rooted.written.length,
        connectionsOpen: 0,
      });
      expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
      const sides = callsOf(rooted.written);
      expect(sides.filter(([name]) => name === GATE_CALLS.scope)).toHaveLength(SIX_AT_ONCE.length);
      expect(sides.filter(([name]) => name === "commitTurn")).toHaveLength(SIX_AT_ONCE.length);
      await expectCountsAfter(
        before,
        Object.fromEntries(
          Object.entries(FIRST_TEXT_ROWS).map(([table, n]) => [table, n * SIX_AT_ONCE.length]),
        ),
        "grows",
      );
    },
  );
});

// ---- failing closed -----------------------------------------------------------------------------------------------

describe("failing closed: every gate fails inside the Tool API base, nothing written, labels only", () => {
  it("bindings left out (neither, or either alone): the input is null, so the gate fails closed inside the base (NoDatabaseError naming gateAndCommit) before anything is read or written; no binding's string is read and no call is timed", async () => {
    const before = await rowCounts();
    for (const bindings of [
      { job: null, app: null },
      { job: JOB, app: null },
      { job: null, app: APP },
    ]) {
      const testEnv = envOf(bindings);
      const written: Json[] = [];
      const db = handleOver(testEnv.env, written);
      const inputs = stagingOptions(testEnv.env, { db, builders: OFF_THE_GATE_PATH });
      expect(inputs.gateReads, JSON.stringify(bindings)).toBeNull();
      const root = composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });

      const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));

      expect(thrown).toEqual(new NoDatabaseError("gateAndCommit"));
      expect((thrown as Error).message).toBe("no database is bound here for gateAndCommit");
      expect([testEnv.job?.reads.n ?? 0, testEnv.app?.reads.n ?? 0]).toEqual([0, 0]);
      expect(written).toEqual([]);
      expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
      // Nothing is logged: no binding is read, so none is named, and the error names the call alone.
      expect(lines).toEqual([]);
    }
    expect(await rowCounts()).toEqual(before);
  });

  it("the pool's own HYPERDRIVE_APP (its database, rosie_rig_none, never made): the gate's scope fails with the call's name and SQLSTATE only, nothing of the binding's string in what is thrown, nothing read or written", async () => {
    const before = await rowCounts();
    const { root, written, db } = rootOver(envOf({ app: POOL_APP }));

    const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));

    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: GATE_CALLS.scope, code: "3D000", table: null, constraint: null });
    expect((thrown as Error).message).toBe(
      `${GATE_CALLS.scope}: the database refused the call (SQLSTATE 3D000)`,
    );
    expect(Object.keys(thrown as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
    for (const name of [POOL_APP, POOL_JOB, APP, JOB]) expectNothingOf(poolBinding(name), textsOf(thrown));
    // The guard never passed: no call was timed; the one client opened was ended.
    expect(written).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("a read's error answer is thrown, never read as none (K-05 v1.4 default 61): a gate under a business this database does not hold fails at readOpenHolds' notFound, and writes nothing", async () => {
    const before = await rowCounts();
    const { root } = rootOver(envOf());
    const thrown = await rejectionOf(
      gateOn(root, await firstTextGate(NO_WRAP_KEY, { businessId: "biz-t1398-none" })),
    );
    expect(thrown).toBeInstanceOf(TurnFaceReadError);
    expect(thrown).toMatchObject({ read: "readOpenHolds", code: "notFound" });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- the scope's start (T-1410) -----------------------------------------------------------------------------------

/** K-05's transient for a connection lost at the start: nothing was written, and the same request may be sent again. */
const LOST = { error: "transient", sqlstate: "08006" } as const;

/**
 * A handle whose Tool API calls lose their client once the guard has passed: each client, guarded and timed as every
 * call's is, is ended before the call's own code gets it, so the scope's begin is refused by postgres.js as a connection
 * that is gone (its CONNECTION_ENDED, the binding's host and port on it). Every call is the handle's own.
 */
function lostAfterGuard(db: StagingDb): StagingDb {
  return {
    toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
      return db.toolApi(
        call,
        async (sql) => {
          await sql.end({ timeout: 5 });
          return fn(sql);
        },
        traceId,
      );
    },
    runtime: (call, fn, traceId) => db.runtime(call, fn, traceId),
    counts: () => db.counts(),
  };
}

/**
 * A handle whose Tool API calls, once the guard has passed on the handle's own client, hand the call's code a client whose
 * every transaction's start is refused with `refusal()`, as postgres.js rejects a begin whose session PostgreSQL refused.
 */
function refusedAfterGuard(db: StagingDb, refusal: () => Error): StagingDb {
  const refusing = { begin: () => Promise.reject(refusal()) } as unknown as Sql;
  return {
    toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> {
      return db.toolApi(call, () => fn(refusing), traceId);
    },
    runtime: (call, fn, traceId) => db.runtime(call, fn, traceId),
    counts: () => db.counts(),
  };
}

/** A binding's database, as its connection string names it. */
const databaseOf = (binding: { readonly connectionString: string }): string =>
  decodeURIComponent(new URL(binding.connectionString).pathname.slice(1));

/**
 * PostgreSQL's refusals of a session at its start that name the database (postinit.c), as postgres.js rejects the begin
 * with one: its PostgresError, FATAL, the SQLSTATE and the server's words.
 */
const DATABASE_REFUSALS: readonly { code: string; words: (database: string) => string }[] = [
  { code: "3D000", words: (database) => `database "${database}" does not exist` },
  { code: "42501", words: (database) => `permission denied for database "${database}"` },
  { code: "55000", words: (database) => `database "${database}" is not currently accepting connections` },
];

/** One of those refusals, as postgres.js's PostgresError carries it: its name, its severity, its SQLSTATE and its words. */
function sessionRefusal(code: string, text: string): Error {
  return Object.assign(new Error(text), {
    name: "PostgresError",
    severity_local: "FATAL",
    severity: "FATAL",
    code,
  });
}

/** A root with this card's part bound over `db` and every other part stood in by its nothing-bound answer (DL-776). */
function gateRootOver(testEnv: TestEnv, db: StagingDb): Root {
  const inputs = stagingOptions(testEnv.env, { db, builders: EVERY_OTHER_PART_UNBOUND });
  if (inputs.gateReads === null) throw new Error("the gate's part is bound on this file's pair");
  return composeRoot({ environment: "staging", actors: null, vars: testEnv.env, ...inputs });
}

describe("the scope's start: the gate's transaction is opened for the K-09 call the Tool API base names (T-1410)", () => {
  it("lost once the guard has passed (the scope's client ended under it): the gate answers K-09's transient 08006, its handler never run: no runtime-side call, nothing written, the one client ended, nothing of the binding in the answer or a line", async () => {
    const before = await rowCounts();
    const testEnv = envOf();
    const written: Json[] = [];
    const db = handleOver(testEnv.env, written);
    const root = gateRootOver(testEnv, lostAfterGuard(db));

    const answer = await gateOn(root, await firstTextGate(NO_WRAP_KEY));

    expect(answer).toEqual(LOST);
    // The scope's one client, guarded and timed under gateAndCommit on the Tool API's side (its line labels and numbers
    // only, the guard's login among them: DL-757); nothing followed it.
    expect(callsOf(written)).toEqual([onApp(GATE_CALLS.scope)]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
    for (const name of [APP, JOB]) expectNothingOf(poolBinding(name), [JSON.stringify(answer), ...lines]);
  });

  it("refused at its start once the guard has passed (3D000, 42501 and 55000, this file's database in the server's words): the gate throws it scrubbed under gateAndCommit, the call's name and the SQLSTATE alone, never transient and never under withBusiness; nothing written", async () => {
    const before = await rowCounts();
    const database = databaseOf(poolBinding(APP));
    expect(database).not.toBe("");
    for (const { code, words } of DATABASE_REFUSALS) {
      const testEnv = envOf();
      const written: Json[] = [];
      const db = handleOver(testEnv.env, written);
      const refusal = (): Error => sessionRefusal(code, words(database));
      expect(holds(refusal().message, database), code).toBe(true);
      const root = gateRootOver(testEnv, refusedAfterGuard(db, refusal));

      const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));

      expect(thrown, code).toBeInstanceOf(DataAccessDatabaseError);
      expect(thrown, code).toMatchObject({ call: GATE_CALLS.scope, code, table: null, constraint: null });
      expect((thrown as Error).message, code).toBe(
        `${GATE_CALLS.scope}: the database refused the call (SQLSTATE ${code})`,
      );
      expect(Object.keys(thrown as Error).sort(), code).toEqual([
        "call",
        "code",
        "constraint",
        "name",
        "table",
      ]);
      for (const name of [APP, JOB]) expectNothingOf(poolBinding(name), textsOf(thrown));
      expect(callsOf(written), code).toEqual([onApp(GATE_CALLS.scope)]);
      expect(db.counts(), code).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
    }
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- the walk's question read and the kinds reads (T-1470) ----------------------------------------------------------
//
// What the gate binds for an answer to S1-02's question, each read by itself on this file's database (bundle v0 and the
// seed's rows: no second turn is walked here). The question read runs on the scope's own transaction; each kinds read
// opens a client of its own, asked from inside a held scope as a step writer asks it.

/** A person this database does not hold: a made-up row id, which no line may hold once item 79 has refused it. */
const NOBODY = "person-t1470-nobody";

/** The gate's two T-1470 pieces, as stagingOptions gave them. */
function signUpReadsOf(gate: GateReads) {
  const { questions, kinds } = gate;
  if (questions === undefined || kinds === undefined) {
    throw new Error("staging's gate binds the question read and the kinds reads");
  }
  return { questions, kinds: kinds.reads };
}

/** Who a scope's transaction runs as, and under which business. */
async function whoOn(repo: unknown): Promise<Json | undefined> {
  const tx = repo as Sql;
  const [who] = await tx<Json[]>`
    select session_user::text as session_login, current_user::text as current_login,
           current_setting('rosie.business_id', true) as scope
  `;
  return who;
}

describe("the walk's question read and the kinds reads, as the gate binds them for an answer to S1-02's question (T-1470)", () => {
  it("the question read, as rosie_worker_app inside the gate's own scope: the live question by its id, with its row's version (2, not 1) and when it went out; null under another business's scope, for another handle and for an id that is not live", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const { questions } = signUpReadsOf(gate);
    const login = DB_SIDES.toolApi.login;
    const ask = (businessId: string, handleId: string, openQuestionId: string) =>
      gate.scope.withBusiness(businessId, async (repo) => ({
        who: await whoOn(repo),
        question: await questions.liveQuestion(repo, handleId, openQuestionId),
      }));

    const live = await ask(BARBERSHOP, ASKED.handleId, ASKED.questionId);
    expect(live.who).toEqual({ session_login: login, current_login: login, scope: BARBERSHOP });
    expect(live.question).toEqual({
      id: ASKED.questionId,
      businessId: BARBERSHOP,
      bookingId: null,
      personId: ASKED.personId,
      turnId: ASKED.turnId,
      step: "S1-02",
      status: "open",
      options: [],
      readback: null,
      versionsRead: [],
      clock: null,
      sentAt: ASKED.sentAt,
      pollId: null,
      askCount: 1,
      bundleId: V0,
      version: ASKED.version,
    });
    expect(live.question?.version).not.toBe(1);

    // Another business's scope: row-level security shows it none of the barbershop's questions.
    const other = await ask(YOGA_STUDIO, ASKED.handleId, ASKED.questionId);
    expect(other.who).toEqual({ session_login: login, current_login: login, scope: YOGA_STUDIO });
    expect(other.question).toBeNull();
    // Another handle, asked for that question's id; and an id no live question of the handle has.
    expect((await ask(BARBERSHOP, SAM.handleId, ASKED.questionId)).question).toBeNull();
    expect((await ask(BARBERSHOP, ASKED.handleId, "oq-s1-02-t1470-not-live")).question).toBeNull();

    // One client each, the scope's own, on the Tool API's side: the read ran on the call's transaction and wrote nothing.
    expect(callsOf(written)).toEqual(Array.from({ length: 4 }, () => onApp(GATE_CALLS.scope)));
    expect(db.counts()).toMatchObject({ opened: 4, ended: 4, connectionsOpen: 0, connectionsPeak: 1 });
    expect(await rowCounts()).toEqual(before);
  });

  it("one gate alone: inside its held scope the catalog is read on a second Tool API client (rosie_worker_app), then item 79 on a runtime-side client (rosie_worker_job), each named on its timing line; 2 connections at most, opened equal to ended", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const { kinds } = signUpReadsOf(gate);
    const login = DB_SIDES.toolApi.login;

    const read = await gate.scope.withBusiness(BARBERSHOP, async (repo) => {
      const first = await whoOn(repo);
      const catalog = await kinds.catalog();
      const picked = await kinds.pickedKinds({ businessId: BARBERSHOP, personId: ASKED.personId });
      // The scope's own transaction answers again after both reads: its client was held throughout.
      return { first, catalog, picked, last: await whoOn(repo) };
    });

    expect(read.first).toEqual({ session_login: login, current_login: login, scope: BARBERSHOP });
    expect(read.last).toEqual(read.first);
    // Item 78: the seed's trade-file kinds as the matcher takes them, in id order.
    expect(read.catalog).toEqual(CATALOG);
    expect(read.catalog).toHaveLength(8);
    // Item 79: no pick yet, of the barbershop or of the asked owner with no business; the barbershop's companies as this
    // database holds them (T-1148's one), read back on the runtime side.
    const companies = await own.runtime("companies", (sql) =>
      sql<Json[]>`
        select id, business_id as "businessId", name, owner_person_id as "ownerPersonId", version from companies
        where business_id = ${BARBERSHOP} order by id collate "C"
      `.then((rows) => rows.map((row) => ({ ...row }))),
    );
    expect(companies).toHaveLength(1);
    expect(read.picked).toEqual({
      result: "pickedKinds",
      businessId: BARBERSHOP,
      personId: ASKED.personId,
      readAt: expect.stringMatching(UTC_INSTANT) as string,
      picks: [],
      companies,
    });

    // The scope's client first; then the catalog's own, on the Tool API's side; then item 79's, on the runtime side.
    expect(callsOf(written)).toEqual([
      onApp(GATE_CALLS.scope),
      onApp(GATE_CALLS.kindCatalog),
      onJob(GATE_CALLS.pickedKinds),
    ]);
    expect([GATE_CALLS.kindCatalog, GATE_CALLS.pickedKinds]).toEqual(["readKindCatalog", "readPickedKinds"]);
    expect(written.map((line) => line.trace_id)).toEqual([null, null, null]);
    // Each read's connect and guard are timed apart on its line, as every call's: when it started and whole milliseconds.
    for (const line of written.slice(1)) {
      for (const step of [line.connect, line.guard] as { at: unknown; ms: unknown }[]) {
        expect(step.at).toEqual(expect.stringMatching(UTC_INSTANT));
        expect(Number.isInteger(step.ms) && (step.ms as number) >= 0).toBe(true);
      }
    }
    // One after another beside the held scope: never more than the scope's connection and one read's.
    expect(db.counts()).toMatchObject({
      opened: 3,
      ended: 3,
      connectionsOpen: 0,
      connectionsPeak: 2 * CONNECTIONS_PER_CLIENT,
    });
    expect(await rowCounts()).toEqual(before);
  });

  it(
    "no slot: with every slot's scope held at once, each then reads the catalog on a client of its own and every call ends; a further scope waits for a slot meanwhile; 6 connections at most, opened equal to ended",
    { timeout: TEST_MS },
    async () => {
      const { gate, written, db } = rootOver(envOf());
      const { kinds } = signUpReadsOf(gate);
      const order: string[] = [];
      let entered = 0;
      let open: () => void = () => undefined;
      const allHeld = new Promise<void>((resolve) => {
        open = resolve;
      });

      // As many scopes as there are slots, each holding its client until all of them hold one, then reading the catalog.
      const held = Array.from({ length: GATE_CLIENTS_AT_ONCE }, () =>
        gate.scope.withBusiness(BARBERSHOP, async () => {
          entered += 1;
          if (entered === GATE_CLIENTS_AT_ONCE) open();
          await allHeld;
          const catalog = await kinds.catalog();
          order.push("catalog");
          return catalog;
        }),
      );
      // One more scope: no slot is free, so it waits until one of the others has ended.
      const waiting = gate.scope.withBusiness(BARBERSHOP, () => {
        order.push("waited");
        return Promise.resolve(entered);
      });

      const catalogs = await Promise.all(held);
      for (const catalog of catalogs) expect(catalog).toEqual(CATALOG);
      expect(await waiting).toBe(GATE_CLIENTS_AT_ONCE);
      // A catalog read answered before the waiting scope got a slot: the reads took none.
      expect(order[0]).toBe("catalog");
      expect(order.filter((each) => each === "catalog")).toHaveLength(GATE_CLIENTS_AT_ONCE);

      const sides = callsOf(written);
      expect(sides.filter(([name]) => name === GATE_CALLS.scope)).toEqual(
        Array.from({ length: GATE_CLIENTS_AT_ONCE + 1 }, () => onApp(GATE_CALLS.scope)),
      );
      expect(sides.filter(([name]) => name === GATE_CALLS.kindCatalog)).toEqual(
        Array.from({ length: GATE_CLIENTS_AT_ONCE }, () => onApp(GATE_CALLS.kindCatalog)),
      );
      const counts = db.counts();
      expect(counts).toMatchObject({
        opened: 2 * GATE_CLIENTS_AT_ONCE + 1,
        ended: 2 * GATE_CLIENTS_AT_ONCE + 1,
        connectionsOpen: 0,
      });
      // Every slot's scope was held when the first catalog client opened, so at least one more than the slots.
      expect(counts.connectionsPeak).toBeGreaterThan(GATE_CLIENTS_AT_ONCE);
      expect(counts.connectionsPeak).toBeLessThanOrEqual(WORKER_CONNECTIONS);
    },
  );

  it("a failed item 79 read (a person this database does not hold) rejects with KindsReadError as thrown, its message the read and the fault alone; the scope's client is ended, nothing is written and no line holds that row id", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const { kinds } = signUpReadsOf(gate);
    let inside: unknown;

    const thrown = await rejectionOf(
      gate.scope.withBusiness(BARBERSHOP, async () => {
        try {
          return await kinds.pickedKinds({ businessId: BARBERSHOP, personId: NOBODY });
        } catch (error) {
          inside = error;
          throw error;
        }
      }),
    );

    expect(thrown).toBeInstanceOf(KindsReadError);
    // The scope hands on what the read threw, the same error: nothing wraps it.
    expect(thrown).toBe(inside);
    expect(thrown).toMatchObject({ name: "KindsReadError", read: "readPickedKinds", fault: "notFound" });
    expect((thrown as Error).message).toBe(new KindsReadError("readPickedKinds", "notFound", null).message);
    expect((thrown as Error).message).not.toContain(NOBODY);
    // K-05's own answer rides on the error for matchKinds (never logged): the table and the row it did not find.
    expect((thrown as KindsReadError).answer).toEqual({ error: "notFound", table: "persons", rowId: NOBODY });

    expect(callsOf(written)).toEqual([onApp(GATE_CALLS.scope), onJob(GATE_CALLS.pickedKinds)]);
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    for (const line of lines) expect(line, "a line holds the row id").not.toContain(NOBODY);
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- the stop home's reads (T-1516) -------------------------------------------------------------------------------
//
// The reads S1-03's, S1-74's and S1-08's writers read the owner's contact with, as the gate binds them beside the kinds
// reads, each read by the writers' own readStop from inside a held scope, as a step writer asks it, on this file's
// database (bundle v0 and the seed's rows: no second turn is walked here).

/** The gate's stop reads, as stagingOptions gave them. */
function stopReadsOf(gate: GateReads): StopHomeReads {
  const { stop } = gate;
  if (stop === undefined) throw new Error("staging's gate binds the stop home's reads");
  return stop.reads;
}

describe("the stop home's reads, as the gate binds them for S1-03's, S1-74's and S1-08's writers (T-1516)", () => {
  it("one gate alone: inside its held scope readStop for the asked owner reads the handle, the person's handles, the phone row, the people behind the handle and their consent rows, each on a runtime-side client of its own (rosie_worker_job) named on its timing line, one after another; 2 connections at most, opened equal to ended, nothing written", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const stop = stopReadsOf(gate);
    const login = DB_SIDES.toolApi.login;

    const read = await gate.scope.withBusiness(BARBERSHOP, async (repo) => {
      const first = await whoOn(repo);
      const reading = await readStop(stop, {
        personId: ASKED.personId,
        businessId: BARBERSHOP,
        handleId: ASKED.handleId,
      });
      // The scope's own transaction answers again after every read: its client was held throughout.
      return { first, reading, last: await whoOn(repo) };
    });

    expect(read.first).toEqual({ session_login: login, current_login: login, scope: BARBERSHOP });
    expect(read.last).toEqual(read.first);
    // The asked owner's own reading as this database holds it: a phone handle that is the person's own, no phones row
    // yet (the seed writes none), and no consent row of anyone behind the handle, for any business.
    expect(read.reading).toEqual({
      personId: ASKED.personId,
      businessId: BARBERSHOP,
      handleId: ASKED.handleId,
      kind: "phone",
      own: true,
      phone: null,
      texts: [],
    });

    // The scope's client first; then each stop read's own, on the runtime side, in readStop's order.
    expect(callsOf(written)).toEqual([
      onApp(GATE_CALLS.scope),
      onJob(GATE_CALLS.stopHandle),
      onJob(GATE_CALLS.stopHandleIdsOfPerson),
      onJob(GATE_CALLS.stopPhoneOfHandle),
      onJob(GATE_CALLS.stopPersonIdsOfHandle),
      onJob(GATE_CALLS.stopConsentsOfPersons),
    ]);
    expect([
      GATE_CALLS.stopHandle,
      GATE_CALLS.stopHandleIdsOfPerson,
      GATE_CALLS.stopPhoneOfHandle,
      GATE_CALLS.stopPersonIdsOfHandle,
      GATE_CALLS.stopConsentsOfPersons,
    ]).toEqual([
      "getHandle",
      "listHandleIdsOfPerson",
      "getPhoneByHandle",
      "listPersonIdsOfHandle",
      "listConsentsOfPersons",
    ]);
    expect(written.map((line) => line.trace_id)).toEqual(Array.from({ length: 6 }, () => null));
    // One after another beside the held scope: never more than the scope's connection and one read's.
    expect(db.counts()).toMatchObject({
      opened: 6,
      ended: 6,
      connectionsOpen: 0,
      connectionsPeak: 2 * CONNECTIONS_PER_CLIENT,
    });
    expect(await rowCounts()).toEqual(before);
    // The handle's address was read (readStop keeps its kind alone); no line holds it.
    for (const line of lines) {
      for (const form of [ASKED.number, ASKED.number.slice(1), ASKED.number.slice(2)]) {
        expect(line, "a line holds the asked owner's number").not.toContain(form);
      }
    }
  });

  it("the pool's own HYPERDRIVE_JOB (its database, rosie_rig_none, never made): inside a held scope the first stop read fails with its call's name and SQLSTATE only, nothing of the binding's string in what is thrown; the scope's client is ended and nothing is written", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf({ job: POOL_JOB }));
    const stop = stopReadsOf(gate);
    let inside: unknown;

    const thrown = await rejectionOf(
      gate.scope.withBusiness(BARBERSHOP, async () => {
        try {
          return await readStop(stop, {
            personId: ASKED.personId,
            businessId: BARBERSHOP,
            handleId: ASKED.handleId,
          });
        } catch (error) {
          inside = error;
          throw error;
        }
      }),
    );

    // The scope hands on what the read threw, the same error: the handle's own refusal, as the scrub leaves it.
    expect(thrown).toBe(inside);
    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({
      call: GATE_CALLS.stopHandle,
      code: "3D000",
      table: null,
      constraint: null,
    });
    expect((thrown as Error).message).toBe(
      `${GATE_CALLS.stopHandle}: the database refused the call (SQLSTATE 3D000)`,
    );
    expect(Object.keys(thrown as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
    for (const name of [POOL_APP, POOL_JOB, APP, JOB]) expectNothingOf(poolBinding(name), textsOf(thrown));
    for (const text of textsOf(thrown)) {
      for (const id of [ASKED.personId, ASKED.handleId, ASKED.number]) expect(text).not.toContain(id);
    }
    // The scope's client was timed and ended; the stop read's client never passed its guard and was ended too.
    expect(callsOf(written)).toEqual([onApp(GATE_CALLS.scope)]);
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- the walk's chat read (T-1519) --------------------------------------------------------------------------------
//
// K-05 v1.10 item 51 as the gate binds it for S1-01's walk, read from inside a held scope as the walk asks it, on this
// file's database after turn 1 (whose commit wrote Sam's chat thread for his chat id).

/** The gate's chat read, as stagingOptions gave it. */
function chatReadOf(gate: GateReads): NonNullable<GateReads["readChatHandle"]> {
  const read = gate.readChatHandle;
  if (read === undefined) throw new Error("staging's gate binds the walk's chat read");
  return read;
}

/** A chat id no thread of this file's database holds (made up, in K-06's form). */
const NO_THREAD_CHAT = "linq-chat-demo-t1519-none";

describe("the walk's chat read, as the gate binds it for S1-01 (T-1519)", () => {
  it("after turn 1, inside one held scope: Sam's chat id answers Sam's own phone handle (the thread turn 1 wrote) and a chat id no thread holds answers none, each read on a runtime-side client of its own (rosie_worker_job) named readChatHandle on its timing line, one after another; 2 connections at most, opened equal to ended, nothing written", async () => {
    expect(turnOne).not.toBeNull();
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const read = chatReadOf(gate);
    const login = DB_SIDES.toolApi.login;

    const answers = await gate.scope.withBusiness(BARBERSHOP, async (repo) => {
      const first = await whoOn(repo);
      const sam = await read({ linqChatId: SAM_CHAT });
      const none = await read({ linqChatId: NO_THREAD_CHAT });
      // The scope's own transaction answers again after both reads: its client was held throughout.
      return { first, sam, none, last: await whoOn(repo) };
    });

    expect(answers.first).toEqual({ session_login: login, current_login: login, scope: BARBERSHOP });
    expect(answers.last).toEqual(answers.first);
    expect(answers.sam).toEqual({ handleId: SAM.handleId, handle: { kind: "phone", address: SAM.number } });
    expect(answers.none).toEqual({ handleId: null, handle: null });

    // The scope's client first; then each read's own, on the runtime side.
    expect(callsOf(written)).toEqual([
      onApp(GATE_CALLS.scope),
      onJob(GATE_CALLS.chatHandle),
      onJob(GATE_CALLS.chatHandle),
    ]);
    expect(GATE_CALLS.chatHandle).toBe("readChatHandle");
    expect(written.map((line) => line.trace_id)).toEqual([null, null, null]);
    expect(db.counts()).toMatchObject({
      opened: 3,
      ended: 3,
      connectionsOpen: 0,
      connectionsPeak: 2 * CONNECTIONS_PER_CLIENT,
    });
    expect(await rowCounts()).toEqual(before);
    // The read answered Sam's number (the turn face drops it); no line holds it, nor either chat id.
    for (const line of [...lines, ...written.map((timing) => JSON.stringify(timing))]) {
      for (const secret of [...NUMBER_FORMS, SAM_CHAT, NO_THREAD_CHAT]) {
        expect(line, "a line holds a number or a chat id").not.toContain(secret);
      }
    }
  });

  it("the pool's own HYPERDRIVE_JOB (its database, rosie_rig_none, never made): the read fails with its call's name and SQLSTATE only, nothing of the binding's string or the chat id in what is thrown; nothing is written", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf({ job: POOL_JOB }));

    const thrown = await rejectionOf(chatReadOf(gate)({ linqChatId: SAM_CHAT }));

    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({
      call: GATE_CALLS.chatHandle,
      code: "3D000",
      table: null,
      constraint: null,
    });
    expect((thrown as Error).message).toBe(
      `${GATE_CALLS.chatHandle}: the database refused the call (SQLSTATE 3D000)`,
    );
    expect(Object.keys(thrown as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
    for (const name of [POOL_APP, POOL_JOB, APP, JOB]) expectNothingOf(poolBinding(name), textsOf(thrown));
    for (const text of textsOf(thrown)) expect(text).not.toContain(SAM_CHAT);
    // The read's client never passed its guard: no timing line, and it was ended.
    expect(callsOf(written)).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- the one-kind path (T-1494) -----------------------------------------------------------------------------------
//
// The one-kind path's reads as the gate binds them beside the kinds and stop reads, each read from inside a held scope as
// T-1492's pieces ask them, in the roster-owner world the seed made for ONE_KIND; then the walk of that owner's one-kind
// "Plumbing" to its S1-02 question on bundle v2, through realGate over staging's gate reads and the root's turn-row port.

/** The gate's one-kind reads, as stagingOptions gave them. */
function oneKindReadsOf(gate: GateReads): CompaniesReads {
  const { companies } = gate;
  if (companies === undefined) throw new Error("staging's gate binds the one-kind path's reads");
  return companies;
}

/**
 * Bundle v2 as a run pinned it, from bundles/v2's own files (T-1477): its manifest and flow A, and plumber's trade overlay,
 * BundleError notInBundle for any other trade (as the pin answers one its manifest does not list), each trade asked for
 * written down. The pin itself is the actor's (../../bundle): this file's database holds bundle v0 active, so the real
 * pin would pin v0; an owner's sign-up turn pins bundle v2 once staging is deployed with it (DL-1111).
 */
function pinnedV2(): { readonly bundle: PinnedBundle; readonly asked: string[] } {
  const asked: string[] = [];
  const bundle: PinnedBundle = {
    bundleId: { ...BUNDLE_V2_ID },
    manifest: structuredClone(bundleV2Manifest) as unknown as Manifest,
    flow: (flow) =>
      flow === "A"
        ? Promise.resolve(structuredClone(bundleV2FlowA) as Readonly<Record<string, unknown>>)
        : Promise.reject(new BundleError("notInBundle")),
    trade(tradeId) {
      asked.push(tradeId);
      return tradeId === "plumber"
        ? Promise.resolve(structuredClone(plumberV2) as unknown as TradeOverlay)
        : Promise.reject(new BundleError("notInBundle"));
    },
    reads: () => [],
  };
  return { bundle, asked };
}

/** K-09 v1.5 commit-s1-02.json's request, and commit-s1-02-unmapped-end.json's turn: the same turn with its service and chat. */
const S1_02_REQUEST = (commitS102 as unknown as { readonly request: Json }).request;
const S1_02_TURN = (commitS102UnmappedEnd as unknown as { readonly request: { readonly turn: Json } }).request
  .turn;

/** A copy of `value` with each whole string that `names` holds replaced by its new name. */
function renamed<T>(value: T, names: ReadonlyMap<string, string>): T {
  const walk = (each: unknown): unknown => {
    if (typeof each === "string") return names.get(each) ?? each;
    if (Array.isArray(each)) return each.map(walk);
    if (isRecord(each))
      return Object.fromEntries(Object.entries(each).map(([key, inner]) => [key, walk(inner)]));
    return each;
  };
  return walk(value) as T;
}

/** A decided part as commit-s1-02.json writes it: choosing an option of S1-02's question, with the owner's words. */
interface ChoosingPart {
  verb: string;
  quote: string;
  choice: string | null;
  fields: { name: string; value: unknown; words: string }[];
}

/** commit-s1-02.json's request, as this file changes it. */
type OneKindRequest = Json & {
  turn: Json;
  now: string;
  input: {
    decided: {
      context: Json & {
        bundleId: unknown;
        writer: { people: unknown[] };
        texts: { words: string; sentAt: { utc: string } }[];
        openQuestions: { sentAt: { utc: string } }[];
        recentMessages: { sentAt: { utc: string } }[];
      };
      decide: Json & {
        bundleId: unknown;
        parts: { part: ChoosingPart }[];
        reads: { output: { parts: ChoosingPart[] } }[];
      };
    };
  };
};

/** The one-kind owner's text, and the moments of its turn: after S1-02's question went out (ONE_KIND.sentAt). */
const ONE_KIND_TEXT = {
  eventId: "evt-t1494-plumbing",
  sentAt: "2026-10-19T18:07:00Z",
  now: "2026-10-19T18:07:06Z",
};

/** A roster owner of the seed's whose S1-02 question is live (ONE_KIND, MULTI_KIND): its ids, number, chat and question. */
interface RosterAsked {
  readonly businessId: string;
  readonly companyId: string;
  readonly personId: string;
  readonly handleId: string;
  readonly number: string;
  readonly chatId: string;
  readonly questionId: string;
  readonly sentAt: string;
}

/** One text of an owner's turn: its event id, when it was sent, and the turn's moment. */
interface OwnerText {
  readonly eventId: string;
  readonly sentAt: string;
  readonly now: string;
}

/** A trace of its own under bundle v2, set to the turn, its spans kept. */
function tracedOnV2(turnId: string): TraceContext {
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: { ...BUNDLE_V2_ID },
    sink: (span) => SPANS.push(span),
  });
  trace.setTurn(turnId);
  return trace;
}

/** The one-kind owner's answer to its S1-02 question (s1_02Gate). */
const oneKindGate = (words: string): Promise<GateCall> => s1_02Gate(ONE_KIND, ONE_KIND_TEXT, words);

/**
 * A roster owner's answer to its S1-02 question: commit-s1-02.json's request (as the turn face's one-kind proof sends
 * it: T-1493's pg/one-kind.int.test.ts) under the turn id the lease hashes from its one event id, on a trace of its own,
 * the turn, its context and decide's result pinned to bundle v2; every id of Sam's swapped for the owner's, the question
 * the seed's; its one part choosing "All on the list" (c-01) in decide's agreed parts and both reads, with `words` as the
 * text, the part's quote and its kinds field; its writer the owner as the frontier names a person with no name and no
 * role; and the moments after the question went out.
 */
async function s1_02Gate(owner: RosterAsked, said: OwnerText, words: string): Promise<GateCall> {
  const turnId = await turnIdOf([said.eventId]);
  const trace = tracedOnV2(turnId);
  const names = new Map<string, string>([
    [BARBERSHOP, owner.businessId],
    [SAM.personId, owner.personId],
    [SAM.handleId, owner.handleId],
    [SAM.number, owner.number],
    [SAM_CHAT, owner.chatId],
    ["turn-s1-02-sam-kinds", turnId],
    ["trace-sam-0001", trace.traceId],
    ["evt-sam-0001", said.eventId],
    ["oq-s1-02", owner.questionId],
  ]);
  const request = renamed(
    { ...structuredClone(S1_02_REQUEST), turn: structuredClone(S1_02_TURN) },
    names,
  ) as OneKindRequest;
  const { context, decide } = request.input.decided;
  const choose = (part: ChoosingPart): void => {
    part.choice = "c-01";
    part.quote = words;
    for (const field of part.fields) {
      if (field.name !== "kinds") continue;
      field.value = words;
      field.words = words;
    }
  };
  for (const entry of decide.parts) choose(entry.part);
  for (const read of decide.reads) for (const part of read.output.parts) choose(part);
  const [text] = context.texts;
  if (text === undefined) throw new Error("commit-s1-02.json's context holds the owner's text");
  text.words = words;
  text.sentAt.utc = said.sentAt;
  for (const question of context.openQuestions) question.sentAt.utc = owner.sentAt;
  for (const message of context.recentMessages) message.sentAt.utc = owner.sentAt;
  request.turn.bundleId = { ...BUNDLE_V2_ID };
  context.bundleId = { ...BUNDLE_V2_ID };
  decide.bundleId = { ...BUNDLE_V2_ID };
  context.writer.people = [{ personId: owner.personId, name: "", roles: [], language: null }];
  request.now = said.now;
  return { request, turnId, trace };
}

/** Rows as plain objects (postgres.js's result lists carry fields of their own). */
const plainRows = (rows: readonly Json[]): Json[] => rows.map((row) => ({ ...row }));

/** What the one-kind owner's turn `turnId` left, as the runtime side reads it with no scope. */
function oneKindRows(turnId: string): Promise<Json> {
  return own.runtime("oneKindRows", async (sql) => ({
    answered: plainRows(
      await sql<Json[]>`select status, step from open_questions where id = ${ONE_KIND.questionId}`,
    ),
    questions: plainRows(
      await sql<Json[]>`
      select id, step, status, business_id, person_id from open_questions where turn_id = ${turnId}
      order by id collate "C"
    `,
    ),
    outbox: plainRows(
      await sql<Json[]>`
      select id, step, line_no, open_question_id, send_class, recipient_handle_id, business_id, plan from outbox_rows
      where turn_id = ${turnId} order by id collate "C"
    `,
    ),
    picks: plainRows(
      await sql<Json[]>`
      select id, kind_id, outcome, company_id, business_id from picked_kinds
      where owner_person_id = ${ONE_KIND.personId} order by id collate "C"
    `,
    ),
    companyKinds: plainRows(
      await sql<Json[]>`
      select kind_id, business_id, pf_facts, pf_switches_a, pf_switches_b from company_kinds
      where company_id = ${ONE_KIND.companyId} order by kind_id collate "C"
    `,
    ),
    texts: plainRows(
      await sql<Json[]>`
      select t.business_id, count(*)::int as n from picked_kind_texts t
      join picked_kinds p on p.id = t.picked_kind_id
      where p.owner_person_id = ${ONE_KIND.personId} group by t.business_id
    `,
    ),
  }));
}

describe("the one-kind path's reads, and a one-kind answer walked past S1-04 to S1-08's row and S1-09's question on staging's gate (T-1494)", () => {
  it("one gate alone: inside its held scope item 79 is read on a runtime-side client (rosie_worker_job), item 72 on a second Tool API client (rosie_worker_app) and the catalog by id on a runtime-side client, each named on its timing line, one after another; 2 connections at most, opened equal to ended, nothing written", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const reads = oneKindReadsOf(gate);
    const login = DB_SIDES.toolApi.login;
    const { businessId, personId, handleId } = ONE_KIND;

    const read = await gate.scope.withBusiness(businessId, async (repo) => {
      const first = await whoOn(repo);
      const picked = await reads.pickedKinds({ businessId, personId });
      const kinds = await reads.businessKinds(repo, { businessId });
      const plumber = await reads.kindDefaults(repo, { handleId, businessId, kindId: "plumber" });
      // The scope's own transaction answers again after every read: its client was held throughout.
      return { first, picked, kinds, plumber, last: await whoOn(repo) };
    });

    expect(read.first).toEqual({ session_login: login, current_login: login, scope: businessId });
    expect(read.last).toEqual(read.first);
    // Item 79: no pick yet, and the owner's company at its business as the roster-owner set wrote it.
    expect(read.picked).toMatchObject({ result: "pickedKinds", businessId, personId, picks: [] });
    expect(read.picked.companies).toEqual([
      expect.objectContaining({ id: ONE_KIND.companyId, businessId, ownerPersonId: personId }),
    ]);
    // Item 72: the company's one kind of work on file, barber, under the business.
    expect(read.kinds.kinds.map((kind) => [kind.companyId, kind.kindId, kind.businessId])).toEqual([
      [ONE_KIND.companyId, "barber", businessId],
    ]);
    // The catalog by id: plumber's facts and its switches in flows A and B, as this database holds them.
    expect(read.plumber).toEqual(seededKindDefaults("plumber"));

    // The scope's client first; then item 79's and the catalog's on the runtime side, item 72's on the Tool API's.
    expect(callsOf(written)).toEqual([
      onApp(GATE_CALLS.scope),
      onJob(GATE_CALLS.pickedKinds),
      onApp(GATE_CALLS.businessKinds),
      onJob(GATE_CALLS.kindsById),
    ]);
    expect([GATE_CALLS.businessKinds, GATE_CALLS.kindsById]).toEqual(["readBusinessKinds", "readTurnState"]);
    expect(written.map((line) => line.trace_id)).toEqual([null, null, null, null]);
    // One after another beside the held scope: never more than the scope's connection and one read's.
    expect(db.counts()).toMatchObject({
      opened: 4,
      ended: 4,
      connectionsOpen: 0,
      connectionsPeak: 2 * CONNECTIONS_PER_CLIENT,
    });
    expect(await rowCounts()).toEqual(before);
  });

  it("a failed item 79 read (a person this database does not hold) rejects with CompaniesReadError as thrown, its message the read and the fault alone; the scope's client is ended, nothing is written and no line holds that row id", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const reads = oneKindReadsOf(gate);

    const thrown = await rejectionOf(
      gate.scope.withBusiness(ONE_KIND.businessId, () =>
        reads.pickedKinds({ businessId: ONE_KIND.businessId, personId: NOBODY }),
      ),
    );

    expect(thrown).toBeInstanceOf(CompaniesReadError);
    expect(thrown).toMatchObject({ name: "CompaniesReadError", read: "readPickedKinds", fault: "notFound" });
    expect((thrown as Error).message).toBe(
      new CompaniesReadError("readPickedKinds", "notFound", null).message,
    );
    expect((thrown as Error).message).not.toContain(NOBODY);
    // K-05's own answer rides on the error (never logged): the table and the row it did not find.
    expect((thrown as CompaniesReadError).answer).toEqual({
      error: "notFound",
      table: "persons",
      rowId: NOBODY,
    });

    expect(callsOf(written)).toEqual([onApp(GATE_CALLS.scope), onJob(GATE_CALLS.pickedKinds)]);
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
    for (const line of lines) expect(line, "a line holds the row id").not.toContain(NOBODY);
    expect(await rowCounts()).toEqual(before);
  });

  it(
    "the walk: the roster owner's 'Plumbing' on bundle v2, through realGate over staging's gate reads, commits once: S1-02's question answered, the one pick placed under the owner's company and business with plumber's company kind, its 11 blocks under that business, S1-08's row, S1-09's question and its row, no S1-04 question or row; every call one after another, 2 connections at most",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const testEnv = envOf();
      const rooted = rootOver(testEnv);
      // Staging's gate reads with no adapter: the text's record is No, whose line is none, so no word is asked and no
      // check reads bundle v2 (its values are not in this database: the pinned bundle is the test's, above).
      const reads = stagingGateReads({
        env: testEnv.env,
        db: rooted.db,
        keys: sealingWrapKeys(testEnv.env),
        bundleSafety: null,
      });
      if (reads === null) throw new Error("the gate is bound with both bindings");
      const call = await oneKindGate("Plumbing");
      const pinned = pinnedV2();
      const key = call.turnId;

      const answer = await pinnedGate({ root: rooted.root, reads }, call, pinned.bundle);

      expect(answer, JSON.stringify(answer)).toMatchObject({
        result: "committed",
        turnId: key,
        repeated: false,
        openQuestions: { opened: [`oq-s1-09-${key}-1`], closed: [ONE_KIND.questionId] },
      });
      // S1-11 read plumber's overlay once, from the pinned bundle.
      expect(pinned.asked).toEqual(["plumber"]);

      const plumber = seededKindDefaults("plumber");
      expect(await oneKindRows(key)).toEqual({
        answered: [{ status: "answered", step: "S1-02" }],
        // S1-09's question alone: no S1-04 question.
        questions: [
          {
            id: `oq-s1-09-${key}-1`,
            step: "S1-09",
            status: "waiting",
            business_id: ONE_KIND.businessId,
            person_id: ONE_KIND.personId,
          },
        ],
        // S1-08's row (its step and line, no question), then S1-09's: no S1-04 row; each planned after the commit.
        outbox: [
          {
            id: `outbox-s1-08-${key}-1`,
            step: "S1-08",
            line_no: 0,
            open_question_id: null,
            send_class: "quick_reply",
            recipient_handle_id: ONE_KIND.handleId,
            business_id: ONE_KIND.businessId,
            plan: null,
          },
          {
            id: `outbox-s1-09-${key}-1`,
            step: "S1-09",
            line_no: 0,
            open_question_id: `oq-s1-09-${key}-1`,
            send_class: "quick_reply",
            recipient_handle_id: ONE_KIND.handleId,
            business_id: ONE_KIND.businessId,
            plan: null,
          },
        ],
        // The one listed pick, placed on its own insert under the owner's company and business.
        picks: [
          {
            id: `pick-s1-02-${key}-1`,
            kind_id: "plumber",
            outcome: "listed",
            company_id: ONE_KIND.companyId,
            business_id: ONE_KIND.businessId,
          },
        ],
        // Plumber's company kind beside the barber one the roster-owner set wrote, with the catalog's facts and switches.
        companyKinds: [
          expect.objectContaining({ kind_id: "barber", business_id: ONE_KIND.businessId }),
          {
            kind_id: "plumber",
            business_id: ONE_KIND.businessId,
            pf_facts: plumber.facts,
            pf_switches_a: plumber.switchesA,
            pf_switches_b: plumber.switchesB,
          },
        ],
        // S1-11's 11 text blocks, every one under the business.
        texts: [{ business_id: ONE_KIND.businessId, n: 11 }],
      });

      // Every call on its own client and side, one after another, the scope's held throughout.
      expect(callsOf(rooted.written)).toEqual([
        onApp(GATE_CALLS.scope),
        onJob(GATE_CALLS.seal),
        onApp(GATE_CALLS.kindCatalog),
        onJob(GATE_CALLS.pickedKinds),
        onJob(GATE_CALLS.pickedKinds),
        onApp(GATE_CALLS.businessKinds),
        onJob(GATE_CALLS.kindsById),
        onJob(GATE_CALLS.stopHandle),
        onJob(GATE_CALLS.stopHandleIdsOfPerson),
        onJob(GATE_CALLS.stopPhoneOfHandle),
        onJob(GATE_CALLS.stopPersonIdsOfHandle),
        onJob(GATE_CALLS.stopConsentsOfPersons),
        onJob("commitTurn"),
      ]);
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ connectionsOpen: 0, connectionsPeak: 2 * CONNECTIONS_PER_CLIENT });
      expect(counts.ended).toBe(counts.opened);
      // The turn row, S1-09's question and its clock row, the two outbox rows and the text's record.
      await expectCountsAfter(
        before,
        { turns: 1, open_questions: 1, clock_rows: 1, outbox_rows: 2, safety_outcomes: 1 },
        "grows",
      );
    },
  );
});

// ---- S1-04's writer (T-1485) --------------------------------------------------------------------------------------
//
// An answer to an S1-04 that was asked, on staging's gate with S1-04's writer bound (the party rule's flag off), in the
// roster-owner world: the seed's second roster owner (MULTI_KIND) answers its S1-02 question with three kinds on bundle
// v2, so S1-04 is asked; its row's send is played (one delivered part, then K-05's own armClock at the receipt, on the
// runtime side), so the question is open; then Sam's own two-company answer is refused, and "They all share one company"
// commits, each through realGate over staging's gate reads and the root's turn-row port.

/** Bundle v2 as a run pinned it (as pinnedV2 above), holding barber's, plumber's and electrician's overlays. */
function pinnedV2Kinds(): { readonly bundle: PinnedBundle; readonly asked: string[] } {
  const asked: string[] = [];
  const overlays = new Map<string, unknown>([
    ["barber", barberV2],
    ["plumber", plumberV2],
    ["electrician", electricianV2],
  ]);
  const bundle: PinnedBundle = {
    bundleId: { ...BUNDLE_V2_ID },
    manifest: structuredClone(bundleV2Manifest) as unknown as Manifest,
    flow: (flow) =>
      flow === "A"
        ? Promise.resolve(structuredClone(bundleV2FlowA) as Readonly<Record<string, unknown>>)
        : Promise.reject(new BundleError("notInBundle")),
    trade(tradeId) {
      asked.push(tradeId);
      const overlay = overlays.get(tradeId);
      return overlay === undefined
        ? Promise.reject(new BundleError("notInBundle"))
        : Promise.resolve(structuredClone(overlay) as TradeOverlay);
    },
    reads: () => [],
  };
  return { bundle, asked };
}

/** The multi-kind owner's texts and the moments of its turns, each after the question it answers went out. */
const MULTI_KIND_TEXTS = {
  kinds: { eventId: "evt-t1485-kinds", sentAt: "2026-10-19T18:07:00Z", now: "2026-10-19T18:07:06Z" },
  twoCompanies: {
    eventId: "evt-t1485-two-companies",
    sentAt: "2026-10-19T18:09:00Z",
    now: "2026-10-19T18:09:06Z",
  },
  allShareOne: {
    eventId: "evt-t1485-all-share-one",
    sentAt: "2026-10-19T18:11:00Z",
    now: "2026-10-19T18:11:06Z",
  },
} as const;

/** S1-04's row's send, played: sent, delivered, and the clock's due time at the receipt (a day on). */
const S1_04_SEND = {
  sentAt: "2026-10-19T18:07:08Z",
  deliveredAt: "2026-10-19T18:07:09Z",
  dueAt: "2026-10-20T18:07:09Z",
} as const;

/** The owner's three kinds (commit-s1-02.json's words), and the two answers to S1-04 (K-09's two S1-04 fixtures). */
const THREE_KINDS = "Barbershop, plumbing, electrical";
const ALL_SHARE_ONE_WORDS = "They all share one company";
const TWO_COMPANIES_WORDS = "Plumbing and electrical share Lee Home Services";

/** K-09 v1.11's two S1-04 commit fixtures: the roster owner's "All share one" (c-02) and Sam's "Some share one" (c-01). */
const S1_04_FIXTURES = {
  allShareOne: {
    request: (commitS104 as unknown as { readonly request: Json }).request,
    words: ALL_SHARE_ONE_WORDS,
    names: {
      business: "biz-roster-owner-1",
      person: "person-roster-owner-1",
      handle: "handle-roster-owner-1",
      number: "+15555550150",
      chat: "linq-chat-demo-roster",
      turn: "turn-s1-04-roster",
      trace: "trace-roster-0002",
      event: "evt-roster-0002",
      question: "oq-s1-04-roster-1",
    },
  },
  twoCompanies: {
    request: (commitS104SomeShare as unknown as { readonly request: Json }).request,
    words: TWO_COMPANIES_WORDS,
    names: {
      business: BARBERSHOP,
      person: SAM.personId,
      handle: SAM.handleId,
      number: SAM.number,
      chat: SAM_CHAT,
      turn: "turn-s1-04-sam",
      trace: "trace-sam-0002",
      event: "evt-sam-0002",
      question: "oq-s1-04-sam",
    },
  },
} as const;

/** An S1-04 commit fixture's request, as this file changes it. */
type S1_04Request = Json & {
  turn: Json;
  now: string;
  input: {
    decided: {
      context: Json & {
        bundleId: unknown;
        writer: { people: unknown[] };
        texts: { words: string; sentAt: { utc: string } }[];
        openQuestions: { sentAt: { utc: string } }[];
        recentMessages: { sentAt: { utc: string } }[];
      };
      decide: Json & { bundleId: unknown };
    };
  };
};

/** S1-04's question and row the multi-kind owner's S1-02 answer opens (K-09 v1.5 default 131: from its turn's id). */
async function multiKindS1_04(): Promise<{
  readonly questionId: string;
  readonly rowId: string;
  readonly turnId: string;
}> {
  const turnId = await turnIdOf([MULTI_KIND_TEXTS.kinds.eventId]);
  return { questionId: `oq-s1-04-${turnId}-1`, rowId: `outbox-s1-04-${turnId}-1`, turnId };
}

/**
 * The multi-kind owner's answer to the S1-04 question its S1-02 answer opened: the fixture's request (its own words and
 * choice, as K-09 accepted it) under the turn id the lease hashes from `said`'s one event id, on a trace of its own, the
 * turn, its context and decide's result pinned to bundle v2; every id of the fixture's owner swapped for this owner's, its
 * question S1-04's; its writer the owner as the frontier names a person with no name and no role; and the moments after
 * S1-04's question went out.
 */
async function s1_04Gate(which: keyof typeof S1_04_FIXTURES, said: OwnerText): Promise<GateCall> {
  const { request: base, words, names } = S1_04_FIXTURES[which];
  const turnId = await turnIdOf([said.eventId]);
  const trace = tracedOnV2(turnId);
  const s1_04 = await multiKindS1_04();
  const request = renamed(
    structuredClone(base),
    new Map<string, string>([
      [names.business, MULTI_KIND.businessId],
      [names.person, MULTI_KIND.personId],
      [names.handle, MULTI_KIND.handleId],
      [names.number, MULTI_KIND.number],
      [names.chat, MULTI_KIND.chatId],
      [names.turn, turnId],
      [names.trace, trace.traceId],
      [names.event, said.eventId],
      [names.question, s1_04.questionId],
    ]),
  ) as S1_04Request;
  const { context, decide } = request.input.decided;
  const [text] = context.texts;
  if (text?.words !== words) throw new Error(`the ${which} fixture's context holds the owner's text`);
  text.sentAt.utc = said.sentAt;
  for (const question of context.openQuestions) question.sentAt.utc = S1_04_SEND.sentAt;
  for (const message of context.recentMessages) message.sentAt.utc = S1_04_SEND.sentAt;
  request.turn.bundleId = { ...BUNDLE_V2_ID };
  context.bundleId = { ...BUNDLE_V2_ID };
  decide.bundleId = { ...BUNDLE_V2_ID };
  context.writer.people = [{ personId: MULTI_KIND.personId, name: "", roles: [], language: null }];
  request.now = said.now;
  return { request, turnId, trace };
}

/** Staging's gate reads over a root of the test's own, with no adapter (as the T-1494 walk builds them), and that root. */
function stagingGateOver(testEnv: TestEnv): { readonly rooted: Rooted; readonly reads: GateReads } {
  const rooted = rootOver(testEnv);
  const reads = stagingGateReads({
    env: testEnv.env,
    db: rooted.db,
    keys: sealingWrapKeys(testEnv.env),
    bundleSafety: null,
  });
  if (reads === null) throw new Error("the gate is bound with both bindings");
  return { rooted, reads };
}

/** What the multi-kind owner's picks, company kinds and S1-04 question hold, as the runtime side reads them. */
function multiKindRows(questionId: string): Promise<Json> {
  return own.runtime("multiKindRows", async (sql) => ({
    question: plainRows(
      await sql<Json[]>`select step, status, version from open_questions where id = ${questionId}`,
    ),
    picks: plainRows(
      await sql<Json[]>`
      select id, kind_id, outcome, company_id, business_id from picked_kinds
      where owner_person_id = ${MULTI_KIND.personId} order by id collate "C"
    `,
    ),
    companies: plainRows(
      await sql<Json[]>`
      select id, business_id from companies where owner_person_id = ${MULTI_KIND.personId} order by id collate "C"
    `,
    ),
    companyKinds: plainRows(
      await sql<Json[]>`
      select kind_id, business_id from company_kinds where company_id = ${MULTI_KIND.companyId}
      order by kind_id collate "C"
    `,
    ),
    texts: plainRows(
      await sql<Json[]>`
      select t.business_id, count(*)::int as n from picked_kind_texts t
      join picked_kinds p on p.id = t.picked_kind_id
      where p.owner_person_id = ${MULTI_KIND.personId} group by t.business_id
    `,
    ),
  }));
}

describe("an answer to an S1-04 that was asked, on staging's gate with S1-04's writer bound and the party rule's flag off (T-1485)", () => {
  it(
    "the multi-kind owner's 'Barbershop, plumbing, electrical' on bundle v2 asks S1-04 (three picks, none placed); its row's send is played, so the question is open at version 2",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const { rooted, reads } = stagingGateOver(envOf());
      const call = await s1_02Gate(MULTI_KIND, MULTI_KIND_TEXTS.kinds, THREE_KINDS);
      const pinned = pinnedV2Kinds();
      const s1_04 = await multiKindS1_04();
      expect(call.turnId).toBe(s1_04.turnId);

      const answer = await pinnedGate({ root: rooted.root, reads }, call, pinned.bundle);

      expect(answer, JSON.stringify(answer)).toMatchObject({
        result: "committed",
        turnId: call.turnId,
        repeated: false,
        openQuestions: { opened: [s1_04.questionId], closed: [MULTI_KIND.questionId] },
      });
      // S1-11 read the first kind's overlay once, barber's, from the pinned bundle.
      expect(pinned.asked).toEqual(["barber"]);
      expect(await multiKindRows(s1_04.questionId)).toEqual({
        question: [{ step: "S1-04", status: "waiting", version: 1 }],
        picks: ["barber", "plumber", "electrician"].map((kindId, index) => ({
          id: `pick-s1-02-${call.turnId}-${String(index + 1)}`,
          kind_id: kindId,
          outcome: "listed",
          company_id: null,
          business_id: null,
        })),
        companies: [{ id: MULTI_KIND.companyId, business_id: MULTI_KIND.businessId }],
        companyKinds: [{ kind_id: "barber", business_id: MULTI_KIND.businessId }],
        texts: [{ business_id: null, n: 11 }],
      });
      await expectCountsAfter(
        before,
        { turns: 1, open_questions: 1, clock_rows: 1, outbox_rows: 1, safety_outcomes: 1 },
        "grows",
      );

      // S1-04's row's send, played on the runtime side: one delivered part, the row delivered, then K-05's own armClock.
      await own.runtime("deliverS1_04", async (sql) => {
        await sql`
          insert into outbox_parts (
            outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, linq_message_id, state, sent_at, delivered_at
          ) values (
            ${s1_04.rowId}, 1, 1, ${`${s1_04.rowId}/1/1`}, 1, 'words', ${`linq-msg-${s1_04.rowId}`}, 'delivered',
            ${S1_04_SEND.sentAt}, ${S1_04_SEND.deliveredAt}
          )
        `;
        await sql`update outbox_rows set state = 'delivered', version = version + 1 where id = ${s1_04.rowId}`;
      });
      const armed = await own.runtime("armClock", (sql) =>
        armClock(sql, {
          openQuestionId: s1_04.questionId,
          deliveredAt: S1_04_SEND.deliveredAt,
          dueAt: S1_04_SEND.dueAt,
          dueZone: "America/New_York",
        }),
      );
      expect(armed).toMatchObject({ result: "armed", repeated: false });
      expect((await multiKindRows(s1_04.questionId)).question).toEqual([
        { step: "S1-04", status: "open", version: 2 },
      ]);
    },
  );

  it(
    "Sam's own two-company answer ('Plumbing and electrical share Lee Home Services') with the flag off fails closed inside the Tool API base: realGate rejects with CompaniesRefusedError secondCompany (labels only), never a K-09 answer, sent once and never retried by the gate; nothing written, the question still open at version 2, no line holding the owner's words or number",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const s1_04 = await multiKindS1_04();
      const rowsBefore = await multiKindRows(s1_04.questionId);
      const { rooted, reads } = stagingGateOver(envOf());
      const call = await s1_04Gate("twoCompanies", MULTI_KIND_TEXTS.twoCompanies);
      const pinned = pinnedV2Kinds();
      const commits: unknown[] = [];

      const thrown = await rejectionOf(
        realGate({
          reads,
          commitTurn: (request) => {
            commits.push(request);
            return rooted.root.ports.turnRow.commitTurn(request);
          },
          bundles: () => rooted.root.ports.bundles,
          pinnedOf: (trace) => (trace === call.trace ? pinned.bundle : null),
        }).gateAndCommit(call.request as never, NOTHING_OPEN, call.trace),
      );

      // What the base hands back: the writer's refusal, thrown as it came (the base answers no K-09 error for it).
      expect(thrown).toBeInstanceOf(CompaniesRefusedError);
      expect(thrown).toMatchObject({ name: "CompaniesRefusedError", fault: "secondCompany", ids: ["S1-04"] });
      expect((thrown as Error).message).toBe(new CompaniesRefusedError("secondCompany", ["S1-04"]).message);
      expect(Object.keys(thrown as Error).sort()).toEqual(["fault", "ids", "name"]);
      for (const text of textsOf(thrown)) {
        for (const secret of [
          TWO_COMPANIES_WORDS,
          "Lee Home Services",
          "Plumbing and electrical",
          MULTI_KIND.number,
          MULTI_KIND.number.slice(1),
          MULTI_KIND.personId,
          MULTI_KIND.handleId,
          MULTI_KIND.chatId,
        ]) {
          expect(text, "the refusal holds the owner's words or an id").not.toContain(secret);
        }
      }
      // Sent once, never again by the gate: one scope, its seal, S1-04's writer's item 79 and the kinds' names by id
      // (item 26, for "Some share one"'s words), refused once the groups are known: no item 72, no S1-08, no commit.
      expect(commits).toEqual([]);
      expect(callsOf(rooted.written)).toEqual([
        onApp(GATE_CALLS.scope),
        onJob(GATE_CALLS.seal),
        onJob(GATE_CALLS.pickedKinds),
        onJob(GATE_CALLS.kindsById),
      ]);
      expect(pinned.asked).toEqual([]);
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ connectionsOpen: 0, connectionsPeak: 2 * CONNECTIONS_PER_CLIENT });
      expect(counts.ended).toBe(counts.opened);
      // Nothing written: the counts, the picks, the company kinds and the question as they were.
      expect(await rowCounts()).toEqual(before);
      expect(await multiKindRows(s1_04.questionId)).toEqual(rowsBefore);
      expect(rowsBefore.question).toEqual([{ step: "S1-04", status: "open", version: 2 }]);
      // Labels only: no line of the test's holds the owner's words or number.
      for (const line of lines) {
        for (const secret of [TWO_COMPANIES_WORDS, "Lee Home Services", MULTI_KIND.number]) {
          expect(line, "a line holds the owner's words or number").not.toContain(secret);
        }
      }
    },
  );

  it(
    "'They all share one company' on bundle v2, through realGate over staging's gate reads, commits once: S1-04's question closed at its version, the three picks placed under the owner's company and business, plumber's and electrician's company kinds beside barber's, the barbershop's 11 blocks given the business, S1-08's row, S1-09's question and its row; every call one after another, 2 connections at most",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const s1_04 = await multiKindS1_04();
      const { rooted, reads } = stagingGateOver(envOf());
      const call = await s1_04Gate("allShareOne", MULTI_KIND_TEXTS.allShareOne);
      const pinned = pinnedV2Kinds();
      const key = call.turnId;

      const answer = await pinnedGate({ root: rooted.root, reads }, call, pinned.bundle);

      expect(answer, JSON.stringify(answer)).toMatchObject({
        result: "committed",
        turnId: key,
        repeated: false,
        openQuestions: { opened: [`oq-s1-09-${key}-1`], closed: [s1_04.questionId] },
      });
      // No trade overlay is read: S1-11 is not walked again.
      expect(pinned.asked).toEqual([]);
      expect(await multiKindRows(s1_04.questionId)).toEqual({
        question: [{ step: "S1-04", status: "answered", version: 3 }],
        picks: ["barber", "plumber", "electrician"].map((kindId, index) => ({
          id: `pick-s1-02-${s1_04.turnId}-${String(index + 1)}`,
          kind_id: kindId,
          outcome: "listed",
          company_id: MULTI_KIND.companyId,
          business_id: MULTI_KIND.businessId,
        })),
        // The turn's own company alone: no second company.
        companies: [{ id: MULTI_KIND.companyId, business_id: MULTI_KIND.businessId }],
        companyKinds: ["barber", "electrician", "plumber"].map((kindId) => ({
          kind_id: kindId,
          business_id: MULTI_KIND.businessId,
        })),
        texts: [{ business_id: MULTI_KIND.businessId, n: 11 }],
      });
      const rows = await own.runtime("multiKindTurn", async (sql) => ({
        questions: plainRows(
          await sql<Json[]>`
          select id, step, status, business_id, person_id from open_questions where turn_id = ${key}
          order by id collate "C"
        `,
        ),
        outbox: plainRows(
          await sql<Json[]>`
          select id, step, line_no, open_question_id, send_class, recipient_handle_id, business_id, plan from outbox_rows
          where turn_id = ${key} order by id collate "C"
        `,
        ),
      }));
      expect(rows).toEqual({
        questions: [
          {
            id: `oq-s1-09-${key}-1`,
            step: "S1-09",
            status: "waiting",
            business_id: MULTI_KIND.businessId,
            person_id: MULTI_KIND.personId,
          },
        ],
        outbox: [
          {
            id: `outbox-s1-08-${key}-1`,
            step: "S1-08",
            line_no: 0,
            open_question_id: null,
            send_class: "quick_reply",
            recipient_handle_id: MULTI_KIND.handleId,
            business_id: MULTI_KIND.businessId,
            plan: null,
          },
          {
            id: `outbox-s1-09-${key}-1`,
            step: "S1-09",
            line_no: 0,
            open_question_id: `oq-s1-09-${key}-1`,
            send_class: "quick_reply",
            recipient_handle_id: MULTI_KIND.handleId,
            business_id: MULTI_KIND.businessId,
            plan: null,
          },
        ],
      });

      // Every call on its own client and side, one after another, the scope's held throughout: the seal; S1-04's
      // writer's item 79, item 72 and the catalog by id for each company kind it writes; S1-08's stop reads; the commit.
      expect(callsOf(rooted.written)).toEqual([
        onApp(GATE_CALLS.scope),
        onJob(GATE_CALLS.seal),
        onJob(GATE_CALLS.pickedKinds),
        onApp(GATE_CALLS.businessKinds),
        onJob(GATE_CALLS.kindsById),
        onJob(GATE_CALLS.kindsById),
        onJob(GATE_CALLS.stopHandle),
        onJob(GATE_CALLS.stopHandleIdsOfPerson),
        onJob(GATE_CALLS.stopPhoneOfHandle),
        onJob(GATE_CALLS.stopPersonIdsOfHandle),
        onJob(GATE_CALLS.stopConsentsOfPersons),
        onJob("commitTurn"),
      ]);
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ connectionsOpen: 0, connectionsPeak: 2 * CONNECTIONS_PER_CLIENT });
      expect(counts.ended).toBe(counts.opened);
      // The turn row, S1-09's question and its clock row, the two outbox rows and the text's record.
      await expectCountsAfter(
        before,
        { turns: 1, open_questions: 1, clock_rows: 1, outbox_rows: 2, safety_outcomes: 1 },
        "grows",
      );
    },
  );
});

// ---- S1-09, S1-76 and S1-10 (T-1540) --------------------------------------------------------------------------------
//
// An owner's answer to S1-09 on staging's gate, with staging's listing ports bound (T-1540; DL-1179), in the roster-owner
// world: the seed's third roster owner answers its live S1-09 question with the demo listing, its fourth with a made-up
// name and town, each on bundle v3 through realGate over staging's gate reads, the root's turn-row port, one HeldLinks
// (the root's, as realPorts makes it for staging's shape) and the gate's clock. Then the listing paging reader's three
// reads, inside a held scope, under the turn's business alone.

/** Bundle v3 as a run pinned it, from bundles/v3's own files (T-1526): its manifest and flow A; no trade is read here. */
function pinnedV3(): { readonly bundle: PinnedBundle; readonly asked: string[] } {
  const asked: string[] = [];
  const bundle: PinnedBundle = {
    bundleId: { ...BUNDLE_V3_ID },
    manifest: structuredClone(bundleV3Manifest) as unknown as Manifest,
    flow: (flow) =>
      flow === "A"
        ? Promise.resolve(structuredClone(bundleV3FlowA) as Readonly<Record<string, unknown>>)
        : Promise.reject(new BundleError("notInBundle")),
    trade(tradeId) {
      asked.push(tradeId);
      return Promise.reject(new BundleError("notInBundle"));
    },
    reads: () => [],
  };
  return { bundle, asked };
}

/** S1-09 as bundle v3 compiles it: its question's line (say[0]) and its card's Means lines, in the card's order. */
const S1_09_V3 = ((): {
  readonly say: readonly { readonly text: string }[];
  readonly card: { readonly means: readonly { readonly branch: string; readonly text: string }[] };
} => {
  const { steps } = bundleV3FlowA as unknown as {
    readonly steps: Partial<
      Record<
        string,
        {
          readonly say: readonly { readonly text: string }[];
          readonly card: { readonly means: readonly { readonly branch: string; readonly text: string }[] };
        }
      >
    >;
  };
  const step = steps["S1-09"];
  if (step === undefined) throw new Error("bundle v3's flow A holds S1-09");
  return step;
})();

/** An S1-09 owner of the seed's (LISTING_OWNER, MADE_UP_OWNER): its ids, number, chat and live S1-09 question. */
type S1_09Owner = typeof LISTING_OWNER | typeof MADE_UP_OWNER;

/** The S1-09 owners' texts and the moments of their turns: after S1-09's question went out (the seed's sentAt). */
const S1_09_TEXTS = {
  listing: { eventId: "evt-t1540-listing", sentAt: "2026-10-19T18:09:00Z", now: "2026-10-19T18:09:06Z" },
  madeUp: { eventId: "evt-t1540-made-up", sentAt: "2026-10-19T18:09:00Z", now: "2026-10-19T18:09:06Z" },
} as const;

/** The gate's clock on those turns (GateInputs.now): S1-10's link is issued at its second and lapses 7 days on. */
const S1_09_GATE_NOW = Date.parse("2026-10-19T18:09:06Z");

/** The owners' words: the ruling's demo listing (K-09 README default 208), and a made-up name and town no listing holds. */
const DEMO_LISTING_WORDS = "Lee's Barbershop in Springfield, I'm the owner";
const MADE_UP_LISTING_WORDS = "Maple Corner Cuts, Riverton";

/** S1-09's branch an owner's claim names (bundle v3's label, word for word): the frontier's first option, c-01. */
const OWNER_MATCHES = "An owner; the listing matches";

/** commit-s1-04.json's request, as this file changes it into an answer to S1-09. */
type S1_09Request = Json & {
  turn: Json;
  now: string;
  input: {
    decided: {
      context: Json & {
        bundleId: unknown;
        writer: { people: unknown[] };
        texts: { words: string; sentAt: { utc: string } }[];
        openQuestions: { step: string; target: Json; sentAt: { utc: string } }[];
        choices: Json[];
        recentMessages: { words: string; sentAt: { utc: string } }[];
      };
      decide: Json & { bundleId: unknown; stakes: string; reads: Json[]; parts: Json[] };
    };
  };
};

/**
 * S1-09's three options for `owner`'s question as staging's frontier offers them to decide (K-09 README default 200;
 * frontier open-questions.ts cardChoices over bundle v3's S1-09): one per branch in the card's order, its label the
 * branch word for word and its definition the branch's Means line, each listing `business` (id), low (bundle v3 holds no
 * step after S1-10, so no walk names a stake), ids c-01 to c-03 in that order.
 */
function s1_09Choices(owner: S1_09Owner, target: Json): Json[] {
  return S1_09_V3.card.means.map((means, index) => ({
    question: owner.questionId,
    branch: means.branch,
    anytimeRow: null,
    door: null,
    hub: null,
    fields: [{ name: "business", type: "id" }],
    stakes: "low",
    stakesFrom: [],
    choiceId: `c-0${String(index + 1)}`,
    kind: "option",
    label: means.branch,
    definition: means.text,
    step: "S1-09",
    target: structuredClone(target),
  }));
}

/** A trace of its own under bundle v3, set to the turn, its spans kept. */
function tracedOnV3(turnId: string): TraceContext {
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: { ...BUNDLE_V3_ID },
    sink: (span) => SPANS.push(span),
  });
  trace.setTurn(turnId);
  return trace;
}

/**
 * An S1-09 owner's answer to its live S1-09 question: commit-s1-04.json's request (as T-1537's PostgreSQL proof sends
 * it) under the turn id the lease hashes from `said`'s one event id, on a trace of its own, the turn, its context and
 * decide's result pinned to bundle v3; every id of the fixture's roster owner swapped for this owner's, its question
 * S1-09's (the context's open question at S1-09, sent when the seed sent it, its options S1-09's three); its one part
 * choosing c-01 ("An owner; the listing matches") with `words` as the text, the part's quote and its `business` field's
 * words and value (default 200), in decide's agreed parts and both reads; its writer the owner as the frontier names a
 * person with no name and no role; and the moments after the question went out.
 */
async function s1_09Gate(
  owner: S1_09Owner,
  said: { readonly eventId: string; readonly sentAt: string; readonly now: string },
  words: string,
): Promise<GateCall> {
  const { request: base, names } = S1_04_FIXTURES.allShareOne;
  const turnId = await turnIdOf([said.eventId]);
  const trace = tracedOnV3(turnId);
  const request = renamed(
    structuredClone(base),
    new Map<string, string>([
      [names.business, owner.businessId],
      [names.person, owner.personId],
      [names.handle, owner.handleId],
      [names.number, owner.number],
      [names.chat, owner.chatId],
      [names.turn, turnId],
      [names.trace, trace.traceId],
      [names.event, said.eventId],
      [names.question, owner.questionId],
    ]),
  ) as S1_09Request;
  const { context, decide } = request.input.decided;
  const [text] = context.texts;
  const [asked] = context.openQuestions;
  const [question] = S1_09_V3.say;
  if (text === undefined || asked === undefined || question === undefined) {
    throw new Error("commit-s1-04.json's context holds the owner's text and its open question");
  }
  text.words = words;
  text.sentAt.utc = said.sentAt;
  asked.step = "S1-09";
  asked.sentAt.utc = owner.sentAt;
  context.choices = s1_09Choices(owner, asked.target);
  for (const message of context.recentMessages) {
    message.words = question.text;
    message.sentAt.utc = owner.sentAt;
  }
  context.writer.people = [{ personId: owner.personId, name: "", roles: [], language: null }];
  request.turn.bundleId = { ...BUNDLE_V3_ID };
  context.bundleId = { ...BUNDLE_V3_ID };
  decide.bundleId = { ...BUNDLE_V3_ID };
  const chosen = context.choices.find((choice) => choice.branch === OWNER_MATCHES);
  if (chosen?.choiceId !== "c-01") throw new Error("the frontier's first S1-09 option is the owner's claim");
  const part = {
    verb: "choose",
    quote: words,
    question: owner.questionId,
    choice: chosen.choiceId,
    fields: [{ name: "business", value: words, words }],
  };
  decide.stakes = "low";
  decide.reads = decide.reads.map((read) => ({
    ...read,
    output: { language: "en", parts: [structuredClone(part)] },
  }));
  decide.parts = [{ part: structuredClone(part), outcome: "go" }];
  request.now = said.now;
  return { request, turnId, trace };
}

/**
 * One gateAndCommit through realGate over staging's gate reads (with the listing ports), the root's turn-row port and
 * bundle port, the run's pinned bundle v3, `links` as the root's one HeldLinks and the gate's clock.
 */
function listingGate(
  rooted: Rooted,
  reads: GateReads,
  call: GateCall,
  pinned: PinnedBundle,
  links: HeldLinks,
): Promise<unknown> {
  return realGate({
    reads,
    commitTurn: (request) => rooted.root.ports.turnRow.commitTurn(request),
    bundles: () => rooted.root.ports.bundles,
    pinnedOf: (trace) => (trace === call.trace ? pinned : null),
    links,
    now: () => S1_09_GATE_NOW,
  }).gateAndCommit(call.request as never, NOTHING_OPEN, call.trace);
}

/** What an S1-09 owner's turn `turnId` left, as the runtime side reads it with no scope. */
function s1_09Rows(owner: S1_09Owner, turnId: string): Promise<Json> {
  return own.runtime("s1_09Rows", async (sql) => ({
    question: plainRows(
      await sql<Json[]>`select step, status from open_questions where id = ${owner.questionId}`,
    ),
    asked: plainRows(await sql<Json[]>`select id from open_questions where turn_id = ${turnId}`),
    head: plainRows(
      await sql<
        Json[]
      >`select name, display_name, status, version from businesses where id = ${owner.businessId}`,
    ),
    setup: plainRows(
      await sql<
        Json[]
      >`select business_id, version from business_setup where business_id = ${owner.businessId}`,
    ),
    outbox: plainRows(
      await sql<Json[]>`
      select id, step, line_no, open_question_id, send_class, recipient_handle_id, recipient_person_id, business_id,
             bundle_hash, bundle_build, plan
      from outbox_rows where turn_id = ${turnId} order by commit_seq
    `,
    ),
    accounts: plainRows(
      await sql<Json[]>`
      select person_id, mobile, mobile_proven_at, email, email_proven_at from accounts where person_id = ${owner.personId}
    `,
    ),
    links: plainRows(
      await sql<Json[]>`
      select id, business_id, person_id, purpose, step_id, code_sha256, sent_to_handle_id, issued_at, expires_at, ended_at
      from page_links where person_id = ${owner.personId}
    `,
    ),
    reviewItems: plainRows(
      await sql<Json[]>`
      select id, kind, business_id, subject_table, subject_row_id, turn_id, raised_by_person_id, summary, state
      from review_items where business_id = ${owner.businessId}
    `,
    ),
  }));
}

/** An S1-09 owner's business head's version, as the runtime side reads it with no scope. */
async function headVersionOf(owner: S1_09Owner): Promise<number> {
  const [head] = await own.runtime(
    "headVersion",
    (sql) => sql<{ version: number }[]>`select version from businesses where id = ${owner.businessId}`,
  );
  if (head === undefined) throw new Error("the roster-owner set wrote the owner's business head");
  return head.version;
}

/** The plain sha256 of a code, as S1-10's page_links row holds it. */
async function sha256Of(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The calls readStop makes for the turn's own owner, each on the runtime side, in its order (T-1516). */
const STOP_CALLS: readonly CallOn[] = [
  onJob(GATE_CALLS.stopHandle),
  onJob(GATE_CALLS.stopHandleIdsOfPerson),
  onJob(GATE_CALLS.stopPhoneOfHandle),
  onJob(GATE_CALLS.stopPersonIdsOfHandle),
  onJob(GATE_CALLS.stopConsentsOfPersons),
];

describe("an owner's answer to S1-09 on staging's gate with the listing ports bound, on bundle v3: S1-09's rows and S1-10's, and the walk waits (T-1540)", () => {
  it(
    "the demo listing ('Lee's Barbershop in Springfield, I'm the owner'), through realGate over staging's gate reads, commits once: S1-09's question answered, the typed name written, the read-back row, an accounts row, one page_links row holding the code's sha256 alone, S1-10's row, no question and no clock; the root's HeldLinks holds https://rosfield.com/test/<32 hex> for S1-10's row; every call one after another, 2 connections at most",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const { rooted, reads } = stagingGateOver(envOf());
      const owner = LISTING_OWNER;
      const call = await s1_09Gate(owner, S1_09_TEXTS.listing, DEMO_LISTING_WORDS);
      const pinned = pinnedV3();
      const links = new HeldLinks();
      const key = call.turnId;
      const headVersion = await headVersionOf(owner);

      const answer = await listingGate(rooted, reads, call, pinned.bundle, links);

      expect(answer, JSON.stringify(answer)).toMatchObject({
        result: "committed",
        turnId: key,
        repeated: false,
        openQuestions: { opened: [], closed: [owner.questionId] },
      });
      const rows = await s1_09Rows(owner, key);
      expect(rows.question).toEqual([{ step: "S1-09", status: "answered" }]);
      // The walk waits at S1-10 (K-09 README default 209): no question opened, and no clock (the counts below).
      expect(rows.asked).toEqual([]);
      // The owner's typed name, as typed, on both names, at the version read; S1-09 writes no status (the seeded head's
      // own stands: open gap 188).
      expect(rows.head).toEqual([
        {
          name: "Lee's Barbershop",
          display_name: "Lee's Barbershop",
          status: expect.any(String) as unknown,
          version: headVersion + 1,
        },
      ]);
      expect(rows.setup).toEqual([{ business_id: owner.businessId, version: 1 }]);
      // The read-back (S1-09, line 1), then S1-10's text (line 2), each to the owner, no question and no plan yet.
      const toOwner = (id: string, step: string, line: number): Json => ({
        id,
        step,
        line_no: line,
        open_question_id: null,
        send_class: "quick_reply",
        recipient_handle_id: owner.handleId,
        recipient_person_id: owner.personId,
        business_id: owner.businessId,
        bundle_hash: BUNDLE_V3_ID.hash,
        bundle_build: BUNDLE_V3_ID.build,
        plan: null,
      });
      expect(rows.outbox).toEqual([
        toOwner(`outbox-s1-09-${key}-1`, "S1-09", 1),
        toOwner(`outbox-s1-10-${key}-1`, "S1-10", 2),
      ]);
      // The chat's own number as the mobile, proven by the owner's text (default 210); no email.
      expect(rows.accounts).toEqual([
        {
          person_id: owner.personId,
          mobile: owner.number,
          mobile_proven_at: new Date(S1_09_TEXTS.listing.sentAt),
          email: null,
          email_proven_at: null,
        },
      ]);
      // The secure link (default 211): staged by S1-10's writer, kept by the gate face for the fresh commit's own row.
      const link = links.of(`outbox-s1-10-${key}-1`) ?? "";
      expect(link).toMatch(/^https:\/\/rosfield\.com\/test\/[0-9a-f]{32}$/u);
      const code = link.slice(link.lastIndexOf("/") + 1);
      LINK_CODES.push(code);
      expect(links.size).toBe(1);
      expect(links.stagedTurns).toBe(0);
      expect(rows.links).toEqual([
        {
          id: `link-s1-10-${key}-1`,
          business_id: owner.businessId,
          person_id: owner.personId,
          purpose: "setup_id_check",
          step_id: "S1-10",
          code_sha256: await sha256Of(code),
          sent_to_handle_id: owner.handleId,
          issued_at: new Date("2026-10-19T18:09:06Z"),
          expires_at: new Date("2026-10-26T18:09:06Z"),
          ended_at: null,
        },
      ]);
      // No S1-76 here: no review item.
      expect(rows.reviewItems).toEqual([]);
      expect(pinned.asked).toEqual([]);

      // Every call on its own client and side, one after another, the scope's held throughout: S1-09's writer's item 79
      // and item 26 reads and the read-back's stop reads, then S1-10's writer's and its text's.
      expect(callsOf(rooted.written)).toEqual([
        onApp(GATE_CALLS.scope),
        onJob(GATE_CALLS.seal),
        onJob(GATE_CALLS.pickedKinds),
        onJob(GATE_CALLS.kindsById),
        onJob(GATE_CALLS.kindsById),
        ...STOP_CALLS,
        onJob(GATE_CALLS.pickedKinds),
        onJob(GATE_CALLS.kindsById),
        onJob(GATE_CALLS.kindsById),
        ...STOP_CALLS,
        onJob("commitTurn"),
      ]);
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ connectionsOpen: 0, connectionsPeak: 2 * CONNECTIONS_PER_CLIENT });
      expect(counts.ended).toBe(counts.opened);
      // The turn row, the two outbox rows and the text's record: no question and no clock row.
      await expectCountsAfter(before, { turns: 1, outbox_rows: 2, safety_outcomes: 1 }, "grows");
      // Labels only: no line of the test's holds the owner's words, number, link or code.
      for (const line of lines) {
        for (const secret of [DEMO_LISTING_WORDS, "Springfield", owner.number, link, code]) {
          expect(line, "a line holds the owner's words, number, link or code").not.toContain(secret);
        }
      }
    },
  );

  it(
    "a made-up name and town ('Maple Corner Cuts, Riverton'), through realGate over staging's gate reads, commits once: the typed name written, S1-76's row and one listing_match review item (Claim: owner. Reason: no listing.) through the listing paging reader, then S1-10's rows; no read-back; every call one after another, 2 connections at most",
    { timeout: TEST_MS },
    async () => {
      const before = await rowCounts();
      const { rooted, reads } = stagingGateOver(envOf());
      const owner = MADE_UP_OWNER;
      const call = await s1_09Gate(owner, S1_09_TEXTS.madeUp, MADE_UP_LISTING_WORDS);
      const pinned = pinnedV3();
      const links = new HeldLinks();
      const key = call.turnId;
      const headVersion = await headVersionOf(owner);

      const answer = await listingGate(rooted, reads, call, pinned.bundle, links);

      expect(answer, JSON.stringify(answer)).toMatchObject({
        result: "committed",
        turnId: key,
        repeated: false,
        openQuestions: { opened: [], closed: [owner.questionId] },
      });
      const rows = await s1_09Rows(owner, key);
      expect(rows.question).toEqual([{ step: "S1-09", status: "answered" }]);
      expect(rows.asked).toEqual([]);
      expect(rows.head).toMatchObject([
        { name: "Maple Corner Cuts", display_name: "Maple Corner Cuts", version: headVersion + 1 },
      ]);
      expect(rows.outbox).toMatchObject([
        { id: `outbox-s1-76-${key}-1`, step: "S1-76", line_no: 0, open_question_id: null, plan: null },
        { id: `outbox-s1-10-${key}-1`, step: "S1-10", line_no: 2, open_question_id: null, plan: null },
      ]);
      // One team review item through T-319's openReviewItemCore, read through the listing paging reader: a listing check
      // of the owner's business, raised by the owner, its summary the fixed sentence (labels, no private value).
      expect(rows.reviewItems).toEqual([
        {
          id: expect.any(String) as unknown,
          kind: "listing_match",
          business_id: owner.businessId,
          subject_table: "businesses",
          subject_row_id: owner.businessId,
          turn_id: key,
          raised_by_person_id: owner.personId,
          summary: listingSummaryOf("owner", "noListing"),
          state: "open",
        },
      ]);
      const link = links.of(`outbox-s1-10-${key}-1`) ?? "";
      expect(link).toMatch(/^https:\/\/rosfield\.com\/test\/[0-9a-f]{32}$/u);
      const code = link.slice(link.lastIndexOf("/") + 1);
      LINK_CODES.push(code);
      expect(rows.links).toMatchObject([{ id: `link-s1-10-${key}-1`, code_sha256: await sha256Of(code) }]);
      expect(rows.accounts).toMatchObject([{ person_id: owner.personId, mobile: owner.number }]);

      // S1-09's writer's reads (no read-back, so no stop read for it), S1-76's message's stop reads and its review
      // item's three paging reads, then S1-10's writer's reads and its text's stop reads.
      expect(callsOf(rooted.written)).toEqual([
        onApp(GATE_CALLS.scope),
        onJob(GATE_CALLS.seal),
        onJob(GATE_CALLS.pickedKinds),
        onJob(GATE_CALLS.kindsById),
        onJob(GATE_CALLS.kindsById),
        ...STOP_CALLS,
        onJob(GATE_CALLS.reviewItem),
        onJob(GATE_CALLS.businessRow),
        onJob(GATE_CALLS.businessZone),
        onJob(GATE_CALLS.pickedKinds),
        onJob(GATE_CALLS.kindsById),
        onJob(GATE_CALLS.kindsById),
        ...STOP_CALLS,
        onJob("commitTurn"),
      ]);
      const counts = rooted.db.counts();
      expect(counts).toMatchObject({ connectionsOpen: 0, connectionsPeak: 2 * CONNECTIONS_PER_CLIENT });
      expect(counts.ended).toBe(counts.opened);
      await expectCountsAfter(before, { turns: 1, outbox_rows: 2, safety_outcomes: 1 }, "grows");
      for (const line of lines) {
        for (const secret of [
          MADE_UP_LISTING_WORDS,
          "Riverton",
          "Maple Corner Cuts",
          owner.number,
          link,
          code,
        ]) {
          expect(line, "a line holds the owner's words, number, link or code").not.toContain(secret);
        }
      }
    },
  );

  it("the listing paging reader, inside a held scope: the review item by id only under its own business, the business head's version and zone of the scope's business alone, another business's refused or none with no client opened; each read on a runtime-side client of its own (rosie_worker_job), 2 connections at most, nothing written", async () => {
    const before = await rowCounts();
    const { gate, written, db } = rootOver(envOf());
    const reader = gate.listing?.paging.reader;
    if (reader === undefined) throw new Error("staging's gate binds the listing paging reader");
    const owner = MADE_UP_OWNER;
    const [item] = (await s1_09Rows(owner, "none")).reviewItems as { id: string }[];
    if (item === undefined) throw new Error("the made-up answer above opened its review item");
    const headVersion = await headVersionOf(owner);

    const read = await gate.scope.withBusiness(owner.businessId, async (repo) => {
      const paging = reader(repo);
      return {
        item: await paging.reviewItem(item.id),
        none: await paging.reviewItem("review-item-t1540-none"),
        head: await paging.row("businesses", owner.businessId),
        other: await paging.row("businesses", LISTING_OWNER.businessId),
        zone: await paging.businessZone(owner.businessId),
        otherZone: await rejectionOf(paging.businessZone(LISTING_OWNER.businessId)),
        otherTable: await rejectionOf(paging.row("business_setup", owner.businessId)),
      };
    });
    // Under another business's scope, the same item is no row of that business's.
    const elsewhere = await gate.scope.withBusiness(LISTING_OWNER.businessId, (repo) =>
      reader(repo).reviewItem(item.id),
    );

    expect(read.item).toMatchObject({
      id: item.id,
      kind: "listing_match",
      businessId: owner.businessId,
      subjectTable: "businesses",
      subjectRowId: owner.businessId,
      summary: listingSummaryOf("owner", "noListing"),
      state: "open",
      version: 1,
    });
    expect(read.item?.openedAt).toMatch(UTC_INSTANT);
    expect(read.none).toBeNull();
    expect(read.head).toEqual({ version: headVersion, businessId: owner.businessId });
    expect(read.other).toBeNull();
    expect(read.zone).toEqual(expect.any(String));
    expect(read.otherZone).toBeInstanceOf(ListingPagingScopeError);
    expect(read.otherTable).toBeInstanceOf(NotBuiltError);
    expect(elsewhere).toBeNull();

    // The scope's client first, then one runtime-side client a read: none for another business or another table.
    expect(callsOf(written)).toEqual([
      onApp(GATE_CALLS.scope),
      onJob(GATE_CALLS.reviewItem),
      onJob(GATE_CALLS.reviewItem),
      onJob(GATE_CALLS.businessRow),
      onJob(GATE_CALLS.businessZone),
      onApp(GATE_CALLS.scope),
      onJob(GATE_CALLS.reviewItem),
    ]);
    expect([GATE_CALLS.reviewItem, GATE_CALLS.businessRow, GATE_CALLS.businessZone]).toEqual([
      "readReviewItem",
      "readBusinessRow",
      "readBusinessZone",
    ]);
    expect(db.counts()).toMatchObject({
      opened: 7,
      ended: 7,
      connectionsOpen: 0,
      connectionsPeak: 2 * CONNECTIONS_PER_CLIENT,
    });
    expect(await rowCounts()).toEqual(before);
  });
});

// ---- production ---------------------------------------------------------------------------------------------------

describe("in production's environment the part builds nothing and reads no binding", () => {
  it("stagingOptions builds none (ENVIRONMENT read alone, this part's builder never called), the builder alone answers null reading ENVIRONMENT alone, and the Worker's production root keeps the gate closed", async () => {
    for (const environment of ["production", "", "Staging", "preview"]) {
      const testEnv = envOf({ environment });
      const called: GatePart[] = [];
      const inputs = stagingOptions(testEnv.env, {
        db: handleOver(testEnv.env, []),
        builders: {
          gate: (part) => {
            called.push(part);
            return stagingGateReads(part);
          },
        },
      });
      expect(inputs, environment).toBe(NO_STAGING_INPUTS);
      expect(testEnv.names, environment).toEqual(["ENVIRONMENT"]);
      expect(called, environment).toEqual([]);

      const alone = envOf({ environment });
      const db = handleOver(alone.env, []);
      expect(
        stagingGateReads({ env: alone.env, db, keys: sealingWrapKeys(alone.env), bundleSafety: null }),
      ).toBeNull();
      expect(alone.names, environment).toEqual(["ENVIRONMENT"]);
    }

    const testEnv = envOf({ environment: "production" });
    const root = workerRoot(testEnv.env);
    expect(root.environment).toBe("production");
    const thrown = await rejectionOf(gateOn(root, await firstTextGate(NO_WRAP_KEY)));
    expect(thrown).toEqual(new NotJoinedError("gate"));
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app?.reads.n]).toEqual([0, 0]);
  });
});

// ---- the capture --------------------------------------------------------------------------------------------------

describe("the span and log capture", () => {
  it("no line written while this file ran holds a text's words, a number, an address, the wrapping key, a sealed value, a chat id or a fixed line's words, and no rejection was left unhandled", async () => {
    // The capture is not empty: every call's timing line is in it.
    expect(turnOne).not.toBeNull();
    const kinds = new Set(
      everyLine.flatMap((line) => (line.startsWith("{") ? [String(parsed(line).msg)] : [])),
    );
    expect([...kinds]).toEqual(expect.arrayContaining(["dbCall"]));
    expect(SEALED.length).toBeGreaterThanOrEqual(2);
    expectNoSecrets([...everyLine, ...SPANS.map((span) => JSON.stringify(span))]);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });

  it("no line written while this file ran, and no span, holds the row id the failed item 79 read named, or the asked owner's number (T-1470)", () => {
    // The capture holds the two kinds reads' timing lines, so it saw those calls.
    const calls = everyLine.flatMap((line) => (line.startsWith("{") ? [String(parsed(line).call)] : []));
    expect(calls).toEqual(expect.arrayContaining([GATE_CALLS.kindCatalog, GATE_CALLS.pickedKinds]));
    const secrets = [NOBODY, ASKED.number, ASKED.number.slice(1), ASKED.number.slice(2)];
    for (const text of [...everyLine, ...SPANS.map((span) => JSON.stringify(span))]) {
      for (const secret of secrets) expect(text, "a line holds a row id or a number").not.toContain(secret);
    }
  });
});
