// T-1537's integration proof (S1-09 design card 7, ops/reviews/s1-09-design/rule-s1-09.json, extended to S1-10 by
// rule-s1-10.json; DL-1171; K-09 README defaults 201 to 211) on local PostgreSQL: `npm run db:up`, then `npm run
// test:integration -- actions/src/tool-api/turn-face/pg/s1-09-answer.int.test.ts`. The owner's reply to S1-09, through the
// turn face bound as ../commit.ts default 7 binds it, is one commit pinned to bundle v3: S1-09's question closed, the typed
// name written, the read-back or S1-76's row and review item, S1-10's accounts row, link row and text, and the walk waits.
//
// The world (a fresh schema, migrated with every migration and dropped when the file ends: commit/pg/test-support.ts):
//   - K-24's catalog, the 243 trade-file kinds and their kind_flows as the kinds seed writes them (T-212), so "Plumbing"
//     takes the one-kind path (T-1493) to S1-08's row and S1-09's question, as on the phone;
//   - the roster-owner seed (db/seeds/roster-owner.ts, run as it is) for six numbers in the fiction range, so six owners,
//     each a person with no name and no role at a stand-in business head of their own (the skeleton demo shop's name),
//     with its business_setup row (control not proven), its company and the company's barber kind of work;
//   - each number's phone row as the gateway's receipt of its first text leaves it (K-05 v1.7 openChatOnText, DL-948:
//     chat open, nothing else set), the row S1-10's writer takes the chat's number from (accounts_mobile_fk);
//   - each person's sealing key, made as the gateway makes it at first sight, under a wrapping key made for this run alone;
//   - the registry row of bundle v3 as bundles/v3 holds it (T-1526), which every turn pins.
//
// Who runs what. The turn face is handed two clients of this file's own, each statement's text written down (never a
// value): `app`, whose connections run as rosie_app (2: the call's transaction, and item 78's and item 72's own reads
// beside it), and `job`, as rosie_job. The gate, the walk's question read and readOpenHolds run on `app`; K-05's
// commitTurn, item 79 and item 26 (S1-09's and S1-10's writers' reads: pgListingReads, pgMobileIdReads), the stop reads,
// the paging reader of S1-76's review item, the sealer, the frontier and the row reads on `job`, each in a transaction
// of its own. The schema owner's client only seeds the world, plays the sends and reads what the turns left.
//
// Real here: the Tool API base, the frontier (turn 3's options, as staging's frontier hands them to decide), the gate and
// limits 1 to 6, the commit with T-1505's re-send, the walk (T-1461, T-1528's "ask", T-1532's wait), the binding of
// T-1537 (pgTurnCalls with settleSignUp: signUpSteps with SignUpWriterDeps.listing, its link's stage the face's
// HeldLinks), T-635a's settler and writers, T-1533's writer and minting, T-1493's one-kind path, runCore with the safety
// service, compose input and finalize with the link.secure filler, claimOutbox, every data-access call, row-level
// security and the two application roles. Doubles, because their tasks bind them: T-434's Places double (K-15; staging's
// while J-16 is open: default 208), and a paging reader over this schema as rosie_job for the three reads S1-76's review
// item makes (T-1444's runtime reader is not built). Given: the decided texts, K-09's commit-s1-01.json,
// commit-s1-02.json and commit-s1-04.json's shapes as each owner sends them (no model is called), turn 3's context the
// frontier's own; the plans, written from compose input's own master text as a composer would give them.
//
// The owners (six roster places):
//   1. The demo listing, typed with a straight apostrophe: "Lee's Barbershop in Springfield, I'm the owner". Through a
//      face with the listing deps left out it is refused (notBuilt) with nothing written, as today. Through the whole
//      binding it is one commit: oq-s1-09 closed; the head renamed to the typed name; the read-back row (S1-09, line 1);
//      the accounts row (the chat's number, proven at the text); one page_links row holding the code's sha256 alone; S1-10's
//      row (line 2), and no question and no clock row; a replay writes nothing and holds no new link (limit 1 answers it
//      notBuilt before K-05 answers repeated: no question is live after the wait, open gap 195). Both rows are
//      composed and finalized: S1-10's text carries https://rosfield.com/test/<32-hex code>, which the face then lets go.
//      claimOutbox takes them in commit order.
//   2. The same words with an iPhone's curly apostrophes: the same rows.
//   3. A real-looking name and town (made up): S1-76's row, one listing_match review item (Claim: owner. Reason: no
//      listing.), then S1-10's row; S1-76's row composed and finalized.
//   4. "I'm the owner" alone: S1-09 sent again once (T-1528: ask_count 1 to 2), nothing else written; a second time,
//      nothing sent.
//   5. A helper's words with the demo listing: refused (notBuilt: S1-77 tells and has no writer, default 214), nothing
//      written.
//   6. A name with no town ("Lee's Barbershop"): S1-09 sent again once, as for owner 4.
// Nothing the turns do logs a name, a town, a number, a code or a link (console spies; the frontier's log sink).

import { readdirSync, readFileSync } from "node:fs";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { createPlacesDouble } from "../../../../../adapters/src/places/double";
import { openChatOnText } from "../../../../../db/repo/chat-open";
import { armClock } from "../../../../../db/repo/clocks";
import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import { claimOutbox } from "../../../../../db/repo/outbox";
import type { Sql, Tx } from "../../../../../db/repo/scope";
import type { WrappingKeys } from "../../../../../db/repo/sealing";
import { catalogPlanOf, insertCatalog, openTradeSet, verifyTradeSet } from "../../../../../db/seeds/kinds";
import { ALLOWLIST_VARIABLE, rosterOwnerIds, seedRosterOwner } from "../../../../../db/seeds/roster-owner";
import type { GateAndCommitRequest } from "../../../commit";
import {
  NO_FOOTPRINT,
  RUNTIME_ROLE,
  TOOL_API_ROLE,
  footprint,
  openCommitDatabase,
  snapshot,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { decidedOf, turnTwoOnV1 } from "../../../commit/walk/test-support";
import { noPagingReads, type PagingReader, type StoredReviewItem } from "../../../domain/paging";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import {
  captureLog,
  checks,
  fakeBundles,
  type BundleDocument,
} from "../../../frontier/assemble/test-support";
import type { DecidePart } from "../../../gate/framework";
import { pgKindsReads } from "../../journey-1/kinds";
import { listingSummaryOf, pgListingReads } from "../../journey-1/listing";
import {
  DEMO_NAME,
  MADE_UP_NAME,
  MADE_UP_WORDS,
  RULING_WORDS,
  RULING_WORDS_CURLY,
} from "../../journey-1/listing/test-support";
import { pgMobileIdReads } from "../../journey-1/mobile-id";
import type { PlugInBundles } from "../../journey-1/plug-ins";
import { fixture, traceFor } from "../../test-support";
import { commitS101, composeS102 } from "../calls-test-support";
import { NOTHING_OPEN_AT, type SignUpWriterDeps } from "../commit";
import { HeldLinks } from "../held";
import type { TurnFace } from "../turn-face";
import { pgCompaniesReads, pgTurnCalls, pgTurnFace } from "./index";
import { pgStopReads } from "./test-support";

type Json = Record<string, unknown>;

const SLOW = { timeout: 120_000 };
/** The Tool API client's connections: the call's transaction, and item 78's and item 72's own reads beside it. */
const APP_POOL = 2;
const JOB_POOL = 4;

const { validator, checker } = checks();

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

// ---- bundle v3 (bundles/v3, T-1526), which every turn pins --------------------------------------------------------------

const BUNDLE_V3_DIR = new URL("../../../../../bundles/v3/bundle/", import.meta.url);

/** One of bundle v3's parts, freshly parsed. */
function bundleV3Part(file: string): Json {
  return JSON.parse(readFileSync(new URL(file, BUNDLE_V3_DIR), "utf8")) as Json;
}

/** Bundle v3 as bundles/v3 holds it: its manifest and flow A (bundle v2's eight steps, S1-76, S1-77 and S1-10). */
function publishedBundleV3(): BundleDocument {
  return { manifest: bundleV3Part("manifest.json"), flows: { A: bundleV3Part("flow/A.json") } };
}

/** Bundle v3's id, as its manifest names it. */
const V3 = ((): { hash: string; build: number } => {
  const { hash, build } = bundleV3Part("manifest.json").bundleId as { hash: string; build: number };
  return { hash, build };
})();

/** The trade port over bundle v3's own overlays: the overlay asked for when the id is bundle v3's and it holds it. */
const TRADES: PlugInBundles = ((): PlugInBundles => {
  const held = new Set(
    readdirSync(new URL("trade/", BUNDLE_V3_DIR))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length)),
  );
  return {
    trade(bundleId, tradeId) {
      const pinned = bundleId.hash === V3.hash && bundleId.build === V3.build;
      return Promise.resolve(pinned && held.has(tradeId) ? bundleV3Part(`trade/${tradeId}.json`) : null);
    },
  };
})();

/** Bundle v3's flow A step `stepId`'s line from Rosie to the owner at `index` among those lines. */
function lineToOwner(stepId: string, index: number): string {
  const steps = (publishedBundleV3().flows.A as { steps: Record<string, { say: Json[] }> }).steps;
  const said = (steps[stepId]?.say ?? []).filter(
    (message) => message.from === "san" && message.to === "owner",
  );
  const text = said[index]?.text;
  if (typeof text !== "string")
    throw new Error(`bundle v3's ${stepId} has a line to the owner at ${String(index)}`);
  return text;
}

/** S1-09's read-back (line 1), S1-76's line and S1-10's line 2 (say[4]), as bundle v3 compiles them. */
const READ_BACK_LINE = lineToOwner("S1-09", 1);
const S1_76_LINE = lineToOwner("S1-76", 0);
const S1_10_LINE = lineToOwner("S1-10", 2);

/** S1-10's line 2's last sentence, and the sample link its card carries (MC C6), which is never sent. */
const LAST_SENTENCE = "These texts are only about your business on Rosie.";
const SAMPLE_LINK = "rosfield.com/v/s01";

/** Staging's link host and base path (DL-014, DL-023), as the Worker's LINK_HOST and BASE_PATH. */
const LINK_HOST = "rosfield.com";
const BASE_PATH = "/test";

/** S1-09's branches, word for word as bundle v3 labels them. */
const OWNER_MATCHES = "An owner; the listing matches";
const HELPS_RUN_IT = "Helps run it; not an owner";

/**
 * The moments: turn 1's commit, its row's finalize, send and delivery; turn 2's text and commit, its rows' send and
 * delivery; turn 3's text, commit, finalize and claim; a second ask's text and commit.
 */
const NOW_1 = "2026-10-19T18:05:05Z";
const FINALIZED_1 = "2026-10-19T18:05:07Z";
const SENT_1 = "2026-10-19T18:05:08Z";
const DELIVERED_1 = "2026-10-19T18:05:09Z";
const TEXT_2 = "2026-10-19T18:07:00Z";
const NOW_2 = "2026-10-19T18:07:06Z";
const SENT_2 = "2026-10-19T18:07:08Z";
const DELIVERED_2 = "2026-10-19T18:07:09Z";
const TEXT_3 = "2026-10-19T18:09:00Z";
const NOW_3 = "2026-10-19T18:09:06Z";
const FINALIZED_3 = "2026-10-19T18:09:08Z";
const CLAIMED_AT = "2026-10-19T18:09:10Z";
const TEXT_4 = "2026-10-19T18:11:00Z";
const NOW_4 = "2026-10-19T18:11:06Z";

/** The owners' words: one listed kind, the claim alone, a helper's words with the demo listing, a name with no town. */
const PLUMBING = "Plumbing";
const CLAIM_ALONE = "I'm the owner";
const HELPER_WORDS = "Lee's Barbershop in Springfield, I help run it";
const NO_TOWN = "Lee's Barbershop";

// ---- the owners (db/seeds/roster-owner.ts, places 1 to 6) ----------------------------------------------------------------

/** One roster owner of this world, with the ids its turns and rows take (K-09 v1.5 default 131: from the turn's id). */
interface Owner {
  readonly place: number;
  /** A number in the fiction range (555-0100 to 555-0199), never a test phone's fixed fake handle or a real phone's. */
  readonly number: string;
  readonly business: string;
  readonly company: string;
  readonly person: string;
  readonly handle: string;
  /** The Linq chat of the owner's texts, a stand-in in K-06's form. */
  readonly chat: string;
  readonly turn1: string;
  readonly turn2: string;
  readonly turn3: string;
}

/** Places 1 to 6's numbers, each written whole, so the phone scan (T-1317) reads each as a fiction-range number. */
const OWNER_NUMBERS: readonly string[] = [
  "+15555550161",
  "+15555550162",
  "+15555550163",
  "+15555550164",
  "+15555550165",
  "+15555550166",
];

function ownerAt(place: number): Owner {
  const ids = rosterOwnerIds(place);
  const n = String(place);
  const number = OWNER_NUMBERS[place - 1];
  if (number === undefined) throw new Error(`no owner number at place ${n}`);
  return {
    place,
    number,
    business: ids.businessId,
    company: ids.companyId,
    person: ids.personId,
    handle: ids.handleId,
    chat: `linq-chat-demo-s1-09-answer-${n}`,
    turn1: `turn-s1-01-s1-09-answer-${n}`,
    turn2: `turn-s1-02-s1-09-answer-${n}`,
    turn3: `turn-s1-09-s1-09-answer-${n}`,
  };
}

const OWNERS = [ownerAt(1), ownerAt(2), ownerAt(3), ownerAt(4), ownerAt(5), ownerAt(6)] as const;
const [FIRST, SECOND, THIRD, FOURTH, FIFTH, SIXTH] = OWNERS;

/** The ids of the rows a turn writes at a step (default 131: the turn's own id as its key). */
const rowIds = (turnId: string) => ({
  readBack: `outbox-s1-09-${turnId}-1`,
  asked: `outbox-s1-09-${turnId}-1`,
  s1_76: `outbox-s1-76-${turnId}-1`,
  s1_10: `outbox-s1-10-${turnId}-1`,
  link: `link-s1-10-${turnId}-1`,
});

/** Turn 2's rows and S1-09's question (one-kind path: S1-08's row, S1-09's question and its row). */
const turnTwoRows = (owner: Owner) => ({
  plan: `outbox-s1-08-${owner.turn2}-1`,
  question: `oq-s1-09-${owner.turn2}-1`,
  asked: `outbox-s1-09-${owner.turn2}-1`,
});

/** The owner as the frontier names a person with no name and no role (frontier/assemble/frame.ts writerOf). */
const writerOf = (owner: Owner) => ({ personId: owner.person, name: "", roles: [], language: null });

/** A copy of `value` with each whole text that `names` holds replaced by its new name. */
function renamed<T>(value: T, names: ReadonlyMap<string, string>): T {
  const walk = (each: unknown): unknown => {
    if (typeof each === "string") return names.get(each) ?? each;
    if (Array.isArray(each)) return each.map(walk);
    if (typeof each === "object" && each !== null) {
      return Object.fromEntries(Object.entries(each).map(([key, inner]) => [key, walk(inner)]));
    }
    return each;
  };
  return walk(value) as T;
}

/** The fixtures' sample names, as the owner's: Sam's business, person, handle, number and chat. */
const samNames = (owner: Owner): [string, string][] => [
  ["biz-lees-barbershop", owner.business],
  ["person-sam", owner.person],
  ["handle-sam", owner.handle],
  ["+15555550100", owner.number],
  ["linq-chat-demo-sam", owner.chat],
];

/** commit-s1-04.json's roster names, as the owner's. */
const rosterNames = (owner: Owner): [string, string][] => [
  ["biz-roster-owner-1", owner.business],
  ["person-roster-owner-1", owner.person],
  ["handle-roster-owner-1", owner.handle],
  ["+15555550150", owner.number],
  ["linq-chat-demo-roster", owner.chat],
];

/** `request`'s turn, decided context and decide pinned to bundle v3, its writer the owner as the frontier names them. */
function pinned(request: GateAndCommitRequest, owner: Owner): GateAndCommitRequest {
  const { context, decide } = decidedOf(request);
  if (request.turn === null) throw new Error("the request carries its turn");
  request.turn.bundleId = { ...V3 };
  context.bundleId = { ...V3 };
  decide.bundleId = { ...V3 };
  context.writer.people = [structuredClone(writerOf(owner))];
  return request;
}

/** Turn 1: commit-s1-01.json's request as the owner sends it, pinned to bundle v3. */
function turnOne(owner: Owner): GateAndCommitRequest {
  const names = new Map<string, string>([
    ...samNames(owner),
    ["turn-s1-01-sam", owner.turn1],
    ["trace-sam-0000", `trace-${owner.turn1}`],
    ["evt-sam-s1-01", `evt-${owner.turn1}`],
    ["outbox-s1-02-sam-1", `outbox-s1-02-${owner.turn1}-1`],
  ]);
  return pinned(renamed(commitS101().request, names), owner);
}

/** Turn 2: commit-s1-02.json's request (T-1461's turnTwoOnV1) as the owner sends it: "Plumbing" to S1-02's question. */
function turnTwo(owner: Owner): GateAndCommitRequest {
  const base = turnTwoOnV1("c-01").exchange.request;
  const change = (part: DecidePart): void => {
    if (part.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
    part.choice = "c-01";
    part.quote = PLUMBING;
    for (const field of part.fields) {
      if (field.name === "kinds") {
        field.value = PLUMBING;
        field.words = PLUMBING;
      }
    }
  };
  const given = decidedOf(base);
  for (const entry of given.decide.parts) change(entry.part);
  for (const read of given.decide.reads) for (const part of read.output.parts) change(part);
  given.context.texts[0].words = PLUMBING;
  const request = pinned(
    renamed(
      base,
      new Map<string, string>([
        ...samNames(owner),
        ["turn-s1-02-sam-kinds", owner.turn2],
        ["trace-sam-0001", `trace-${owner.turn2}`],
        ["evt-sam-0001", `evt-${owner.turn2}`],
        ["oq-s1-02", `oq-s1-02-${owner.turn1}-1`],
      ]),
    ),
    owner,
  );
  const { context } = decidedOf(request);
  context.texts[0].sentAt.utc = TEXT_2;
  for (const question of context.openQuestions) question.sentAt.utc = SENT_1;
  for (const message of context.recentMessages) message.sentAt.utc = SENT_1;
  request.now = NOW_2;
  return request;
}

// ---- the schema, its clients and the faces ------------------------------------------------------------------------------

let cdb: CommitDatabase;
/** The Tool API's client (rosie_app) and the runtime side's (rosie_job), each statement's text written down. */
let app: Sql;
let job: Sql;
const sent = { app: [] as string[], job: [] as string[] };
/** The commit's moment and finalize's, set before each call. */
const clock = { now: NOW_1, finalize: FINALIZED_1 };
/** The frontier's log lines (labels only). */
const frontierLog = captureLog();

/** The face's one hold of S1-10's links: the writer's stage, the face's links and the rows' links (pgTurnCalls). */
const links = new HeldLinks();

/** The whole binding, and the same with the listing deps left out (today's). */
let face: TurnFace;
let todayFace: TurnFace;

/** A stored review item's moment as the service reads it: UTC to the second, ending in Z. */
const utc = (at: Date | null): string | null =>
  at === null ? null : at.toISOString().replace(/\.\d{3}Z$/u, "Z");

/**
 * T-319's paging reader for S1-76's review item over this schema as rosie_job (the runtime's PagingReader, T-1444, is not
 * built): the item by id (none on a first run), the businesses row under review (its version and its business) and the
 * business's zone. Every other read refuses (notBuilt), as no reader would answer it.
 */
function pagingReaderOn(runtime: Sql): PagingReader {
  const refuse = noPagingReads("openReviewItem");
  return {
    ...refuse,
    async reviewItem(reviewItemId) {
      const [row] = await runtime<
        {
          id: string;
          kind: StoredReviewItem["kind"];
          business_id: string | null;
          subject_table: string | null;
          subject_row_id: string | null;
          turn_id: string | null;
          raised_by_person_id: string | null;
          summary: string;
          opened_at: Date;
          due_at: Date;
          state: StoredReviewItem["state"];
          wait_until: Date | null;
          decided_at: Date | null;
          decided_by_person_id: string | null;
          outcome: string | null;
          version: number;
        }[]
      >`
        select id, kind, business_id, subject_table, subject_row_id, turn_id, raised_by_person_id, summary, opened_at,
               due_at, state, wait_until, decided_at, decided_by_person_id, outcome, version
        from review_items where id = ${reviewItemId}
      `;
      if (row === undefined) return null;
      return {
        id: row.id,
        kind: row.kind,
        businessId: row.business_id,
        subjectTable: row.subject_table,
        subjectRowId: row.subject_row_id,
        turnId: row.turn_id,
        raisedByPersonId: row.raised_by_person_id,
        summary: row.summary,
        openedAt: utc(row.opened_at) ?? "",
        dueAt: utc(row.due_at) ?? "",
        state: row.state,
        waitUntil: utc(row.wait_until),
        decidedAt: utc(row.decided_at),
        decidedByPersonId: row.decided_by_person_id,
        outcome: row.outcome,
        version: row.version,
      };
    },
    async row(table, rowId) {
      if (table !== "businesses") return refuse.row(table, rowId);
      const [row] = await runtime<{ id: string; version: number }[]>`
        select id, version from businesses where id = ${rowId}
      `;
      return row === undefined ? null : { version: row.version, businessId: row.id };
    },
    async businessZone(businessId) {
      const [row] = await runtime<{ time_zone: string | null }[]>`
        select time_zone from businesses where id = ${businessId}
      `;
      return row?.time_zone ?? null;
    },
  };
}

/** A face over this world's two clients: T-1493's and T-1484's binding, with T-1537's listing deps unless `today`. */
function faceOf(today: boolean): TurnFace {
  const bundles = fakeBundles(publishedBundleV3());
  const stop = pgStopReads(job);
  const signUp: SignUpWriterDeps<Tx> = {
    kinds: { reads: pgKindsReads(app, job), stop },
    plugIns: { bundles: TRADES },
    companies: pgCompaniesReads(app, job),
    s1_04Writer: {},
    plan: { stop },
    ...(today
      ? {}
      : {
          listing: {
            places: createPlacesDouble({ now: () => clock.now }),
            reads: pgListingReads(job),
            stop,
            paging: { reader: () => pagingReaderOn(job) },
            mobileId: {
              reads: pgMobileIdReads(job),
              link: { host: LINK_HOST, basePath: BASE_PATH, now: () => new Date(clock.now), stage: links },
            },
          },
        }),
  };
  return pgTurnFace(job, {
    bundles,
    validator,
    checker,
    log: frontierLog.sink,
    calls: pgTurnCalls(job, app, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
      now: () => new Date(clock.now),
      finalizeNow: () => clock.finalize,
      finalizeLog: () => undefined,
      signUp,
      settleSignUp: true,
    }),
  });
}

beforeAll(async () => {
  cdb = await openCommitDatabase("turn_face_s1_09_answer", JOB_POOL);
  const { sql } = cdb.db;
  // The registry row: bundle v3, which every turn pins.
  await sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${V3.hash}, ${V3.build}, ${`bundle/${V3.hash}/${String(V3.build)}/manifest`}, '2026-11-22T10:00:00Z')
  `;
  // K-24's catalog: the 243 trade-file kinds and their kind_flows, as the kinds seed writes them (T-212).
  const { rows } = catalogPlanOf(verifyTradeSet(openTradeSet()));
  await sql.begin(async (tx) => {
    await insertCatalog(tx, rows);
  });
  // The roster-owner seed, as it is, for six numbers: its own transaction as rosie_job.
  const seeded = await seedRosterOwner(sql, {
    env: { [ALLOWLIST_VARIABLE]: OWNERS.map((owner) => owner.number).join(",") },
  });
  expect(seeded.ranAs).toBe(RUNTIME_ROLE);
  expect(seeded.owners.map((owner) => owner.personId)).toEqual(OWNERS.map((owner) => owner.person));
  for (const owner of OWNERS) {
    // Each person's key, made as the gateway makes it at the first sight of the number (K-05 v1.2 item 29).
    const sighted = await handleSealingKey(cdb.runtime, KEYS, {
      handle: { kind: "phone", address: owner.number },
      newHandleId: `handle-t1537-unused-${String(owner.place)}`,
      newPersonId: `person-t1537-unused-${String(owner.place)}`,
      wrappingKeyName: "SEALING_WRAP_KEY",
    });
    if (!("result" in sighted.outcome) || sighted.outcome.personId !== owner.person) {
      throw new Error("first sight did not give the roster owner's key");
    }
    // The gateway's receipt of the JOIN (K-05 v1.7 openChatOnText): the phone row it inserts, chat open.
    const opened = await openChatOnText(cdb.runtime, {
      eventId: `evt-${owner.turn1}`,
      handleId: owner.handle,
      service: "imessage",
      receivedAt: "2026-10-19T18:05:00Z",
      traceId: `trace-${owner.turn1}`,
    });
    if (!("result" in opened) || opened.result !== "inserted") {
      throw new Error("the JOIN's receipt inserted no phone row");
    }
  }
  app = cdb.client(TOOL_API_ROLE, "rosie-turn-face-s1-09-answer-app", APP_POOL, (text) => {
    sent.app.push(text.trim());
  });
  job = cdb.client(RUNTIME_ROLE, "rosie-turn-face-s1-09-answer-job", JOB_POOL, (text) => {
    sent.job.push(text.trim());
  });
  face = faceOf(false);
  todayFace = faceOf(true);
}, 240_000);

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), job.end({ timeout: 5 })]);
  await cdb.close();
});

// Nothing a turn does logs a name, a town, a number, a code or a link: every console line is read back here.
const consoleNames = ["log", "info", "warn", "error", "debug"] as const;
let spies: MockInstance[] = [];
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  spies = consoleNames.map((name) =>
    vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  const lines = [...logged, ...frontierLog.lines.map((line) => JSON.stringify(line))];
  for (const line of lines) {
    // A code is 32 hex characters standing alone (a bundle hash, 64 of them, is no code).
    expect(line).not.toMatch(/\b[0-9a-f]{32}\b/u);
    for (const value of ["rosfield.com", "Springfield", "Barbershop", "Maple", "Riverton"]) {
      expect(line.toLowerCase()).not.toContain(value.toLowerCase());
    }
    for (const owner of OWNERS) expect(line).not.toContain(owner.number.slice(2));
  }
});

// ---- what the turns left ------------------------------------------------------------------------------------------------

/** One open question's status, version, step and ask count, as the owner reads its row. */
async function questionRow(
  id: string,
): Promise<{ status: string; version: number; step: string; ask_count: number } | undefined> {
  const [row] = await cdb.db.sql<{ status: string; version: number; step: string; ask_count: number }[]>`
    select status, version, step, ask_count from open_questions where id = ${id}
  `;
  return row;
}

/** The sign-up tables S1-09's and S1-10's writers and S1-76's item write, counted, beside the core snapshot. */
async function signUpRows(): Promise<Json> {
  const [row] = await cdb.db.sql<Json[]>`
    select (select count(*)::int from accounts) as accounts,
           (select count(*)::int from page_links) as page_links,
           (select count(*)::int from review_items) as review_items,
           (select count(*)::int from business_setup) as business_setup,
           (select coalesce(sum(version), 0)::int from business_setup) as business_setup_versions
  `;
  if (row === undefined) throw new Error("signUpRows: no row");
  return row;
}

/** Everything a refused turn must leave as it was. */
async function everything(): Promise<Json> {
  return { core: await snapshot(cdb), signUp: await signUpRows() };
}

/** The business head's name, display name and status, as the owner reads it. */
async function headOf(owner: Owner) {
  const [row] = await cdb.db.sql<{ name: string; display_name: string; status: string }[]>`
    select name, display_name, status from businesses where id = ${owner.business}
  `;
  return row;
}

/** A statement that reads a table that spans businesses, which rosie_app holds no grant on (0012). */
const SPANS_BUSINESSES =
  /\b(from|join)\s+(handles|persons|phones|person_handles|turns|accounts|page_links)\b/u;

/** The caller of a call the turn `turnId` makes after its commit. */
const callerOf = (owner: Owner, turnId: string): Json => ({
  kind: "turn",
  turnId,
  requestId: turnId,
  businessId: owner.business,
  personId: owner.person,
  traceId: `trace-${turnId}`,
});

/** What finalize answers when it sends: its outcome and the final parts it wrote. */
interface Finalized extends Json {
  outcome: string;
  finalParts: { row: string; fixedLines: string[]; sends: { kind: string; text: string }[] };
}

/** K-09's committed answer, as the turn face gives it. */
interface Committed {
  readonly parts: Json[];
  readonly written: { written: Json[]; outboxRows: Json[]; promoted: Json[] };
  readonly openQuestions: { opened: string[]; closed: string[] };
}

/** A row's send, played: one delivered part, the row moved to delivered, and its question's clock armed at the receipt. */
async function deliver(rowId: string, questionId: string | null, at: { sent: string; delivered: string }) {
  const { sql } = cdb.db;
  await sql`
    insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, linq_message_id,
                              state, sent_at, delivered_at)
    values (${rowId}, 1, 1, ${`${rowId}/1/1`}, 1, 'words', ${`linq-msg-${rowId}`}, 'delivered', ${at.sent},
            ${at.delivered})
  `;
  await sql`update outbox_rows set state = 'delivered', version = version + 1 where id = ${rowId}`;
  if (questionId === null) return;
  const armed = await armClock(job, {
    openQuestionId: questionId,
    deliveredAt: at.delivered,
    dueAt: "2026-10-20T18:00:00Z",
    dueZone: "America/New_York",
  });
  expect(armed).toMatchObject({ result: "armed", repeated: false });
}

/**
 * Turns 1 and 2 for an owner through the whole face under bundle v3: the JOIN asks S1-02 (its row composed and finalized
 * with `finalize`, then delivered), and "Plumbing" takes the one-kind path to S1-08's row and S1-09's question, both
 * played as delivered. Answers the version S1-09's question is open at.
 */
async function toS1_09(owner: Owner, finalize: boolean): Promise<number> {
  clock.now = NOW_1;
  clock.finalize = FINALIZED_1;
  const one = turnOne(owner);
  const first = await face.gateAndCommit(one, NOTHING_OPEN_AT, traceFor(one).trace);
  expect(first, JSON.stringify(first)).toMatchObject({
    result: "committed",
    turnId: owner.turn1,
    repeated: false,
  });
  const row1 = `outbox-s1-02-${owner.turn1}-1`;
  if (finalize) {
    const names = new Map<string, string>([
      ...samNames(owner),
      ["turn-s1-01-sam", owner.turn1],
      ["trace-sam-0000", `trace-${owner.turn1}`],
      ["outbox-s1-02-sam-1", row1],
    ]);
    const compose = renamed(composeS102().request, names);
    expect(await face.composeInput(structuredClone(compose), traceFor(compose).trace)).toMatchObject({
      result: "compose",
    });
    const request = renamed((fixture("finalize-pass.json") as { request: Json }).request, names);
    const finalized = (await face.finalizeMessage(
      structuredClone(request),
      traceFor(request).trace,
    )) as unknown as Finalized;
    expect(finalized.outcome, JSON.stringify(finalized)).toBe("send");
  }
  await deliver(row1, `oq-s1-02-${owner.turn1}-1`, { sent: SENT_1, delivered: DELIVERED_1 });

  clock.now = NOW_2;
  const two = turnTwo(owner);
  const second = await face.gateAndCommit(two, NOTHING_OPEN_AT, traceFor(two).trace);
  expect(second, JSON.stringify(second)).toMatchObject({
    result: "committed",
    turnId: owner.turn2,
    repeated: false,
  });
  const rows = turnTwoRows(owner);
  expect((second as unknown as Committed).written.outboxRows.map((row) => row.id)).toEqual([
    rows.plan,
    rows.asked,
  ]);
  await deliver(rows.plan, null, { sent: SENT_2, delivered: DELIVERED_2 });
  await deliver(rows.asked, rows.question, { sent: SENT_2, delivered: DELIVERED_2 });
  const question = await questionRow(rows.question);
  expect(question).toMatchObject({ status: "open", step: "S1-09", ask_count: 1 });
  return question?.version ?? 0;
}

/**
 * The frontier's context for an owner's text `words` to S1-09's question under the turn id `turnId` (buildFrontier
 * through the face, as staging's frontier gives decide its options: K-09 build-frontier-s1-04.json's request as the owner
 * sends it, pinned to bundle v3).
 */
async function frontierFor(owner: Owner, turnId: string, words: string, at: { text: string; now: string }) {
  const base = (fixture("build-frontier-s1-04.json") as { request: Json }).request;
  const request = renamed(
    base,
    new Map<string, string>([
      ...samNames(owner),
      ["turn-s1-04-sam", turnId],
      ["trace-sam-0002", `trace-${turnId}`],
      ["evt-sam-0002", `evt-${turnId}`],
      ["oq-s1-04-sam", turnTwoRows(owner).question],
    ]),
  ) as Json & { turn: Json; texts: Json[]; now: string };
  request.turn.bundleId = { ...V3 };
  const [text] = request.texts;
  if (text === undefined) throw new Error("build-frontier-s1-04.json carries its text");
  text.words = words;
  text.sentAt = { utc: at.text, zone: "America/New_York" };
  request.now = at.now;
  const answer = (await face.buildFrontier(
    structuredClone(request),
    traceFor(request).trace,
  )) as unknown as Json & {
    context: Json & {
      choices: (Json & { choiceId: string; branch: string; question: string; stakes: string })[];
    };
  };
  expect(answer, JSON.stringify(answer)).toHaveProperty("context");
  expect(validator.check("buildFrontier", "response", answer)).toEqual([]);
  return answer.context;
}

/**
 * Turn 3 for an owner: commit-s1-04.json's request as the owner sends it under the turn id `turnId`, pinned to bundle v3,
 * its context the frontier's for `words`, its one part choosing S1-09's option of `branch` with the `business` field's
 * words `details` (left out when null: default 200), in decide's agreed parts and both reads.
 */
async function turnThree(
  owner: Owner,
  turnId: string,
  words: string,
  branch: string,
  details: string | null,
  at: { text: string; now: string } = { text: TEXT_3, now: NOW_3 },
): Promise<GateAndCommitRequest> {
  const context = await frontierFor(owner, turnId, words, at);
  const question = turnTwoRows(owner).question;
  const offered = context.choices.filter((choice) => choice.question === question);
  expect(offered.map((choice) => choice.branch)).toEqual([
    OWNER_MATCHES,
    HELPS_RUN_IT,
    "No match, or already listed",
  ]);
  const chosen = offered.find((choice) => choice.branch === branch);
  if (chosen === undefined) throw new Error(`the frontier offers ${branch}`);
  const base = (fixture("commit-s1-04.json") as { request: GateAndCommitRequest }).request;
  const request = renamed(
    base,
    new Map<string, string>([
      ...rosterNames(owner),
      ["turn-s1-04-roster", turnId],
      ["trace-roster-0002", `trace-${turnId}`],
      ["evt-roster-0002", `evt-${turnId}`],
      ["oq-s1-04-roster-1", question],
    ]),
  );
  if (request.turn === null) throw new Error("commit-s1-04.json carries its turn");
  request.turn.bundleId = { ...V3 };
  const decided = decidedOf(request);
  const part = {
    verb: "choose",
    quote: words,
    question,
    choice: chosen.choiceId,
    fields: details === null ? [] : [{ name: "business", value: details, words: details }],
  } as DecidePart;
  const decide = decided.decide as unknown as Json & { reads: Json[]; parts: Json[] };
  decide.bundleId = { ...V3 };
  decide.stakes = chosen.stakes;
  decide.reads = decide.reads.map((read) => ({
    ...read,
    output: { language: "en", parts: [structuredClone(part)] },
  }));
  decide.parts = [{ part: structuredClone(part), outcome: "go" }];
  (decided as unknown as { context: Json }).context = structuredClone(context);
  request.now = at.now;
  return request;
}

/** Turn 3 through `through` (the whole face unless named): its answer. */
async function answer(request: GateAndCommitRequest, through: TurnFace = face) {
  return through.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
}

/** Compose input for one of a turn's rows: its answer, held to K-09's response. */
async function composed(owner: Owner, turnId: string, outboxRowId: string) {
  const compose = { caller: callerOf(owner, turnId), outboxRowId };
  const got = (await face.composeInput(structuredClone(compose), traceFor(compose).trace)) as unknown as {
    result: string;
    input: Json & { masterText: { step: string; text: string }; allowedLinks: string[]; facts: Json[] };
  };
  expect(got, JSON.stringify(got)).toMatchObject({ result: "compose" });
  expect(validator.check("composeInput", "response", got)).toEqual([]);
  return got.input;
}

/** finalizeMessage for one of a turn's rows with `lines` as its plan: what it answers, held to K-09's response. */
async function finalized(
  owner: Owner,
  turnId: string,
  outboxRowId: string,
  lines: readonly { role: string; text: string }[],
): Promise<Finalized> {
  clock.finalize = FINALIZED_3;
  const request = {
    caller: callerOf(owner, turnId),
    outboxRowId,
    expectVersion: 1,
    attempt: "composed",
    plan: {
      row: outboxRowId,
      channel: "imessage",
      copyOf: null,
      plan: { formats: ["text"], lines, question: null, pageType: null, threadReplyTo: null },
    },
  };
  const got = (await face.finalizeMessage(
    structuredClone(request),
    traceFor(request).trace,
  )) as unknown as Finalized;
  expect(got.outcome, JSON.stringify(got)).toBe("send");
  expect(validator.check("finalizeMessage", "response", got)).toEqual([]);
  expect(got.finalParts.row).toBe(outboxRowId);
  return got;
}

/** The plain sha256 of a code, as the link row must hold it. */
const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const codeOf = (link: string): string => link.slice(link.lastIndexOf("/") + 1);

/** A turn's outbox rows as the owner reads them, in commit order: step, line, question and state. */
async function outboxOf(turnId: string): Promise<Json[]> {
  return cdb.db.sql<Json[]>`
    select id, step, line_no, open_question_id, send_class, recipient_handle_id, recipient_person_id, business_id,
           bundle_hash, bundle_build, state
    from outbox_rows where turn_id = ${turnId} order by commit_seq
  `;
}

/** S1-10's rows and the owner's, as the commit is to write them (the owner's own handle, person and business). */
const toOwner = (owner: Owner, id: string, step: string, line: number): Json => ({
  id,
  step,
  line_no: line,
  open_question_id: null,
  send_class: "quick_reply",
  recipient_handle_id: owner.handle,
  recipient_person_id: owner.person,
  business_id: owner.business,
  bundle_hash: V3.hash,
  bundle_build: V3.build,
  state: "planned",
});

// ---- owner 1: the demo listing, the whole path ----------------------------------------------------------------------------

describe("the owner's reply to S1-09 on bundle v3: 'Lee's Barbershop in Springfield, I'm the owner' is one commit that writes S1-09's rows and S1-10's, and the walk waits (T-1537)", () => {
  const turnId = FIRST.turn3;
  const rows = rowIds(turnId);
  let openAt = 0;
  let request: GateAndCommitRequest;

  it(
    "turns 1 and 2: the JOIN asks S1-02, 'Plumbing' takes the one-kind path to S1-08's row and S1-09's question, open at its version",
    SLOW,
    async () => {
      const [asApp] = await app<{ role: string }[]>`select current_user as role`;
      const [asJob] = await job<{ role: string }[]>`select current_user as role`;
      expect([asApp?.role, asJob?.role]).toEqual([TOOL_API_ROLE, RUNTIME_ROLE]);
      openAt = await toS1_09(FIRST, true);
      expect(openAt).toBe(2);
    },
  );

  it(
    "with the listing deps left out (today's binding), the reply is refused (notBuilt) with nothing written and S1-09's question left open",
    SLOW,
    async () => {
      const before = await everything();
      clock.now = NOW_3;
      const today = await turnThree(FIRST, `${turnId}-today`, RULING_WORDS, OWNER_MATCHES, RULING_WORDS);
      expect(await answer(today, todayFace)).toEqual({ error: "notBuilt", call: "gateAndCommit" });
      expect(await footprint(cdb, `${turnId}-today`)).toEqual(NO_FOOTPRINT);
      expect(await everything()).toEqual(before);
      expect(await questionRow(turnTwoRows(FIRST).question)).toMatchObject({
        status: "open",
        version: openAt,
      });
      expect(links.size).toBe(0);
      expect(links.stagedTurns).toBe(0);
    },
  );

  it(
    "through the whole binding it is one commit: oq-s1-09 closed, the typed name, the read-back row, the accounts row, one page_links row (sha256 only), S1-10's row; no question, no clock; a replay writes nothing and holds no new link",
    SLOW,
    async () => {
      const appBefore = sent.app.length;
      const jobBefore = sent.job.length;
      const signUpBefore = await signUpRows();
      const headBefore = await headOf(FIRST);
      clock.now = NOW_3;
      request = await turnThree(FIRST, turnId, RULING_WORDS, OWNER_MATCHES, RULING_WORDS);
      const got = await answer(request);
      expect(got, JSON.stringify(got)).toMatchObject({ result: "committed", turnId, repeated: false });
      expect(validator.check("gateAndCommit", "response", got)).toEqual([]);
      const committed = got as unknown as Committed;
      expect(committed.parts).toEqual([
        expect.objectContaining({ part: 0, result: "committed", gives: ["business", "mobile"] }),
      ]);
      const question = turnTwoRows(FIRST).question;
      expect(committed.openQuestions).toEqual({ opened: [], closed: [question] });
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rows.readBack, rows.s1_10]);
      expect(committed.written.written.map((row) => row.table).sort()).toEqual(
        ["accounts", "businesses", "open_questions", "page_links"].sort(),
      );

      // S1-09's question answered; no question opened and no clock row made by the turn: the walk waits at S1-10.
      expect(await questionRow(question)).toMatchObject({
        status: "answered",
        version: openAt + 1,
        step: "S1-09",
      });
      expect(await footprint(cdb, turnId)).toMatchObject({
        turns: 1,
        outbox: 2,
        questions: 0,
        clocks: 0,
        effects: 0,
      });
      // The typed name, its four marks folded (default 202); the stand-in head's status as it was (S1-09 writes none).
      expect(await headOf(FIRST)).toEqual({ ...headBefore, name: DEMO_NAME, display_name: DEMO_NAME });
      // The roster seed's setup row was on file, so S1-09's writer wrote none; no review item on a match.
      expect(await signUpRows()).toEqual({ ...signUpBefore, accounts: 1, page_links: 1 });
      const { sql } = cdb.db;
      expect(await sql<Json[]>`select person_id, mobile, mobile_proven_at, email from accounts`).toEqual([
        { person_id: FIRST.person, mobile: FIRST.number, mobile_proven_at: new Date(TEXT_3), email: null },
      ]);
      // The rows to the owner, in commit order: the read-back (S1-09, line 1), then S1-10's line 2, neither asking.
      expect(await outboxOf(turnId)).toEqual([
        toOwner(FIRST, rows.readBack, "S1-09", 1),
        toOwner(FIRST, rows.s1_10, "S1-10", 2),
      ]);

      // The link the face holds for S1-10's row; the row keeps its code's sha256 alone, and nothing stays staged.
      const link = links.of(rows.s1_10) ?? "";
      expect(link).toMatch(/^https:\/\/rosfield\.com\/test\/[0-9a-f]{32}$/u);
      expect(links.stagedTurns).toBe(0);
      const code = codeOf(link);
      const [pageLink] = await sql<Json[]>`select * from page_links`;
      expect(pageLink).toMatchObject({
        id: rows.link,
        business_id: FIRST.business,
        person_id: FIRST.person,
        purpose: "setup_id_check",
        step_id: "S1-10",
        code_sha256: await sha256(code),
        sent_to_handle_id: FIRST.handle,
        issued_at: new Date(NOW_3),
        expires_at: new Date("2026-10-26T18:09:06Z"),
        ended_at: null,
      });
      expect(JSON.stringify(pageLink)).not.toContain(code);
      expect(JSON.stringify(await sql<Json[]>`select plan, final_parts from outbox_rows`)).not.toContain(
        code,
      );

      // As rosie_app the turn sent no statement on a table that spans businesses, nor on accounts or page_links; item 79,
      // item 26 and the commit ran as rosie_job.
      const appStatements = sent.app.slice(appBefore);
      expect(appStatements.length).toBeGreaterThan(0);
      for (const text of appStatements) expect(text).not.toMatch(SPANS_BUSINESSES);
      const jobStatements = sent.job.slice(jobBefore);
      expect(jobStatements.some((text) => /\bpicked_kinds\b/u.test(text))).toBe(true);
      expect(jobStatements.some((text) => /\baccounts\b/u.test(text))).toBe(true);

      // A replay of the same turn writes nothing, and the first link stays the one held. Its answer is limit 1's, before
      // K-05's repeated answer is reached: S1-09's question is answered now and the walk waits at S1-10 with no question,
      // so no question is live on the handle and the sign-up sender is no longer its own record (limit-1 allowed.ts default
      // 14 (b)), so the unproven sender is refused (notBuilt: no T-322 codes) and the call fails closed (open gap 195).
      const written = await everything();
      const again = await answer(request);
      expect(again).toEqual({ error: "notBuilt", call: "gateAndCommit" });
      expect(await everything()).toEqual(written);
      expect(await footprint(cdb, turnId)).toMatchObject({ turns: 1, outbox: 2, questions: 0, clocks: 0 });
      expect(links.of(rows.s1_10)).toBe(link);
      expect(links.size).toBe(1);
      expect(links.stagedTurns).toBe(0);
    },
  );

  it(
    "compose input and finalize pass on both rows: the read-back names the typed name; S1-10's text carries https://rosfield.com/test/<code> and its last sentence, never the sample link; then the face lets the link go",
    SLOW,
    async () => {
      const link = links.of(rows.s1_10) ?? "";
      // The read-back: its master line to the owner, read by the sign-up line, no link allowed.
      const readBack = await composed(FIRST, turnId, rows.readBack);
      expect(readBack).toMatchObject({
        row: rows.readBack,
        turn: turnId,
        masterText: { step: "S1-09", text: READ_BACK_LINE },
        audience: { role: "owner" },
        allowedLinks: [],
      });
      const readBackSent = await finalized(FIRST, turnId, rows.readBack, [
        { role: "first", text: READ_BACK_LINE },
        { role: "fact", text: "{{biz.name}}" },
      ]);
      const readBackText = readBackSent.finalParts.sends.map((send) => send.text).join("\n");
      expect(readBackText).toContain(READ_BACK_LINE);
      expect(readBackText).toContain(DEMO_NAME);
      expect(readBackText).not.toContain("rosfield.com");

      // S1-10's line 2: link.secure allowed on this row alone; the link never a fact the composer reads.
      const s1_10 = await composed(FIRST, turnId, rows.s1_10);
      expect(s1_10).toMatchObject({
        row: rows.s1_10,
        masterText: { step: "S1-10", text: S1_10_LINE },
        allowedLinks: ["link.secure"],
      });
      expect(JSON.stringify(s1_10.facts)).not.toContain("rosfield.com");
      const s1_10Sent = await finalized(FIRST, turnId, rows.s1_10, [
        {
          role: "first",
          text: "This is Rosie, an automated assistant, setting up {{biz.name}}. Your secure ID upload is below: {{link.secure}}",
        },
        { role: "fact", text: LAST_SENTENCE },
      ]);
      const s1_10Text = s1_10Sent.finalParts.sends.map((send) => send.text).join("\n");
      expect(s1_10Text).toContain(`setting up ${DEMO_NAME}. Your secure ID upload is below: ${link}`);
      expect(s1_10Text).toContain(LAST_SENTENCE);
      expect(s1_10Text).not.toContain(SAMPLE_LINK);
      // Sent: the face lets the row's link go.
      expect(links.of(rows.s1_10)).toBeNull();
      for (const text of sent.app) expect(text).not.toMatch(SPANS_BUSINESSES);
    },
  );

  it("claimOutbox takes the read-back, then S1-10's row, in commit order", SLOW, async () => {
    const claimed = await claimOutbox(job, {
      claimer: "dispatcher-t1537",
      recipientHandleId: FIRST.handle,
      now: CLAIMED_AT,
      limit: 5,
    });
    if (!("claimed" in claimed)) throw new Error(`claimOutbox answered ${JSON.stringify(claimed)}`);
    expect(claimed.claimed.map((row) => row.outboxRowId)).toEqual([rows.readBack, rows.s1_10]);
    expect(claimed.claimed[0]?.commitSeq).toBeLessThan(claimed.claimed[1]?.commitSeq ?? 0);
  });
});

// ---- owner 2: the same words with an iPhone's curly apostrophes ------------------------------------------------------------

describe("the same reply typed with an iPhone's curly apostrophes writes the same rows (default 202's fold; T-1537)", () => {
  it(
    "oq-s1-09 closed, the typed name with plain apostrophes, the read-back and S1-10's rows, one accounts row and one link row more",
    SLOW,
    async () => {
      await toS1_09(SECOND, false);
      const turnId = SECOND.turn3;
      const rows = rowIds(turnId);
      const before = await signUpRows();
      clock.now = NOW_3;
      const got = await answer(
        await turnThree(SECOND, turnId, RULING_WORDS_CURLY, OWNER_MATCHES, RULING_WORDS_CURLY),
      );
      expect(got, JSON.stringify(got)).toMatchObject({ result: "committed", turnId, repeated: false });
      expect((got as unknown as Committed).openQuestions).toEqual({
        opened: [],
        closed: [turnTwoRows(SECOND).question],
      });
      expect(await headOf(SECOND)).toMatchObject({ name: DEMO_NAME, display_name: DEMO_NAME });
      expect(await outboxOf(turnId)).toEqual([
        toOwner(SECOND, rows.readBack, "S1-09", 1),
        toOwner(SECOND, rows.s1_10, "S1-10", 2),
      ]);
      expect(await signUpRows()).toEqual({
        ...before,
        accounts: Number(before.accounts) + 1,
        page_links: Number(before.page_links) + 1,
      });
      expect(links.of(rows.s1_10)).toMatch(/^https:\/\/rosfield\.com\/test\/[0-9a-f]{32}$/u);
      expect(await footprint(cdb, turnId)).toMatchObject({ outbox: 2, questions: 0, clocks: 0 });
    },
  );
});

// ---- owner 3: a real-looking name and town ----------------------------------------------------------------------------------

describe("a real-looking name and town takes S1-76 first: its row, one review item, then S1-10's row (T-1537; defaults 203 (b) and 205)", () => {
  it(
    "S1-76's row and one listing_match item (Claim: owner. Reason: no listing.), the typed name, then S1-10's rows; no read-back; S1-76's row composed and finalized",
    SLOW,
    async () => {
      await toS1_09(THIRD, false);
      const turnId = THIRD.turn3;
      const rows = rowIds(turnId);
      const before = await signUpRows();
      clock.now = NOW_3;
      const got = await answer(await turnThree(THIRD, turnId, MADE_UP_WORDS, OWNER_MATCHES, MADE_UP_WORDS));
      expect(got, JSON.stringify(got)).toMatchObject({ result: "committed", turnId, repeated: false });
      const committed = got as unknown as Committed;
      expect(committed.parts).toEqual([
        expect.objectContaining({ part: 0, result: "committed", gives: ["business", "mobile"] }),
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rows.s1_76, rows.s1_10]);
      expect(await headOf(THIRD)).toMatchObject({ name: MADE_UP_NAME, display_name: MADE_UP_NAME });
      expect(await outboxOf(turnId)).toEqual([
        toOwner(THIRD, rows.s1_76, "S1-76", 0),
        toOwner(THIRD, rows.s1_10, "S1-10", 2),
      ]);
      expect(
        await cdb.db.sql<Json[]>`
        select kind, business_id, subject_table, subject_row_id, raised_by_person_id, summary, state, version
        from review_items where turn_id = ${turnId}
      `,
      ).toEqual([
        {
          kind: "listing_match",
          business_id: THIRD.business,
          subject_table: "businesses",
          subject_row_id: THIRD.business,
          raised_by_person_id: THIRD.person,
          summary: listingSummaryOf("owner", "noListing"),
          state: "open",
          version: 1,
        },
      ]);
      expect(await signUpRows()).toEqual({
        ...before,
        accounts: Number(before.accounts) + 1,
        page_links: Number(before.page_links) + 1,
        review_items: Number(before.review_items) + 1,
      });
      expect(await footprint(cdb, turnId)).toMatchObject({ outbox: 2, questions: 0, clocks: 0 });

      // S1-76's row: its master line, composed and finalized; it names no one and no listing.
      const input = await composed(THIRD, turnId, rows.s1_76);
      expect(input).toMatchObject({ masterText: { step: "S1-76", text: S1_76_LINE }, allowedLinks: [] });
      const sentText = (
        await finalized(THIRD, turnId, rows.s1_76, [{ role: "first", text: S1_76_LINE }])
      ).finalParts.sends
        .map((send) => send.text)
        .join("\n");
      expect(sentText).toContain(S1_76_LINE);
      expect(sentText).not.toContain(MADE_UP_NAME);
    },
  );
});

// ---- owners 4 and 6: the claim alone, and a name with no town ---------------------------------------------------------------

describe("'I'm the owner' alone, and a name with no town: S1-09 is sent again once, and a second time nothing is sent (T-1528; default 203 (a) and (c))", () => {
  for (const [owner, words, details] of [
    [FOURTH, CLAIM_ALONE, null],
    [SIXTH, NO_TOWN, NO_TOWN],
  ] as const) {
    it(
      `"${words}": the part asked, one quick reply that sends S1-09's question again (ask_count 1 to 2), nothing else written; the second time no row and no raise`,
      SLOW,
      async () => {
        const openAt = await toS1_09(owner, false);
        const question = turnTwoRows(owner).question;
        const before = await everything();
        const headBefore = await headOf(owner);
        const turnId = owner.turn3;
        clock.now = NOW_3;
        const got = await answer(await turnThree(owner, turnId, words, OWNER_MATCHES, details));
        expect(got, JSON.stringify(got)).toMatchObject({ result: "committed", turnId, repeated: false });
        const committed = got as unknown as Committed;
        expect(committed.parts).toEqual([expect.objectContaining({ part: 0, result: "asked", gives: [] })]);
        expect(committed.openQuestions).toEqual({ opened: [], closed: [] });
        expect(committed.written.written).toEqual([
          { table: "open_questions", rowId: question, version: openAt + 1 },
        ]);
        expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rowIds(turnId).asked]);
        expect(await questionRow(question)).toEqual({
          status: "open",
          version: openAt + 1,
          step: "S1-09",
          ask_count: 2,
        });
        // The row as T-1505's re-send writes it: it asks S1-09's question, so its line is the question's (K-05 v1.22 item
        // 83, `from` openQuestion), with no step or line of its own.
        expect(await outboxOf(turnId)).toEqual([
          {
            ...toOwner(owner, rowIds(turnId).asked, "S1-09", 0),
            open_question_id: question,
            step: null,
            line_no: null,
          },
        ]);
        expect(await signUpRows()).toEqual(before.signUp);
        expect(await headOf(owner)).toEqual(headBefore);
        expect(links.stagedTurns).toBe(0);

        // The second time: no row and no raise; the turn commits its text's safety outcome alone.
        const afterFirst = await everything();
        clock.now = NOW_4;
        const againId = `${turnId}-again`;
        const second = await answer(
          await turnThree(owner, againId, words, OWNER_MATCHES, details, { text: TEXT_4, now: NOW_4 }),
        );
        expect(second, JSON.stringify(second)).toMatchObject({
          result: "committed",
          turnId: againId,
          repeated: false,
        });
        expect((second as unknown as Committed).written.outboxRows).toEqual([]);
        expect(await questionRow(question)).toEqual({
          status: "open",
          version: openAt + 1,
          step: "S1-09",
          ask_count: 2,
        });
        expect(await footprint(cdb, againId)).toMatchObject({ outbox: 0, questions: 0, clocks: 0 });
        expect(await signUpRows()).toEqual(afterFirst.signUp);
      },
    );
  }
});

// ---- owner 5: a helper with a match ----------------------------------------------------------------------------------------

describe("a helper's words with the demo listing are refused (notBuilt: S1-77 tells and has no writer, default 214), nothing written (T-1537)", () => {
  it(
    "the reply refused with nothing written; S1-09's question left open; no link staged or held",
    SLOW,
    async () => {
      const openAt = await toS1_09(FIFTH, false);
      const before = await everything();
      const heldBefore = links.size;
      const turnId = FIFTH.turn3;
      clock.now = NOW_3;
      const got = await answer(await turnThree(FIFTH, turnId, HELPER_WORDS, HELPS_RUN_IT, HELPER_WORDS));
      expect(got).toEqual({ error: "notBuilt", call: "gateAndCommit" });
      expect(await footprint(cdb, turnId)).toEqual(NO_FOOTPRINT);
      expect(await everything()).toEqual(before);
      expect(await questionRow(turnTwoRows(FIFTH).question)).toMatchObject({
        status: "open",
        version: openAt,
      });
      expect(links.size).toBe(heldBefore);
      expect(links.stagedTurns).toBe(0);
    },
  );
});
