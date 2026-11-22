// T-1493's integration proof (H1a; Lead note 1, DL-1075; K-09 README default 199; DL-1033) on local PostgreSQL: `npm run
// db:up`, then `npm run test:integration -- actions/src/tool-api/turn-face/pg/one-kind.int.test.ts`. An owner who names
// one kind of work is never asked S1-04: "Plumbing" to S1-02's question is one commit that places the pick, writes S1-08's
// plan row and asks S1-09, and both rows are composed and finalized.
//
// The world (a fresh schema, migrated with every migration and dropped when the file ends: commit/pg/test-support.ts):
//   - K-24's catalog, the 243 trade-file kinds and their kind_flows as the kinds seed writes them from the trade files
//     (T-212's catalogPlanOf and insertCatalog), so the catalog by id (readTurnState's kinds/<id> and kind_flows <id>/A,
//     <id>/B) answers a listed kind's facts and switches;
//   - the roster-owner seed (db/seeds/roster-owner.ts, run as it is) for four numbers in the fiction range, so four owners,
//     each a person with no name and no role at a stand-in business head of their own that carries the skeleton demo
//     shop's name, with its company and the company's barber kind of work (the phone's own world, as
//     pg/sign-up.int.test.ts builds it for one);
//   - each person's sealing key, made as the gateway makes it at first sight, under a wrapping key made for this run alone;
//   - the registry row of bundle v2 as bundles/v2 holds it (T-1477), which every turn pins.
//
// Who runs what. The turn face is handed two clients of this file's own, each statement's text written down (never a
// value): `app`, whose connections run as rosie_app (2: the call's transaction, and item 78's and item 72's own reads
// beside it, one at a time), and `job`, as rosie_job. The gate, the walk's question read and readOpenHolds run on `app`,
// item 78 and item 72 in read-only transactions of their own beside the call's; K-05's commitTurn, item 79, the catalog by
// id (readTurnState), S1-08's stop reads, the sealer and the row reads on `job`. The schema owner's client only seeds the
// world, plays the sends and reads what the turns left.
//
// Real here: the Tool API base, the gate and limits 1 to 6, the commit, the walk (T-1461, T-1491, T-1479), the binding of
// T-1493 (pgTurnCalls with settleSignUp: signUpSteps over pgKindsReads, the trade port over bundle v2's own overlays,
// pgCompaniesReads and S1-08's stop reads), T-633's, T-634's, T-1492's and T-1482's code, T-632's matcher, runCore with
// the safety service, compose input and finalize (T-1483's term rule, and rows.ts's finalize terms from it), claimOutbox,
// every data-access call, row-level security and the two application roles. Given: the bundles as the frontier's fake
// over bundles/v2's own files; the decided texts, K-09's commit-s1-01.json and commit-s1-02.json as each owner sends them
// (no model is called); the plans, written from compose input's own master text and term facts as a composer would give
// them. The sends are played by one delivered part as pg/sign-up.int.test.ts plays one, then K-05's own armClock.
//
// The owners:
//   1. The whole path. Turn 1, the JOIN, asks S1-02; its row is composed, finalized (signUpOpener) and delivered. With
//      S1-08's stop reads left out (no S1-08 deps, or S1-08's deps with no stop reads), "Plumbing" is refused with nothing
//      written. Then "Plumbing" commits: oq-s1-02 closed, one listed pick under the roster company and its business, its
//      11 text blocks under that business, a plumbing company kind beside the barber one, S1-08's row (step S1-08, line 0,
//      no question), S1-09's question and its row, no S1-04 question, and no statement of rosie_app on a table that spans
//      businesses (so none could answer 42501). Both rows are composed and finalized: S1-08's input holds the four term
//      lines alone, and its plan states them and none of the withheld ones; neither text carries an opener a second time
//      (turn 1's mark) or names the stand-in business. claimOutbox takes S1-08's row, then S1-09's.
//   2. "Barbershop, plumbing, electrical" still opens S1-04 as today, with the one-kind path bound: three picks, none
//      placed, no company kind written, no S1-08 row.
//   3. and 4. Each of the two rows as the first text about the business (turn 1's reply played as delivered with no final
//      parts, so K-05's fixed-line facts read no text before): S1-08's row first for owner 3, S1-09's first for owner 4.
//      Each opens with signUpOpener (K-01 README default 19; default 199 item (6)), never the stand-in business's name.
//      For owner 3 the row after it carries no opener. For owner 4, S1-08's row after it was committed before S1-09's
//      and so goes first, and it opens with signUpOpener too (K-05 README default 215: an opener twice, the safe side).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  rowOf,
  snapshot,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { commitS1_02, decidedOf, turnTwoOnV1 } from "../../../commit/walk/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import { captureLog, checks, fakeBundles } from "../../../frontier/assemble/test-support";
import type { DecidePart } from "../../../gate/framework";
import { catalogDefaults } from "../../journey-1/companies/test-support";
import { pgKindsReads } from "../../journey-1/kinds";
import { PF_TEXT_KEYS } from "../../journey-1/plug-ins";
import { fixture, traceFor } from "../../test-support";
import { bundleV2Id, commitS101, composeS102, publishedBundleV2, tradesOverV2 } from "../calls-test-support";
import { NOTHING_OPEN_AT, type SignUpWriterDeps } from "../commit";
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

/** Bundle v2's id, which every turn pins. */
const V2 = bundleV2Id();

/** S1-02's own first words, bundle v2's signUpOpener (K-01 README default 19). */
const SIGN_UP_OPENER = "Hi! I'm Rosie, an automated assistant.";

/** Bundle v2's STOP, HELP and rates line in English (K-01 v1 lists.fixedLines), word for word as its manifest holds it. */
const OPT_OUT_LINE = ((): string => {
  const lists = publishedBundleV2().manifest.lists as
    { fixedLines?: { lines?: { id: string; lang: string; text: string | null }[] } } | undefined;
  const text = lists?.fixedLines?.lines?.find((line) => line.id === "optOutLine" && line.lang === "en")?.text;
  if (typeof text !== "string") throw new Error("bundle v2 holds no English optOutLine");
  return text;
})();

/** Bundle v2's flow A step `stepId`'s line from Rosie to the owner at `index` among those lines. */
function lineToOwner(stepId: string, index: number): string {
  const steps = (publishedBundleV2().flows.A as { steps: Record<string, { say: Json[] }> }).steps;
  const said = (steps[stepId]?.say ?? []).filter(
    (message) => message.from === "san" && message.to === "owner",
  );
  const text = said[index]?.text;
  if (typeof text !== "string")
    throw new Error(`bundle v2's ${stepId} has a line to the owner at ${String(index)}`);
  return text;
}

/** S1-08's line to the owner (MASTER-FLOW-A.md line 109), and S1-09's. */
const PLAN_LINE = lineToOwner("S1-08", 0);
const S1_09_LINE = lineToOwner("S1-09", 0);

/** S1-08's four term lines (K-09 README default 186: lines 1, 2, 6 and 7 of its card), in the card's order. */
const PLAN_TERMS = [
  "Your business and your ID: about 3 minutes",
  "Any license or document you want shown (optional)",
  "Then your people",
  "Nothing you tell me is asked twice",
];

/** S1-08's card lines that are never terms: the sample story's two, and the sample company's slotted one. */
const WITHHELD = [
  "No extra agreement for your work",
  "Then the barbershop, live in about 15 minutes",
  "Then {{biz.name}}: plumbing, then electrical, about 5 minutes each",
];

/** The moments: turn 1's commit, its row's finalize, send and delivery; then turn 2's text, commit, finalize and claim. */
const NOW_1 = "2026-10-19T18:05:05Z";
const FINALIZED_1 = "2026-10-19T18:05:07Z";
const SENT_1 = "2026-10-19T18:05:08Z";
const DELIVERED_1 = "2026-10-19T18:05:09Z";
const TEXT_2 = "2026-10-19T18:07:00Z";
const NOW_2 = "2026-10-19T18:07:06Z";
const FINALIZED_2 = "2026-10-19T18:07:08Z";
const CLAIMED_AT = "2026-10-19T18:07:10Z";

/** The owners' words: one listed kind, and commit-s1-02.json's three. */
const PLUMBING = "Plumbing";
const THREE_KINDS = "Barbershop, plumbing, electrical";

// ---- the owners (db/seeds/roster-owner.ts, places 1 to 4) ----------------------------------------------------------------

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
  readonly trace1: string;
  readonly question1: string;
  readonly row1: string;
  readonly turn2: string;
  readonly trace2: string;
}

/** Places 1 to 4's numbers, each written whole, so the phone scan (T-1317) reads each as a fiction-range number. */
const OWNER_NUMBERS: readonly string[] = ["+15555550181", "+15555550182", "+15555550183", "+15555550184"];

/** The number of the owner at `place` (1 to 4). */
function numberAt(place: number): string {
  const number = OWNER_NUMBERS[place - 1];
  if (number === undefined) throw new Error(`no owner number at place ${String(place)}`);
  return number;
}

function ownerAt(place: number): Owner {
  const ids = rosterOwnerIds(place);
  const n = String(place);
  const turn1 = `turn-s1-01-one-kind-${n}`;
  return {
    place,
    number: numberAt(place),
    business: ids.businessId,
    company: ids.companyId,
    person: ids.personId,
    handle: ids.handleId,
    chat: `linq-chat-demo-one-kind-${n}`,
    turn1,
    trace1: `trace-one-kind-${n}-0000`,
    question1: `oq-s1-02-${turn1}-1`,
    row1: `outbox-s1-02-${turn1}-1`,
    turn2: `turn-s1-02-one-kind-${n}`,
    trace2: `trace-one-kind-${n}-0001`,
  };
}

const OWNERS = [ownerAt(1), ownerAt(2), ownerAt(3), ownerAt(4)] as const;
const [FIRST, SECOND, THIRD, FOURTH] = OWNERS;

/** The rows turn 2 writes for an owner, named from its turn id (default 131). */
function turnTwoRows(owner: Owner) {
  const key = owner.turn2;
  return {
    pick: `pick-s1-02-${key}-1`,
    plan: `outbox-s1-08-${key}-1`,
    question: `oq-s1-09-${key}-1`,
    clock: `clock-oq-s1-09-${key}-1`,
    asked: `outbox-s1-09-${key}-1`,
    s104Question: `oq-s1-04-${key}-1`,
    s104Row: `outbox-s1-04-${key}-1`,
  };
}

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
const ownerNames = (owner: Owner): [string, string][] => [
  ["biz-lees-barbershop", owner.business],
  ["person-sam", owner.person],
  ["handle-sam", owner.handle],
  ["+15555550100", owner.number],
  ["linq-chat-demo-sam", owner.chat],
];

/** Turn 1's names: the owner's, its turn, trace, event and row. */
const turnOneNames = (owner: Owner): Map<string, string> =>
  new Map<string, string>([
    ...ownerNames(owner),
    ["turn-s1-01-sam", owner.turn1],
    ["trace-sam-0000", owner.trace1],
    ["evt-sam-s1-01", `evt-${owner.turn1}`],
    ["outbox-s1-02-sam-1", owner.row1],
  ]);

/** Turn 1: commit-s1-01.json's request as the owner sends it, pinned to bundle v2. */
function turnOne(owner: Owner): GateAndCommitRequest {
  const request = renamed(commitS101().request, turnOneNames(owner));
  if (request.turn === null || request.input.kind !== "decided") throw new Error("turn 1 is a decided turn");
  const { decided } = request.input;
  request.turn.bundleId = { ...V2 };
  decided.context.bundleId = { ...V2 };
  decided.decide.bundleId = { ...V2 };
  decided.context.writer.people = [structuredClone(writerOf(owner))];
  return request;
}

/**
 * Turn 2: commit-s1-02.json's request as the owner sends it (T-1461's turnTwoOnV1), pinned to bundle v2, under the turn id
 * `turnId`, answering S1-02's question as turn 1 stored it, its one part choosing "All on the list" (c-01) in decide's
 * agreed parts and both reads, with `words` as the text, the part's quote and its kinds field.
 */
function turnTwo(owner: Owner, turnId: string, words: string): GateAndCommitRequest {
  const base = turnTwoOnV1("c-01").exchange.request;
  const change = (part: DecidePart): void => {
    if (part.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
    part.choice = "c-01";
    part.quote = words;
    for (const field of part.fields) {
      if (field.name === "kinds") {
        field.value = words;
        field.words = words;
      }
    }
  };
  const given = decidedOf(base);
  for (const entry of given.decide.parts) change(entry.part);
  for (const read of given.decide.reads) for (const part of read.output.parts) change(part);
  given.context.texts[0].words = words;

  const request = renamed(
    base,
    new Map<string, string>([
      ...ownerNames(owner),
      ["turn-s1-02-sam-kinds", turnId],
      ["trace-sam-0001", owner.trace2],
      ["evt-sam-0001", `evt-${turnId}`],
      ["oq-s1-02", owner.question1],
    ]),
  );
  const { context, decide } = decidedOf(request);
  if (request.turn === null) throw new Error("turn 2 carries its turn");
  request.turn.bundleId = { ...V2 };
  context.bundleId = { ...V2 };
  decide.bundleId = { ...V2 };
  context.writer.people = [structuredClone(writerOf(owner))];
  // The times, after turn 1's: the text, the question it answers as it went out, and the commit.
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

/** Which of T-1493's deps a face's binding hands in beside T-1468's and T-1502's. */
interface FaceGiven {
  /** S1-08's deps: with the stop reads, with none, or left out. */
  readonly plan: "withStop" | "noStop" | "leftOut";
}

/** The faces: the whole binding, and the two with S1-08's stop reads left out. */
let face: TurnFace;
let noPlanFace: TurnFace;
let noStopFace: TurnFace;
const trades = tradesOverV2();

/** A face over this world's two clients with T-1493's binding (the top of this file), S1-08's deps as `given` says. */
function faceOf(given: FaceGiven): TurnFace {
  const bundles = fakeBundles(publishedBundleV2());
  const signUp: SignUpWriterDeps<Tx> = {
    kinds: { reads: pgKindsReads(app, job) },
    plugIns: { bundles: trades.bundles },
    companies: pgCompaniesReads(app, job),
    ...(given.plan === "leftOut"
      ? {}
      : { plan: given.plan === "withStop" ? { stop: pgStopReads(job) } : {} }),
  };
  return pgTurnFace(job, {
    bundles,
    validator,
    checker,
    log: captureLog().sink,
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
  cdb = await openCommitDatabase("turn_face_one_kind", JOB_POOL);
  const { sql } = cdb.db;
  // The registry row: bundle v2, which every turn pins.
  await sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${V2.hash}, ${V2.build}, ${`bundle/${V2.hash}/${String(V2.build)}/manifest`}, '2026-11-20T10:00:00Z')
  `;
  // K-24's catalog: the 243 trade-file kinds and their kind_flows, as the kinds seed writes them (T-212).
  const { rows } = catalogPlanOf(verifyTradeSet(openTradeSet()));
  await sql.begin(async (tx) => {
    await insertCatalog(tx, rows);
  });
  // The roster-owner seed, as it is, for four numbers: its own transaction as rosie_job.
  const seeded = await seedRosterOwner(sql, {
    env: { [ALLOWLIST_VARIABLE]: OWNERS.map((owner) => owner.number).join(",") },
  });
  expect(seeded.ranAs).toBe(RUNTIME_ROLE);
  expect(seeded.owners).toEqual(
    OWNERS.map((owner) => ({
      place: owner.place,
      handleId: owner.handle,
      personId: owner.person,
      businessId: owner.business,
      companyId: owner.company,
    })),
  );
  // Each person's key, made as the gateway makes it at the first sight of the number (K-05 v1.2 item 29).
  for (const owner of OWNERS) {
    const sighted = await handleSealingKey(cdb.runtime, KEYS, {
      handle: { kind: "phone", address: owner.number },
      newHandleId: `handle-t1493-unused-${String(owner.place)}`,
      newPersonId: `person-t1493-unused-${String(owner.place)}`,
      wrappingKeyName: "SEALING_WRAP_KEY",
    });
    if (!("result" in sighted.outcome) || sighted.outcome.personId !== owner.person) {
      throw new Error("first sight did not give the roster owner's key");
    }
  }
  app = cdb.client(TOOL_API_ROLE, "rosie-turn-face-one-kind-app", APP_POOL, (text) => {
    sent.app.push(text.trim());
  });
  job = cdb.client(RUNTIME_ROLE, "rosie-turn-face-one-kind-job", JOB_POOL, (text) => {
    sent.job.push(text.trim());
  });
  face = faceOf({ plan: "withStop" });
  noPlanFace = faceOf({ plan: "leftOut" });
  noStopFace = faceOf({ plan: "noStop" });
}, 240_000);

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), job.end({ timeout: 5 })]);
  await cdb.close();
});

// ---- what the turns left ------------------------------------------------------------------------------------------------

/** One open question's status, version and step, as the owner reads its row. */
async function questionRow(
  id: string,
): Promise<{ status: string; version: number; step: string } | undefined> {
  const [row] = await cdb.db.sql<{ status: string; version: number; step: string }[]>`
    select status, version, step from open_questions where id = ${id}
  `;
  return row;
}

/** How many rows each of K-24's kinds tables, K-23's company kinds and K-37's review items hold. */
interface KindsCounts {
  readonly kinds: number;
  readonly picked_kinds: number;
  readonly picked_kind_texts: number;
  readonly new_work_drafts: number;
  readonly company_kinds: number;
  readonly review_items: number;
}

/** The rows of the kinds tables and the company kinds, as the owner reads them. */
async function kindsRows(): Promise<KindsCounts> {
  const [row] = await cdb.db.sql<KindsCounts[]>`
    select (select count(*)::int from kinds) as kinds,
           (select count(*)::int from picked_kinds) as picked_kinds,
           (select count(*)::int from picked_kind_texts) as picked_kind_texts,
           (select count(*)::int from new_work_drafts) as new_work_drafts,
           (select count(*)::int from company_kinds) as company_kinds,
           (select count(*)::int from review_items) as review_items
  `;
  if (row === undefined) throw new Error("kindsRows: no row");
  return row;
}

/** A statement that reads a table that spans businesses, which rosie_app holds no grant on (0012). */
const SPANS_BUSINESSES = /\b(from|join)\s+(handles|persons|phones|person_handles|turns)\b/u;

/** The caller of a call the turn `turnId` makes after its commit. */
const callerOf = (owner: Owner, turnId: string, traceId: string): Json => ({
  kind: "turn",
  turnId,
  requestId: turnId,
  businessId: owner.business,
  personId: owner.person,
  traceId,
});

/** What finalize answers when it sends: its outcome and the final parts it wrote. */
interface Finalized extends Json {
  outcome: string;
  finalParts: {
    row: string;
    fixedLines: string[];
    sends: { kind: string; text: string; options: unknown[] }[];
  };
}

/** The stand-in name the roster-owner seed gives a business head (the skeleton demo shop's), as the owner reads it. */
async function standInName(owner: Owner): Promise<string> {
  const [row] = await cdb.db.sql<
    { name: string }[]
  >`select name from businesses where id = ${owner.business}`;
  if (row === undefined || row.name.trim() === "") {
    throw new Error("the roster-owner seed names its business head");
  }
  return row.name;
}

/**
 * Turn 1's send, played: one delivered part, as limit-1's sign-up test writes one, the row moved to delivered, then K-05's
 * own armClock at the receipt, on the runtime side. Answers the version S1-02's question is open at.
 */
async function deliverTurnOne(owner: Owner): Promise<number> {
  const { sql } = cdb.db;
  await sql`
    insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, linq_message_id,
                              state, sent_at, delivered_at)
    values (${owner.row1}, 1, 1, ${`${owner.row1}/1/1`}, 1, 'words', ${`linq-msg-one-kind-${String(owner.place)}-0001`},
            'delivered', ${SENT_1}, ${DELIVERED_1})
  `;
  await sql`update outbox_rows set state = 'delivered', version = version + 1 where id = ${owner.row1}`;
  const armed = await armClock(job, {
    openQuestionId: owner.question1,
    deliveredAt: DELIVERED_1,
    dueAt: "2026-10-20T18:05:09Z",
    dueZone: "America/New_York",
  });
  expect(armed).toMatchObject({ result: "armed", repeated: false });
  const question = await questionRow(owner.question1);
  expect(question).toEqual({ status: "open", version: 2, step: "S1-02" });
  return question?.version ?? 0;
}

/**
 * Turn 1 for an owner, the JOIN through the face under bundle v2's id: S1-02's question opened. With `finalize`, its row
 * is composed and finalized first (opening with signUpOpener, never the stand-in name), so its writePlan writes the
 * opener mark; without, the reply is played as delivered with no final parts, so nothing marks a text about the
 * business. Then the send is played. Answers the version S1-02's question is open at.
 */
async function join(owner: Owner, finalize: boolean): Promise<number> {
  clock.now = NOW_1;
  clock.finalize = FINALIZED_1;
  const request = turnOne(owner);
  const first = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  expect(first, JSON.stringify(first)).toMatchObject({
    result: "committed",
    turnId: owner.turn1,
    repeated: false,
    parts: commitS101().outcome.parts,
    openQuestions: { opened: [owner.question1], closed: [] },
  });
  expect(await questionRow(owner.question1)).toEqual({ status: "waiting", version: 1, step: "S1-02" });
  if (finalize) {
    const names = turnOneNames(owner);
    const compose = renamed(composeS102().request, names);
    const composed = await face.composeInput(structuredClone(compose), traceFor(compose).trace);
    expect(composed, JSON.stringify(composed)).toMatchObject({
      result: "compose",
      input: { row: owner.row1, turn: owner.turn1, masterText: { step: "S1-02" } },
    });
    const request1 = renamed((fixture("finalize-pass.json") as { request: Json }).request, names);
    const finalized = (await face.finalizeMessage(
      structuredClone(request1),
      traceFor(request1).trace,
    )) as unknown as Finalized;
    expect(finalized.outcome, JSON.stringify(finalized)).toBe("send");
    expect(finalized.finalParts.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
    const text = finalized.finalParts.sends[0]?.text ?? "";
    expect(text.startsWith(`${SIGN_UP_OPENER} `)).toBe(true);
    expect(text).not.toContain(await standInName(owner));
  }
  return deliverTurnOne(owner);
}

/** Turn 2 for an owner through `through` (the whole face unless named): its answer, held to K-09's response when committed. */
async function answer(owner: Owner, turnId: string, words: string, through: TurnFace = face) {
  clock.now = NOW_2;
  const request = turnTwo(owner, turnId, words);
  return { request, answer: await through.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace) };
}

/** K-09's committed answer, as the turn face gives it. */
interface Committed {
  readonly parts: Json[];
  readonly written: { written: Json[]; outboxRows: Json[]; promoted: Json[] };
  readonly openQuestions: { opened: string[]; closed: string[] };
}

/** Compose input for one of turn 2's rows: its answer, held to K-09's response. */
async function composed(owner: Owner, outboxRowId: string) {
  const compose = { caller: callerOf(owner, owner.turn2, owner.trace2), outboxRowId };
  const got = (await face.composeInput(structuredClone(compose), traceFor(compose).trace)) as unknown as {
    result: string;
    input: Json & {
      masterText: { step: string; text: string };
      facts: { value: string; source: string }[];
      audience: Json;
    };
  };
  expect(got, JSON.stringify(got)).toMatchObject({ result: "compose" });
  expect(validator.check("composeInput", "response", got)).toEqual([]);
  return got.input;
}

/** The plan a composer would give for S1-08's row: its master line, then the four term facts, each as compose gave it. */
const planOfS108 = (facts: readonly string[]): Json => ({
  formats: ["text"],
  lines: [{ role: "first", text: PLAN_LINE }, ...facts.map((text) => ({ role: "fact", text }))],
  question: null,
  pageType: null,
  threadReplyTo: null,
});

/** The plan a composer would give for S1-09's row: its master line's ask as the first line, its question as the question. */
const planOfS109 = (): Json => ({
  formats: ["text"],
  lines: [{ role: "first", text: "Send a photo of your business card, sign, website or Google listing." }],
  question: { text: "Are you an owner?", optionIds: [] },
  pageType: null,
  threadReplyTo: null,
});

/** finalizeMessage for one of turn 2's rows with `plan`: what it answers, held to K-09's response. */
async function finalized(owner: Owner, outboxRowId: string, plan: Json): Promise<Finalized> {
  clock.finalize = FINALIZED_2;
  const request = {
    caller: callerOf(owner, owner.turn2, owner.trace2),
    outboxRowId,
    expectVersion: 1,
    attempt: "composed",
    plan: { row: outboxRowId, channel: "imessage", copyOf: null, plan },
  };
  const got = (await face.finalizeMessage(
    structuredClone(request),
    traceFor(request).trace,
  )) as unknown as Finalized;
  expect(got.outcome, JSON.stringify(got)).toBe("send");
  expect(validator.check("finalizeMessage", "response", got)).toEqual([]);
  expect(got.finalParts.row).toBe(outboxRowId);
  expect(got.finalParts.sends).toHaveLength(1);
  return got;
}

// ---- owner 1: the whole path ----------------------------------------------------------------------------------------------

describe("an owner who names one kind of work is never asked S1-04: 'Plumbing' walks to S1-08's row and S1-09's question on local PostgreSQL (T-1493)", () => {
  /** S1-02's question's version once its first delivery receipt armed its clock: what turn 2 closes it at. */
  let openAt = 0;
  const rows = turnTwoRows(FIRST);

  it(
    "the two clients run as the Tool API's role and the runtime side's, and the four roster owners are seeded",
    SLOW,
    async () => {
      const [asApp] = await app<{ role: string }[]>`select current_user as role`;
      const [asJob] = await job<{ role: string }[]>`select current_user as role`;
      expect([asApp?.role, asJob?.role]).toEqual([TOOL_API_ROLE, RUNTIME_ROLE]);
      expect(await kindsRows()).toEqual({
        kinds: 243,
        picked_kinds: 0,
        picked_kind_texts: 0,
        new_work_drafts: 0,
        company_kinds: 4,
        review_items: 0,
      });
    },
  );

  it(
    "turn 1: JOIN under bundle v2's id asks S1-02; its row is composed, finalized with signUpOpener and delivered, and the question is open at version 2",
    SLOW,
    async () => {
      openAt = await join(FIRST, true);
    },
  );

  it(
    "with S1-08's stop reads left out, 'Plumbing' is refused with nothing written: no S1-08 deps (no writer at S1-08), or S1-08's deps with no stop reads (stopNotWired)",
    SLOW,
    async () => {
      const before = { core: await snapshot(cdb), kinds: await kindsRows() };
      for (const [turnId, through] of [
        [`${FIRST.turn2}-no-plan`, noPlanFace],
        [`${FIRST.turn2}-no-stop`, noStopFace],
      ] as const) {
        const { answer: refused } = await answer(FIRST, turnId, PLUMBING, through);
        expect(refused, turnId).toEqual({ error: "notBuilt", call: "gateAndCommit" });
        expect(await footprint(cdb, turnId), turnId).toEqual(NO_FOOTPRINT);
        expect(await questionRow(FIRST.question1), turnId).toEqual({
          status: "open",
          version: openAt,
          step: "S1-02",
        });
      }
      expect({ core: await snapshot(cdb), kinds: await kindsRows() }).toEqual(before);
    },
  );

  it(
    "'Plumbing' is one commit: S1-02's question closed, one listed pick placed under the roster company and its business, its 11 text blocks under that business, a plumbing company kind (barber kept), S1-08's row (S1-08, line 0, no question), S1-09's question and its row, no S1-04 question, no 42501; a replay writes nothing",
    SLOW,
    async () => {
      const before = await snapshot(cdb);
      const appBefore = sent.app.length;
      const tradesBefore = trades.reads.length;
      const { request, answer: got } = await answer(FIRST, FIRST.turn2, PLUMBING);
      expect(got, JSON.stringify(got)).toMatchObject({
        result: "committed",
        turnId: FIRST.turn2,
        repeated: false,
      });
      expect(validator.check("gateAndCommit", "response", got)).toEqual([]);
      const committed = got as unknown as Committed;
      // The part: committed, giving S1-02's kinds, S1-11's 11 pf keys, then S1-04's companies.
      expect(committed.parts).toEqual([
        expect.objectContaining({
          part: 0,
          choiceId: "c-01",
          result: "committed",
          gives: [...commitS1_02().given.stated.gives, "companies"],
        }),
      ]);

      // K-05's own answer: every row the commit wrote, each with its version after it.
      expect(committed.written.written).toEqual([
        { table: "company_kinds", rowId: `${FIRST.company}/plumber`, version: 1 },
        { table: "picked_kinds", rowId: rows.pick, version: 1 },
        ...PF_TEXT_KEYS.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${rows.pick}/${key}`,
          version: 1,
        })),
        { table: "open_questions", rowId: rows.question, version: 1 },
        { table: "open_questions", rowId: FIRST.question1, version: openAt + 1 },
        { table: "clock_rows", rowId: rows.clock, version: 1 },
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rows.plan, rows.asked]);
      expect(committed.openQuestions).toEqual({ opened: [rows.question], closed: [FIRST.question1] });

      // The stored rows. S1-02's question, answered, one version past the one its row was read at.
      expect(await questionRow(FIRST.question1)).toEqual({
        status: "answered",
        version: openAt + 1,
        step: "S1-02",
      });
      const { sql } = cdb.db;
      // One listed pick, placed on its own insert under the roster company and its business.
      expect(
        await sql<Json[]>`
          select id, owner_person_id, position, words, outcome, kind_id, company_id, business_id, version
          from picked_kinds where owner_person_id = ${FIRST.person}
        `,
      ).toEqual([
        {
          id: rows.pick,
          owner_person_id: FIRST.person,
          position: 1,
          words: PLUMBING,
          outcome: "listed",
          kind_id: "plumber",
          company_id: FIRST.company,
          business_id: FIRST.business,
          version: 1,
        },
      ]);
      // Its 11 text blocks, under the pick's business.
      const texts = await sql<{ pf_key: string; business_id: string | null }[]>`
        select pf_key, business_id from picked_kind_texts where picked_kind_id = ${rows.pick} order by pf_key
      `;
      expect(texts).toEqual(
        [...PF_TEXT_KEYS].sort().map((key) => ({ pf_key: key, business_id: FIRST.business })),
      );
      expect(trades.reads.slice(tradesBefore)).toEqual([{ bundleId: V2, tradeId: "plumber" }]);
      // The company kinds: the barber one as seeded, and the plumbing one with the catalog's facts and switches.
      const plumber = catalogDefaults("plumber");
      expect(
        await sql<Json[]>`
          select kind_id, business_id, trade_name, pf_facts, pf_switches_a, pf_switches_b, version
          from company_kinds where company_id = ${FIRST.company} order by kind_id
        `,
      ).toEqual([
        expect.objectContaining({ kind_id: "barber", business_id: FIRST.business, version: 1 }),
        {
          kind_id: "plumber",
          business_id: FIRST.business,
          trade_name: null,
          pf_facts: plumber.facts,
          pf_switches_a: plumber.switchesA,
          pf_switches_b: plumber.switchesB,
          version: 1,
        },
      ]);
      // S1-09's question to the owner, waiting, with its clock row; no S1-04 question was ever opened.
      expect(
        await sql<Json[]>`
          select id, step, status, handle_id, person_id, business_id, options, version from open_questions
          where handle_id = ${FIRST.handle} order by id
        `,
      ).toEqual([
        {
          id: FIRST.question1,
          step: "S1-02",
          status: "answered",
          handle_id: FIRST.handle,
          person_id: FIRST.person,
          business_id: FIRST.business,
          options: [],
          version: openAt + 1,
        },
        {
          id: rows.question,
          step: "S1-09",
          status: "waiting",
          handle_id: FIRST.handle,
          person_id: FIRST.person,
          business_id: FIRST.business,
          options: [],
          version: 1,
        },
      ]);
      expect(await questionRow(rows.s104Question)).toBeUndefined();
      expect(
        await sql<Json[]>`select id, kind, state, open_question_id from clock_rows where id = ${rows.clock}`,
      ).toEqual([{ id: rows.clock, kind: "question", state: "waiting", open_question_id: rows.question }]);
      // Two outbox rows with no plan yet: S1-08's, step S1-08, line 0, asking nothing; then S1-09's, asking its question.
      expect(
        await sql<Json[]>`
          select id, state, channel, send_class, open_question_id, recipient_handle_id, recipient_person_id,
                 business_id, step, line_no, bundle_hash, bundle_build
          from outbox_rows where turn_id = ${FIRST.turn2} order by commit_seq
        `,
      ).toEqual(
        [
          [rows.plan, null, "S1-08"],
          [rows.asked, rows.question, "S1-09"],
        ].map(([id, question, step]) => ({
          id,
          state: "planned",
          channel: "imessage",
          send_class: "quick_reply",
          open_question_id: question,
          recipient_handle_id: FIRST.handle,
          recipient_person_id: FIRST.person,
          business_id: FIRST.business,
          step,
          line_no: 0,
          bundle_hash: V2.hash,
          bundle_build: V2.build,
        })),
      );
      expect(await footprint(cdb, FIRST.turn2)).toMatchObject({
        turns: 1,
        outbox: 2,
        questions: 1,
        effects: 0,
      });
      expect(await kindsRows()).toEqual({
        kinds: 243,
        picked_kinds: 1,
        picked_kind_texts: 11,
        new_work_drafts: 0,
        company_kinds: 5,
        review_items: 0,
      });

      // As rosie_app the turn sent no statement on a table that spans businesses, so none could answer 42501; the walk's
      // question read (through 0037), the open-holds read, item 78 and item 72 ran on the Tool API's client.
      const statements = sent.app.slice(appBefore);
      expect(statements.length).toBeGreaterThan(0);
      for (const text of statements) expect(text).not.toMatch(SPANS_BUSINESSES);
      expect(statements.some((text) => text.includes("open_questions_went_out("))).toBe(true);
      expect(statements.some((text) => /\bfrom safety_holds\b/u.test(text))).toBe(true);
      expect(statements.some((text) => /\bfrom kinds\b/u.test(text))).toBe(true);
      expect(statements.some((text) => /\bcompany_kinds\b/u.test(text))).toBe(true);

      // A replay of the same turn answers the first commit and writes nothing.
      const written = { core: await snapshot(cdb), kinds: await kindsRows() };
      expect(written.core).not.toEqual(before);
      const again = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
      expect(again).toMatchObject({ result: "committed", turnId: FIRST.turn2, repeated: true });
      expect((again as unknown as Committed).written).toEqual({
        written: [],
        outboxRows: committed.written.outboxRows,
        promoted: [],
      });
      expect({ core: await snapshot(cdb), kinds: await kindsRows() }).toEqual(written);
    },
  );

  it(
    "compose input and finalize pass on both rows: S1-08's input holds the four term lines alone and its plan states them, none of the withheld; neither text carries an opener a second time (turn 1's mark) or names the stand-in business",
    SLOW,
    async () => {
      const standIn = await standInName(FIRST);
      // S1-08's row: its master line to the owner, read by the sign-up line, and the four term facts alone.
      const plan = await composed(FIRST, rows.plan);
      expect(plan).toMatchObject({
        row: rows.plan,
        turn: FIRST.turn2,
        masterText: { step: "S1-08", text: PLAN_LINE },
        audience: { role: "owner", name: null, way: "texts", handlingLine: null },
        options: [],
        openQuestions: [],
        inbound: { text: PLUMBING },
      });
      expect(plan.facts.map((fact) => fact.value)).toEqual(PLAN_TERMS);
      for (const line of WITHHELD) expect(JSON.stringify(plan), line).not.toContain(line);
      const planSent = await finalized(FIRST, rows.plan, planOfS108(plan.facts.map((fact) => fact.value)));
      // The second text to this handle and business: no opener and no privacy link (turn 1's mark), the opt-out line
      // still owed (no receipt marked it delivered: the seed writes no phone row).
      expect(planSent.finalParts.fixedLines).toEqual(["optOutLine"]);
      const planText = planSent.finalParts.sends[0]?.text ?? "";
      expect(planText.split("\n")).toEqual([PLAN_LINE, ...PLAN_TERMS, OPT_OUT_LINE]);
      for (const line of WITHHELD) expect(planText, line).not.toContain(line);
      expect(planText).not.toContain(standIn);
      expect(planText).not.toContain(SIGN_UP_OPENER);
      expect(await rowOf(cdb, "outbox_rows", rows.plan, ["state", "final_parts"])).toEqual({
        version: 2,
        state: "checked",
        final_parts: planSent.finalParts,
      });

      // S1-09's row: its master line, its question with no option, no term fact.
      const asked = await composed(FIRST, rows.asked);
      expect(asked).toMatchObject({
        row: rows.asked,
        turn: FIRST.turn2,
        masterText: { step: "S1-09", text: S1_09_LINE },
        audience: { role: "owner", name: null, way: "texts", handlingLine: null },
        options: [],
      });
      expect(asked.facts).toEqual([]);
      const askedSent = await finalized(FIRST, rows.asked, planOfS109());
      expect(askedSent.finalParts.fixedLines).toEqual(["optOutLine"]);
      const askedText = askedSent.finalParts.sends[0]?.text ?? "";
      expect(askedText.split("\n")).toEqual([
        "Send a photo of your business card, sign, website or Google listing.",
        "Are you an owner?",
        OPT_OUT_LINE,
      ]);
      expect(askedText).not.toContain(standIn);
      expect(askedText).not.toContain(SIGN_UP_OPENER);
      expect(await rowOf(cdb, "outbox_rows", rows.asked, ["state"])).toEqual({
        version: 2,
        state: "checked",
      });
      for (const text of sent.app) expect(text).not.toMatch(SPANS_BUSINESSES);
    },
  );

  it("claimOutbox takes S1-08's row, then S1-09's, in commit order", SLOW, async () => {
    const claimed = await claimOutbox(job, {
      claimer: "dispatcher-t1493",
      recipientHandleId: FIRST.handle,
      now: CLAIMED_AT,
      limit: 5,
    });
    if (!("claimed" in claimed)) throw new Error(`claimOutbox answered ${JSON.stringify(claimed)}`);
    expect(claimed.claimed.map((row) => [row.outboxRowId, row.openQuestionId])).toEqual([
      [rows.plan, null],
      [rows.asked, rows.question],
    ]);
    expect(claimed.claimed[0]?.commitSeq).toBeLessThan(claimed.claimed[1]?.commitSeq ?? 0);
  });
});

// ---- owner 2: more than one kind still opens S1-04 ------------------------------------------------------------------------

describe("with the one-kind path bound, 'Barbershop, plumbing, electrical' still opens S1-04 as today (T-1493)", () => {
  const rows = turnTwoRows(SECOND);

  it(
    "three listed picks, none placed, the first pick's 11 text blocks, S1-02's question closed, S1-04's question and its row; no company kind written and no S1-08 row",
    SLOW,
    async () => {
      const openAt = await join(SECOND, false);
      const kindsBefore = await kindsRows();
      const { answer: got } = await answer(SECOND, SECOND.turn2, THREE_KINDS);
      expect(got, JSON.stringify(got)).toMatchObject({
        result: "committed",
        turnId: SECOND.turn2,
        repeated: false,
      });
      expect(validator.check("gateAndCommit", "response", got)).toEqual([]);
      const committed = got as unknown as Committed;
      // The part as commit-s1-02.json answers it: its 12 keys, no companies.
      expect(committed.parts).toEqual(commitS1_02().outcome.parts);
      const pick = (n: number): string => `pick-s1-02-${SECOND.turn2}-${String(n)}`;
      expect(committed.written.written).toEqual([
        { table: "picked_kinds", rowId: pick(1), version: 1 },
        { table: "picked_kinds", rowId: pick(2), version: 1 },
        { table: "picked_kinds", rowId: pick(3), version: 1 },
        ...PF_TEXT_KEYS.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${pick(1)}/${key}`,
          version: 1,
        })),
        { table: "open_questions", rowId: rows.s104Question, version: 1 },
        { table: "open_questions", rowId: SECOND.question1, version: openAt + 1 },
        { table: "clock_rows", rowId: `clock-${rows.s104Question}`, version: 1 },
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rows.s104Row]);
      expect(committed.openQuestions).toEqual({ opened: [rows.s104Question], closed: [SECOND.question1] });
      expect(
        await cdb.db.sql<Json[]>`
          select kind_id, company_id, business_id from picked_kinds where owner_person_id = ${SECOND.person}
          order by position
        `,
      ).toEqual(
        ["barber", "plumber", "electrician"].map((kindId) => ({
          kind_id: kindId,
          company_id: null,
          business_id: null,
        })),
      );
      expect(
        await cdb.db.sql<Json[]>`
          select id, step, line_no, open_question_id from outbox_rows where turn_id = ${SECOND.turn2}
        `,
      ).toEqual([{ id: rows.s104Row, step: "S1-04", line_no: 0, open_question_id: rows.s104Question }]);
      expect(await questionRow(rows.s104Question)).toEqual({ status: "waiting", version: 1, step: "S1-04" });
      expect(await kindsRows()).toEqual({
        ...kindsBefore,
        picked_kinds: kindsBefore.picked_kinds + 3,
        picked_kind_texts: kindsBefore.picked_kind_texts + 11,
      });
    },
  );
});

// ---- owners 3 and 4: each row as the first text about the business ----------------------------------------------------------

describe("each of the two rows, as the first text about the business, opens with signUpOpener and never names the stand-in business (T-1493; default 199 item (6))", () => {
  it(
    "owner 3: S1-08's row first opens with signUpOpener, the opt-out line and the privacy link; S1-09's after it carries no opener",
    SLOW,
    async () => {
      const rows = turnTwoRows(THIRD);
      await join(THIRD, false);
      const { answer: got } = await answer(THIRD, THIRD.turn2, PLUMBING);
      expect(got, JSON.stringify(got)).toMatchObject({ result: "committed", turnId: THIRD.turn2 });
      expect((got as unknown as Committed).written.outboxRows.map((row) => row.id)).toEqual([
        rows.plan,
        rows.asked,
      ]);
      const standIn = await standInName(THIRD);

      const plan = await composed(THIRD, rows.plan);
      expect(plan.facts.map((fact) => fact.value)).toEqual(PLAN_TERMS);
      const first = await finalized(THIRD, rows.plan, planOfS108(PLAN_TERMS));
      expect(first.finalParts.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
      const firstText = first.finalParts.sends[0]?.text ?? "";
      expect(firstText.startsWith(`${SIGN_UP_OPENER} ${PLAN_LINE}`)).toBe(true);
      expect(firstText).not.toContain(standIn);
      expect(firstText).not.toContain("booking assistant for");

      await composed(THIRD, rows.asked);
      const second = await finalized(THIRD, rows.asked, planOfS109());
      expect(second.finalParts.fixedLines).toEqual(["optOutLine"]);
      const secondText = second.finalParts.sends[0]?.text ?? "";
      expect(secondText).not.toContain(SIGN_UP_OPENER);
      expect(secondText).not.toContain(standIn);
    },
  );

  it(
    "owner 4: S1-09's row first opens with signUpOpener, the opt-out line and the privacy link; S1-08's after it, committed before it and so sent first, opens with them too (K-05 README default 215: an opener twice, the safe side)",
    SLOW,
    async () => {
      const rows = turnTwoRows(FOURTH);
      await join(FOURTH, false);
      const { answer: got } = await answer(FOURTH, FOURTH.turn2, PLUMBING);
      expect(got, JSON.stringify(got)).toMatchObject({ result: "committed", turnId: FOURTH.turn2 });
      const standIn = await standInName(FOURTH);

      await composed(FOURTH, rows.asked);
      const first = await finalized(FOURTH, rows.asked, planOfS109());
      expect(first.finalParts.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
      const firstText = first.finalParts.sends[0]?.text ?? "";
      expect(firstText.startsWith(`${SIGN_UP_OPENER} `)).toBe(true);
      expect(firstText).not.toContain(standIn);
      expect(firstText).not.toContain("booking assistant for");

      // S1-08's row was committed before S1-09's, whose finalize took the opener mark: a mark naming a row committed
      // after this one is read as default 202's fallback, which finds no earlier row carrying an opener (turn 1's reply
      // has no final parts), so the row sent first carries the opener and the privacy link (K-05 README default 215).
      await composed(FOURTH, rows.plan);
      const second = await finalized(FOURTH, rows.plan, planOfS108(PLAN_TERMS));
      expect(second.finalParts.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
      const secondText = second.finalParts.sends[0]?.text ?? "";
      expect(secondText.startsWith(`${SIGN_UP_OPENER} ${PLAN_LINE}`)).toBe(true);
      expect(secondText).not.toContain(standIn);
      expect(secondText).not.toContain("booking assistant for");
      for (const text of sent.app) expect(text).not.toMatch(SPANS_BUSINESSES);
    },
  );
});
