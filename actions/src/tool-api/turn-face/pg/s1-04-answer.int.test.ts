// T-1484's integration proof (H1b; rule-onekind.json card 14, DL-1033, DL-1121; K-09 README defaults 181 to 185 and 190)
// on local PostgreSQL: `npm run db:up`, then `npm run test:integration --
// actions/src/tool-api/turn-face/pg/s1-04-answer.int.test.ts`. An owner's answer to an S1-04 that was asked is one commit
// that closes the question, places the kept picks in the companies the button gives, writes S1-08's plan row and asks
// S1-09, and both rows are composed and finalized.
//
// The world (a fresh schema, migrated with every migration and dropped when the file ends: commit/pg/test-support.ts):
//   - K-24's catalog, the 243 trade-file kinds and their kind_flows as the kinds seed writes them from the trade files
//     (T-212's catalogPlanOf and insertCatalog), so the catalog by id (readTurnState's kinds/<id> and kind_flows <id>/A,
//     <id>/B, and kinds' names) answers a listed kind's facts, switches and name;
//   - the roster-owner seed (db/seeds/roster-owner.ts, run as it is) for three numbers in the fiction range, so three
//     owners, each a person with no name and no role at a stand-in business head of their own, with its company and the
//     company's barber kind of work (the phone's own world, as pg/one-kind.int.test.ts builds it);
//   - each person's sealing key, made as the gateway makes it at first sight, under a wrapping key made for this run alone;
//   - the registry rows of bundle v2 (T-1477), which turns 1 and 3 pin, and of bundle v1 (T-1460), which the third
//     owner's turn 2 pins as the user's phone's did (S1-04 asked of one kind before the one-kind path: rule-onekind.json's
//     fault (3)).
//
// Who runs what, as in pg/one-kind.int.test.ts. The turn face is handed two clients of this file's own, each statement's
// text written down (never a value): `app`, whose connections run as rosie_app (2: the call's transaction, and item 78's
// and item 72's own reads beside it, one at a time), and `job`, as rosie_job. The gate, the walk's question read and
// readOpenHolds run on `app`, item 78 and item 72 in read-only transactions of their own beside the call's; K-05's
// commitTurn, item 79, the catalog by id and names (readTurnState), S1-08's stop reads, the sealer and the row reads on
// `job`. The schema owner's client only seeds the world, plays the sends and reads what the turns left.
//
// Real here: the Tool API base, the gate and limits 1 to 6, the commit, the walk (T-1461, T-1479, T-1480, T-1491), the
// binding of T-1493 and T-1484 (pgTurnCalls with settleSignUp: signUpSteps over pgKindsReads, the trade port over the
// bundles' own overlays, pgCompaniesReads, S1-04's writer's deps (s1_04Writer, with the party rule's flag on for the
// second owner) and S1-08's stop reads), T-633's,
// T-634's, T-1492's, T-1481's and T-1482's code, T-632's matcher, runCore with the safety service, compose input and
// finalize, claimOutbox, every data-access call, row-level security and the two application roles. Given: the bundles as
// the frontier's fake over bundles/v2's and bundles/v1's own files; the decided texts, K-09's commit-s1-01.json,
// commit-s1-02.json, commit-s1-04.json and commit-s1-04-some-share.json as each owner sends them (no model is called); the
// plans, written from compose input's own master text and term facts as a composer would give them. Each send is played
// by one delivered part as pg/one-kind.int.test.ts plays one, then K-05's own armClock.
//
// The faces: `face`, the whole binding (the companies reads, S1-04's writer's deps with the party flag left out, S1-08's
// deps with the stop reads); `partyFace`, the same with the party flag on; `h1aFace`, H1a's binding (the companies reads
// and S1-08's deps, no s1_04Writer: staging's since T-1494, H2a), which refuses an answer to S1-04 (notBuilt); and
// `beforeFace`, T-1503's binding with no companies reads and no S1-08 deps (staging's before H2a), which asks S1-04 of an
// owner with one kind and refuses an answer to it (notBuilt).
//
// The owners:
//   1. "Barbershop, plumbing, electrical" opens S1-04 under bundle v2. Through beforeFace and h1aFace, "They all share one
//      company" is refused with nothing written. Through face it is one commit: S1-04's question closed at its version; the three
//      picks placed under the roster company and its business; the barbershop's 11 text blocks given that business;
//      plumber and electrician company kinds beside the barber one; S1-08's row (step S1-08, line 0, no question);
//      S1-09's question and its row; no statement of rosie_app on a table that spans businesses (so none could answer
//      42501); a replay writes nothing. Both rows are composed and finalized: S1-08's input holds the four term lines
//      alone, and its plan states them and none of the withheld ones; neither text carries an opener a second time
//      (turn 1's mark) or names the stand-in business. claimOutbox takes S1-08's row, then S1-09's.
//   2. Sam's own answer ("Plumbing and electrical share Lee Home Services": Some share one) needs a second company. With
//      the party flag off it is refused (secondCompany) with nothing written and the question left open; with it on, the
//      new company lands with no business, its plumber and electrician company kinds under it, the barbershop pick in
//      the turn's company and the other two in the new one, then S1-08's row and S1-09's question.
//   3. The user's phone: "Plumbing" under bundle v1 through beforeFace opens S1-04 with one kept pick on file and no
//      company. "They all share one company" under bundle v2 through face places that pick by an update at its version,
//      its plumber company kind first, its 11 blocks given the business, and sends S1-08's plan and S1-09's question.
//      S1-08's row is the first text about the business (nothing before it was finalized), so it opens with
//      signUpOpener, never the stand-in business's name; S1-09's after it carries no opener.

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
  snapshot,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { bundleV1Id, decidedOf, turnTwoOnV1 } from "../../../commit/walk/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import { captureLog, checks, fakeBundles } from "../../../frontier/assemble/test-support";
import type { DecidePart } from "../../../gate/framework";
import { CompaniesRefusedError } from "../../journey-1/companies";
import { catalogDefaults } from "../../journey-1/companies/test-support";
import { pgKindsReads } from "../../journey-1/kinds";
import { PF_TEXT_KEYS, type PlugInBundles } from "../../journey-1/plug-ins";
import { tradesOverV1 } from "../../journey-1/plug-ins/test-support";
import { fixture, traceFor } from "../../test-support";
import {
  bundleV2Id,
  commitS101,
  composeS102,
  publishedBundleV1,
  publishedBundleV2,
  tradesOverV2,
} from "../calls-test-support";
import { NOTHING_OPEN_AT, type SignUpWriterDeps } from "../commit";
import type { TurnFace } from "../turn-face";
import { pgCompaniesReads, pgTurnCalls, pgTurnFace } from "./index";
import { pgStopReads } from "./test-support";

type Json = Record<string, unknown>;
/** A bundle id as a turn pins it (K-01 v1 bundleId). */
interface BundlePin {
  readonly hash: string;
  readonly build: number;
}

const SLOW = { timeout: 120_000 };
/** The Tool API client's connections: the call's transaction, and item 78's and item 72's own reads beside it. */
const APP_POOL = 2;
const JOB_POOL = 4;

const { validator, checker } = checks();

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

/** Bundle v2's id, which turns 1 and 3 pin, and bundle v1's, which the third owner's turn 2 pins. */
const V2 = bundleV2Id();
const V1 = bundleV1Id();

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

/**
 * The moments: turn 1's commit, its row's finalize, send and delivery; turn 2's text and commit, its S1-04 row's send and
 * delivery; then turn 3's text, commit, finalize and claim.
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

/** The owners' words: commit-s1-02.json's three kinds, one listed kind, and commit-s1-04.json's "All share one". */
const THREE_KINDS = "Barbershop, plumbing, electrical";
const PLUMBING = "Plumbing";
const ALL_SHARE_ONE_WORDS = "They all share one company";
/** Sam's own answer's text (commit-s1-04-some-share.json): Some share one, with both fields. */
const SAMS_WORDS = "Plumbing and electrical share Lee Home Services";

// ---- the owners (db/seeds/roster-owner.ts, places 1 to 3) ----------------------------------------------------------------

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
  /** S1-04's question and row, which turn 2 opens (default 131, from turn 2's id). */
  readonly question2: string;
  readonly row2: string;
  readonly turn3: string;
  readonly trace3: string;
}

/** Places 1 to 3's numbers, each written whole, so the phone scan (T-1317) reads each as a fiction-range number. */
const OWNER_NUMBERS: readonly string[] = ["+15555550171", "+15555550172", "+15555550173"];

/** The number of the owner at `place` (1 to 3). */
function numberAt(place: number): string {
  const number = OWNER_NUMBERS[place - 1];
  if (number === undefined) throw new Error(`no owner number at place ${String(place)}`);
  return number;
}

function ownerAt(place: number): Owner {
  const ids = rosterOwnerIds(place);
  const n = String(place);
  const turn1 = `turn-s1-01-s1-04-answer-${n}`;
  const turn2 = `turn-s1-02-s1-04-answer-${n}`;
  return {
    place,
    number: numberAt(place),
    business: ids.businessId,
    company: ids.companyId,
    person: ids.personId,
    handle: ids.handleId,
    chat: `linq-chat-demo-s1-04-answer-${n}`,
    turn1,
    trace1: `trace-s1-04-answer-${n}-0000`,
    question1: `oq-s1-02-${turn1}-1`,
    row1: `outbox-s1-02-${turn1}-1`,
    turn2,
    trace2: `trace-s1-04-answer-${n}-0001`,
    question2: `oq-s1-04-${turn2}-1`,
    row2: `outbox-s1-04-${turn2}-1`,
    turn3: `turn-s1-04-s1-04-answer-${n}`,
    trace3: `trace-s1-04-answer-${n}-0002`,
  };
}

const OWNERS = [ownerAt(1), ownerAt(2), ownerAt(3)] as const;
const [FIRST, SECOND, THIRD] = OWNERS;

/** The rows turn 3 writes for an owner, named from its turn id (default 131). */
function turnThreeRows(owner: Owner) {
  const key = owner.turn3;
  return {
    company: `company-s1-04-${key}-1`,
    plan: `outbox-s1-08-${key}-1`,
    question: `oq-s1-09-${key}-1`,
    clock: `clock-oq-s1-09-${key}-1`,
    asked: `outbox-s1-09-${key}-1`,
  };
}

/** Turn 2's picks for an owner, in the order named (default 131: pick-s1-02-<turn 2>-<n>). */
const pickOf = (owner: Owner, n: number): string => `pick-s1-02-${owner.turn2}-${String(n)}`;

/** The pf keys in the order item 79 answers a pick's text rows (by pf key), which S1-04's writer keeps (W3). */
const PF_KEYS_BY_KEY = [...PF_TEXT_KEYS].sort();

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

/** commit-s1-04.json's roster names, as the owner's: its business, person, handle, number and chat. */
const rosterNames = (owner: Owner): [string, string][] => [
  ["biz-roster-owner-1", owner.business],
  ["person-roster-owner-1", owner.person],
  ["handle-roster-owner-1", owner.handle],
  ["+15555550150", owner.number],
  ["linq-chat-demo-roster", owner.chat],
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

/** `request`'s turn, decided context and decide pinned to `pin`, its writer the owner as the frontier names them. */
function pinned(request: GateAndCommitRequest, owner: Owner, pin: BundlePin): GateAndCommitRequest {
  const { context, decide } = decidedOf(request);
  if (request.turn === null) throw new Error("the request carries its turn");
  request.turn.bundleId = { ...pin };
  context.bundleId = { ...pin };
  decide.bundleId = { ...pin };
  context.writer.people = [structuredClone(writerOf(owner))];
  return request;
}

/** Turn 1: commit-s1-01.json's request as the owner sends it, pinned to bundle v2. */
function turnOne(owner: Owner): GateAndCommitRequest {
  return pinned(renamed(commitS101().request, turnOneNames(owner)), owner, V2);
}

/**
 * Turn 2: commit-s1-02.json's request as the owner sends it (T-1461's turnTwoOnV1), pinned to `pin`, answering S1-02's
 * question as turn 1 stored it, its one part choosing "All on the list" (c-01) in decide's agreed parts and both reads,
 * with `words` as the text, the part's quote and its kinds field.
 */
function turnTwo(owner: Owner, words: string, pin: BundlePin): GateAndCommitRequest {
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

  const request = pinned(
    renamed(
      base,
      new Map<string, string>([
        ...ownerNames(owner),
        ["turn-s1-02-sam-kinds", owner.turn2],
        ["trace-sam-0001", owner.trace2],
        ["evt-sam-0001", `evt-${owner.turn2}`],
        ["oq-s1-02", owner.question1],
      ]),
    ),
    owner,
    pin,
  );
  const { context } = decidedOf(request);
  // The times, after turn 1's: the text, the question it answers as it went out, and the commit.
  context.texts[0].sentAt.utc = TEXT_2;
  for (const question of context.openQuestions) question.sentAt.utc = SENT_1;
  for (const message of context.recentMessages) message.sentAt.utc = SENT_1;
  request.now = NOW_2;
  return request;
}

/** Which K-09 S1-04 fixture a turn 3 is sent as: the roster owner's "All share one", or Sam's own "Some share one". */
type TurnThreeAnswer = "allShareOne" | "samsAnswer";

/**
 * Turn 3: an S1-04 commit fixture's request as the owner sends it under the turn id `turnId`, pinned to bundle v2,
 * answering the S1-04 question turn 2 opened: commit-s1-04.json's "They all share one company" (c-02, All share one, no
 * field), or commit-s1-04-some-share.json's "Plumbing and electrical share Lee Home Services" (c-01, Some share one, with
 * shared_kinds and company_name).
 */
function turnThree(owner: Owner, turnId: string, answer: TurnThreeAnswer): GateAndCommitRequest {
  const base =
    answer === "allShareOne"
      ? (fixture("commit-s1-04.json") as { request: GateAndCommitRequest }).request
      : (fixture("commit-s1-04-some-share.json") as { request: GateAndCommitRequest }).request;
  const names =
    answer === "allShareOne"
      ? [
          ...rosterNames(owner),
          ["turn-s1-04-roster", turnId],
          ["trace-roster-0002", owner.trace3],
          ["evt-roster-0002", `evt-${turnId}`],
          ["oq-s1-04-roster-1", owner.question2],
        ]
      : [
          ...ownerNames(owner),
          ["turn-s1-04-sam", turnId],
          ["trace-sam-0002", owner.trace3],
          ["evt-sam-0002", `evt-${turnId}`],
          ["oq-s1-04-sam", owner.question2],
        ];
  const request = pinned(renamed(base, new Map<string, string>(names as [string, string][])), owner, V2);
  const { context } = decidedOf(request);
  expect(context.texts[0].words).toBe(answer === "allShareOne" ? ALL_SHARE_ONE_WORDS : SAMS_WORDS);
  // The times, after turn 2's: the text, S1-04's question as it went out, and the commit.
  context.texts[0].sentAt.utc = TEXT_3;
  for (const question of context.openQuestions) question.sentAt.utc = SENT_2;
  for (const message of context.recentMessages) message.sentAt.utc = SENT_2;
  request.now = NOW_3;
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

/** The trade port over both bundles' own overlays: bundle v1's for its id, bundle v2's for any other. */
const tradesV1 = tradesOverV1();
const tradesV2 = tradesOverV2();
const trades: PlugInBundles = {
  trade: (bundleId, tradeId) =>
    (bundleId.hash === V1.hash && bundleId.build === V1.build ? tradesV1 : tradesV2).bundles.trade(
      bundleId,
      tradeId,
    ),
};

/** Which binding a face hands in (the top of this file). */
type FaceKind = "whole" | "party" | "h1a" | "before";

let face: TurnFace;
let partyFace: TurnFace;
let h1aFace: TurnFace;
let beforeFace: TurnFace;

/** S1-04's writer's deps a face hands in: the party flag off (left out) or on; none for H1a's binding. */
function s1_04WriterOf(kind: FaceKind): Pick<SignUpWriterDeps<Tx>, "s1_04Writer"> {
  if (kind === "whole") return { s1_04Writer: {} };
  if (kind === "party") return { s1_04Writer: { partyRuleLive: true } };
  return {};
}

/** A face over this world's two clients with the binding `kind` names (the top of this file). */
function faceOf(kind: FaceKind): TurnFace {
  const bundles = fakeBundles(publishedBundleV2(), publishedBundleV1());
  const signUp: SignUpWriterDeps<Tx> = {
    kinds: { reads: pgKindsReads(app, job) },
    plugIns: { bundles: trades },
    ...(kind === "before"
      ? {}
      : {
          companies: pgCompaniesReads(app, job),
          ...s1_04WriterOf(kind),
          plan: { stop: pgStopReads(job) },
        }),
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
  cdb = await openCommitDatabase("turn_face_s1_04_answer", JOB_POOL);
  const { sql } = cdb.db;
  // The registry rows: bundle v2, which turns 1 and 3 pin, and bundle v1, which the third owner's turn 2 pins.
  for (const pin of [V2, V1]) {
    await sql`
      insert into bundles (hash, build, manifest_key, built_at)
      values (${pin.hash}, ${pin.build}, ${`bundle/${pin.hash}/${String(pin.build)}/manifest`}, '2026-11-20T10:00:00Z')
    `;
  }
  // K-24's catalog: the 243 trade-file kinds and their kind_flows, as the kinds seed writes them (T-212).
  const { rows } = catalogPlanOf(verifyTradeSet(openTradeSet()));
  await sql.begin(async (tx) => {
    await insertCatalog(tx, rows);
  });
  // The roster-owner seed, as it is, for three numbers: its own transaction as rosie_job.
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
      newHandleId: `handle-t1484-unused-${String(owner.place)}`,
      newPersonId: `person-t1484-unused-${String(owner.place)}`,
      wrappingKeyName: "SEALING_WRAP_KEY",
    });
    if (!("result" in sighted.outcome) || sighted.outcome.personId !== owner.person) {
      throw new Error("first sight did not give the roster owner's key");
    }
  }
  app = cdb.client(TOOL_API_ROLE, "rosie-turn-face-s1-04-answer-app", APP_POOL, (text) => {
    sent.app.push(text.trim());
  });
  job = cdb.client(RUNTIME_ROLE, "rosie-turn-face-s1-04-answer-job", JOB_POOL, (text) => {
    sent.job.push(text.trim());
  });
  face = faceOf("whole");
  partyFace = faceOf("party");
  h1aFace = faceOf("h1a");
  beforeFace = faceOf("before");
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

/** How many rows K-24's kinds tables, K-23's companies and company kinds and K-37's review items hold. */
interface KindsCounts {
  readonly kinds: number;
  readonly picked_kinds: number;
  readonly picked_kind_texts: number;
  readonly new_work_drafts: number;
  readonly companies: number;
  readonly company_kinds: number;
  readonly review_items: number;
}

/** The rows of the kinds tables, the companies and their kinds, as the owner reads them. */
async function kindsRows(): Promise<KindsCounts> {
  const [row] = await cdb.db.sql<KindsCounts[]>`
    select (select count(*)::int from kinds) as kinds,
           (select count(*)::int from picked_kinds) as picked_kinds,
           (select count(*)::int from picked_kind_texts) as picked_kind_texts,
           (select count(*)::int from new_work_drafts) as new_work_drafts,
           (select count(*)::int from companies) as companies,
           (select count(*)::int from company_kinds) as company_kinds,
           (select count(*)::int from review_items) as review_items
  `;
  if (row === undefined) throw new Error("kindsRows: no row");
  return row;
}

/** The owner's picks, in the order named: kind, company, business and version. */
async function picksOf(owner: Owner): Promise<Json[]> {
  return cdb.db.sql<Json[]>`
    select id, kind_id, company_id, business_id, version from picked_kinds
    where owner_person_id = ${owner.person} order by position
  `;
}

/** A pick's text rows by pf key: business and version. */
async function textsOf(pickId: string): Promise<Json[]> {
  return cdb.db.sql<Json[]>`
    select pf_key, business_id, version from picked_kind_texts where picked_kind_id = ${pickId} order by pf_key
  `;
}

/** A company's kinds: kind, business, trade name, facts, switches and version. */
async function companyKindsOf(companyId: string): Promise<Json[]> {
  return cdb.db.sql<Json[]>`
    select kind_id, business_id, trade_name, pf_facts, pf_switches_a, pf_switches_b, version
    from company_kinds where company_id = ${companyId} order by kind_id
  `;
}

/** A listed kind's company kind as S1-04's writer inserts it: the catalog's facts and switches, no trade name, version 1. */
function catalogKind(kindId: string, businessId: string | null): Json {
  const defaults = catalogDefaults(kindId);
  return {
    kind_id: kindId,
    business_id: businessId,
    trade_name: null,
    pf_facts: defaults.facts,
    pf_switches_a: defaults.switchesA,
    pf_switches_b: defaults.switchesB,
    version: 1,
  };
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
 * A row's send, played: one delivered part, as limit-1's sign-up test writes one, the row moved to delivered, then K-05's
 * own armClock at the receipt for the question it asks, on the runtime side. Answers the version that question is open at.
 */
async function deliver(
  rowId: string,
  questionId: string,
  step: string,
  at: { sent: string; delivered: string; due: string },
): Promise<number> {
  const { sql } = cdb.db;
  await sql`
    insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, linq_message_id,
                              state, sent_at, delivered_at)
    values (${rowId}, 1, 1, ${`${rowId}/1/1`}, 1, 'words', ${`linq-msg-${rowId}`}, 'delivered', ${at.sent},
            ${at.delivered})
  `;
  await sql`update outbox_rows set state = 'delivered', version = version + 1 where id = ${rowId}`;
  const armed = await armClock(job, {
    openQuestionId: questionId,
    deliveredAt: at.delivered,
    dueAt: at.due,
    dueZone: "America/New_York",
  });
  expect(armed).toMatchObject({ result: "armed", repeated: false });
  const question = await questionRow(questionId);
  expect(question).toEqual({ status: "open", version: 2, step });
  return question?.version ?? 0;
}

/**
 * Turn 1 for an owner, the JOIN through the face under bundle v2's id: S1-02's question opened. With `finalize`, its row
 * is composed and finalized first (opening with signUpOpener, never the stand-in name), so its writePlan writes the
 * opener mark; without, the reply is played as delivered with no final parts, so nothing marks a text about the
 * business. Then the send is played.
 */
async function join(owner: Owner, finalize: boolean): Promise<void> {
  clock.now = NOW_1;
  clock.finalize = FINALIZED_1;
  const request = turnOne(owner);
  const first = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  expect(first, JSON.stringify(first)).toMatchObject({
    result: "committed",
    turnId: owner.turn1,
    repeated: false,
    openQuestions: { opened: [owner.question1], closed: [] },
  });
  if (finalize) {
    const names = turnOneNames(owner);
    const compose = renamed(composeS102().request, names);
    const composed = await face.composeInput(structuredClone(compose), traceFor(compose).trace);
    expect(composed, JSON.stringify(composed)).toMatchObject({ result: "compose" });
    const request1 = renamed((fixture("finalize-pass.json") as { request: Json }).request, names);
    const finalized = (await face.finalizeMessage(
      structuredClone(request1),
      traceFor(request1).trace,
    )) as unknown as Finalized;
    expect(finalized.outcome, JSON.stringify(finalized)).toBe("send");
    expect(finalized.finalParts.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
  }
  await deliver(owner.row1, owner.question1, "S1-02", {
    sent: SENT_1,
    delivered: DELIVERED_1,
    due: "2026-10-20T18:05:09Z",
  });
}

/** K-09's committed answer, as the turn face gives it. */
interface Committed {
  readonly parts: Json[];
  readonly written: { written: Json[]; outboxRows: Json[]; promoted: Json[] };
  readonly openQuestions: { opened: string[]; closed: string[] };
}

/**
 * Turn 2 for an owner through `through`, pinned to `pin`: `words` to S1-02's question, which asks S1-04 (no one-kind path
 * in `through`, or more than one kind). Then S1-04's row is played as delivered with no final parts (nothing marks it a
 * text about the business). Answers the version S1-04's question is open at.
 */
async function askS1_04(owner: Owner, words: string, through: TurnFace, pin: BundlePin): Promise<number> {
  clock.now = NOW_2;
  const request = turnTwo(owner, words, pin);
  const got = await through.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  expect(got, JSON.stringify(got)).toMatchObject({
    result: "committed",
    turnId: owner.turn2,
    repeated: false,
  });
  expect(validator.check("gateAndCommit", "response", got)).toEqual([]);
  const committed = got as unknown as Committed;
  expect(committed.openQuestions).toEqual({ opened: [owner.question2], closed: [owner.question1] });
  expect(committed.written.outboxRows.map((row) => row.id)).toEqual([owner.row2]);
  expect(
    await cdb.db.sql<Json[]>`
      select id, step, line_no, open_question_id, bundle_hash, bundle_build from outbox_rows where turn_id = ${owner.turn2}
    `,
  ).toEqual([
    {
      id: owner.row2,
      step: "S1-04",
      line_no: 0,
      open_question_id: owner.question2,
      bundle_hash: pin.hash,
      bundle_build: pin.build,
    },
  ]);
  expect(await questionRow(owner.question2)).toEqual({ status: "waiting", version: 1, step: "S1-04" });
  return deliver(owner.row2, owner.question2, "S1-04", {
    sent: SENT_2,
    delivered: DELIVERED_2,
    due: "2026-10-20T18:07:09Z",
  });
}

/** Turn 3 for an owner through `through` under the turn id `turnId` (turn 3's own unless named). */
async function answer(owner: Owner, kind: TurnThreeAnswer, through: TurnFace, turnId = owner.turn3) {
  clock.now = NOW_3;
  const request = turnThree(owner, turnId, kind);
  return { request, answer: await through.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace) };
}

/** Compose input for one of turn 3's rows: its answer, held to K-09's response. */
async function composed(owner: Owner, outboxRowId: string) {
  const compose = { caller: callerOf(owner, owner.turn3, owner.trace3), outboxRowId };
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

/** finalizeMessage for one of turn 3's rows with `plan`: what it answers, held to K-09's response. */
async function finalized(owner: Owner, outboxRowId: string, plan: Json): Promise<Finalized> {
  clock.finalize = FINALIZED_3;
  const request = {
    caller: callerOf(owner, owner.turn3, owner.trace3),
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

/** Turn 3's two outbox rows for an owner, as stored: S1-08's (no question), then S1-09's (its question), no plan yet. */
async function turnThreeOutbox(owner: Owner): Promise<void> {
  const rows = turnThreeRows(owner);
  expect(
    await cdb.db.sql<Json[]>`
      select id, state, channel, send_class, open_question_id, recipient_handle_id, recipient_person_id,
             business_id, step, line_no, bundle_hash, bundle_build
      from outbox_rows where turn_id = ${owner.turn3} order by commit_seq
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
      recipient_handle_id: owner.handle,
      recipient_person_id: owner.person,
      business_id: owner.business,
      step,
      line_no: 0,
      bundle_hash: V2.hash,
      bundle_build: V2.build,
    })),
  );
  // S1-09's question to the owner, waiting, with its clock row.
  expect(await questionRow(rows.question)).toEqual({ status: "waiting", version: 1, step: "S1-09" });
  expect(
    await cdb.db.sql<
      Json[]
    >`select id, kind, state, open_question_id from clock_rows where id = ${rows.clock}`,
  ).toEqual([{ id: rows.clock, kind: "question", state: "waiting", open_question_id: rows.question }]);
  expect(await footprint(cdb, owner.turn3)).toMatchObject({
    turns: 1,
    outbox: 2,
    questions: 1,
    effects: 0,
  });
}

// ---- owner 1: "All share one" in words, three kinds -----------------------------------------------------------------------

describe("an owner's 'All share one' in words to an S1-04 that was asked places the three picks in the turn's company and walks to S1-08's row and S1-09's question on local PostgreSQL (T-1484)", () => {
  /** S1-04's question's version once its first delivery receipt armed its clock: what turn 3 closes it at. */
  let openAt = 0;
  const rows = turnThreeRows(FIRST);

  it(
    "the two clients run as the Tool API's role and the runtime side's, and the three roster owners are seeded",
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
        companies: 3,
        company_kinds: 3,
        review_items: 0,
      });
    },
  );

  it(
    "turns 1 and 2 under bundle v2: JOIN asks S1-02; 'Barbershop, plumbing, electrical' opens S1-04 with three picks, none placed; S1-04's row is delivered and its question open at version 2",
    SLOW,
    async () => {
      await join(FIRST, true);
      openAt = await askS1_04(FIRST, THREE_KINDS, face, V2);
      expect((await picksOf(FIRST)).map((pick) => [pick.kind_id, pick.company_id, pick.business_id])).toEqual(
        [
          ["barber", null, null],
          ["plumber", null, null],
          ["electrician", null, null],
        ],
      );
    },
  );

  it(
    "with no S1-04 writer bound (T-1503's binding with no companies reads, or H1a's with the companies reads and no s1_04Writer), the answer is refused (notBuilt) with nothing written and S1-04's question left open",
    SLOW,
    async () => {
      const before = { core: await snapshot(cdb), kinds: await kindsRows() };
      for (const [turnId, through] of [
        [`${FIRST.turn3}-no-companies`, beforeFace],
        [`${FIRST.turn3}-h1a`, h1aFace],
      ] as const) {
        const { answer: refused } = await answer(FIRST, "allShareOne", through, turnId);
        expect(refused, turnId).toEqual({ error: "notBuilt", call: "gateAndCommit" });
        expect(await footprint(cdb, turnId), turnId).toEqual(NO_FOOTPRINT);
        expect(await questionRow(FIRST.question2), turnId).toEqual({
          status: "open",
          version: openAt,
          step: "S1-04",
        });
      }
      expect({ core: await snapshot(cdb), kinds: await kindsRows() }).toEqual(before);
    },
  );

  it(
    "'They all share one company' is one commit: S1-04's question closed at its version, the three picks placed under the roster company and its business, the barbershop's 11 blocks given that business, plumber and electrician company kinds (barber kept), S1-08's row (S1-08, line 0, no question), S1-09's question and its row, no 42501; a replay writes nothing",
    SLOW,
    async () => {
      const before = { core: await snapshot(cdb), kinds: await kindsRows() };
      const appBefore = sent.app.length;
      const { request, answer: got } = await answer(FIRST, "allShareOne", face);
      expect(got, JSON.stringify(got)).toMatchObject({
        result: "committed",
        turnId: FIRST.turn3,
        repeated: false,
      });
      expect(validator.check("gateAndCommit", "response", got)).toEqual([]);
      const committed = got as unknown as Committed;
      // The part: committed, choosing All share one (c-02), giving S1-04's companies.
      expect(committed.parts).toEqual([
        expect.objectContaining({ part: 0, choiceId: "c-02", result: "committed", gives: ["companies"] }),
      ]);
      // K-05's own answer: every row the commit wrote, each with its version after it.
      expect(committed.written.written).toEqual([
        { table: "company_kinds", rowId: `${FIRST.company}/plumber`, version: 1 },
        { table: "company_kinds", rowId: `${FIRST.company}/electrician`, version: 1 },
        ...[1, 2, 3].map((n) => ({ table: "picked_kinds", rowId: pickOf(FIRST, n), version: 2 })),
        ...PF_KEYS_BY_KEY.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${pickOf(FIRST, 1)}/${key}`,
          version: 2,
        })),
        { table: "open_questions", rowId: rows.question, version: 1 },
        { table: "open_questions", rowId: FIRST.question2, version: openAt + 1 },
        { table: "clock_rows", rowId: rows.clock, version: 1 },
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rows.plan, rows.asked]);
      expect(committed.openQuestions).toEqual({ opened: [rows.question], closed: [FIRST.question2] });

      // The stored rows. S1-04's question, answered, one version past the one its row was read at.
      expect(await questionRow(FIRST.question2)).toEqual({
        status: "answered",
        version: openAt + 1,
        step: "S1-04",
      });
      // The three picks, each placed in the roster company under its business at the version read, plus one.
      expect(await picksOf(FIRST)).toEqual(
        ["barber", "plumber", "electrician"].map((kindId, index) => ({
          id: pickOf(FIRST, index + 1),
          kind_id: kindId,
          company_id: FIRST.company,
          business_id: FIRST.business,
          version: 2,
        })),
      );
      // The barbershop's 11 text blocks, given that business.
      expect(await textsOf(pickOf(FIRST, 1))).toEqual(
        PF_KEYS_BY_KEY.map((key) => ({ pf_key: key, business_id: FIRST.business, version: 2 })),
      );
      // The company kinds: the barber one as seeded, and plumber and electrician with the catalog's facts and switches.
      expect(await companyKindsOf(FIRST.company)).toEqual([
        expect.objectContaining({ kind_id: "barber", business_id: FIRST.business, version: 1 }),
        catalogKind("electrician", FIRST.business),
        catalogKind("plumber", FIRST.business),
      ]);
      await turnThreeOutbox(FIRST);
      expect(await kindsRows()).toEqual({ ...before.kinds, company_kinds: before.kinds.company_kinds + 2 });

      // As rosie_app the turn sent no statement on a table that spans businesses, so none could answer 42501; the walk's
      // question read (through 0037), the open-holds read and item 72 ran on the Tool API's client.
      const statements = sent.app.slice(appBefore);
      expect(statements.length).toBeGreaterThan(0);
      for (const text of statements) expect(text).not.toMatch(SPANS_BUSINESSES);
      expect(statements.some((text) => text.includes("open_questions_went_out("))).toBe(true);
      expect(statements.some((text) => /\bfrom safety_holds\b/u.test(text))).toBe(true);
      expect(statements.some((text) => /\bcompany_kinds\b/u.test(text))).toBe(true);

      // A replay of the same turn answers the first commit and writes nothing.
      const written = { core: await snapshot(cdb), kinds: await kindsRows() };
      expect(written.core).not.toEqual(before.core);
      const again = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
      expect(again).toMatchObject({ result: "committed", turnId: FIRST.turn3, repeated: true });
      expect((again as unknown as Committed).written).toEqual({
        written: [],
        outboxRows: committed.written.outboxRows,
        promoted: [],
      });
      expect({ core: await snapshot(cdb), kinds: await kindsRows() }).toEqual(written);
    },
  );

  it(
    "compose input and finalize pass on both rows: S1-08's input holds the four term lines alone and its plan states them, none of the withheld; S1-09's is its question; neither text carries an opener a second time (turn 1's mark) or names the stand-in business",
    SLOW,
    async () => {
      const standIn = await standInName(FIRST);
      const plan = await composed(FIRST, rows.plan);
      expect(plan).toMatchObject({
        row: rows.plan,
        turn: FIRST.turn3,
        masterText: { step: "S1-08", text: PLAN_LINE },
        audience: { role: "owner", name: null, way: "texts", handlingLine: null },
        options: [],
        openQuestions: [],
        inbound: { text: ALL_SHARE_ONE_WORDS },
      });
      expect(plan.facts.map((fact) => fact.value)).toEqual(PLAN_TERMS);
      for (const line of WITHHELD) expect(JSON.stringify(plan), line).not.toContain(line);
      const planSent = await finalized(FIRST, rows.plan, planOfS108(plan.facts.map((fact) => fact.value)));
      // A later text to this handle and business: no opener and no privacy link (turn 1's mark), the opt-out line still
      // owed (no receipt marked it delivered: the seed writes no phone row).
      expect(planSent.finalParts.fixedLines).toEqual(["optOutLine"]);
      const planText = planSent.finalParts.sends[0]?.text ?? "";
      expect(planText.split("\n")).toEqual([PLAN_LINE, ...PLAN_TERMS, OPT_OUT_LINE]);
      for (const line of WITHHELD) expect(planText, line).not.toContain(line);
      expect(planText).not.toContain(standIn);
      expect(planText).not.toContain(SIGN_UP_OPENER);

      const asked = await composed(FIRST, rows.asked);
      expect(asked).toMatchObject({
        row: rows.asked,
        turn: FIRST.turn3,
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
      for (const text of sent.app) expect(text).not.toMatch(SPANS_BUSINESSES);
    },
  );

  it("claimOutbox takes S1-08's row, then S1-09's, in commit order", SLOW, async () => {
    const claimed = await claimOutbox(job, {
      claimer: "dispatcher-t1484",
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

// ---- owner 2: Sam's two-company answer and the party rule's flag ------------------------------------------------------------

describe("Sam's own answer needs a second company: refused with the party flag off, landed with it on (T-1484; K-09 README default 184)", () => {
  let openAt = 0;
  const rows = turnThreeRows(SECOND);

  it(
    "with the flag off it is refused (secondCompany) with nothing written and S1-04's question left open",
    SLOW,
    async () => {
      await join(SECOND, false);
      openAt = await askS1_04(SECOND, THREE_KINDS, face, V2);
      const turnId = `${SECOND.turn3}-party-off`;
      const before = { core: await snapshot(cdb), kinds: await kindsRows() };
      const refused = answer(SECOND, "samsAnswer", face, turnId);
      await expect(refused).rejects.toBeInstanceOf(CompaniesRefusedError);
      await expect(refused).rejects.toMatchObject({ fault: "secondCompany", ids: ["S1-04"] });
      expect(await footprint(cdb, turnId)).toEqual(NO_FOOTPRINT);
      expect(await questionRow(SECOND.question2)).toEqual({ status: "open", version: openAt, step: "S1-04" });
      expect({ core: await snapshot(cdb), kinds: await kindsRows() }).toEqual(before);
    },
  );

  it(
    "with it on, one commit: Lee Home Services lands with no business and its plumber and electrician company kinds, the barbershop pick in the turn's company with its business and its 11 blocks, plumbing and electrical in the new company, then S1-08's row and S1-09's question",
    SLOW,
    async () => {
      const before = await kindsRows();
      const { answer: got } = await answer(SECOND, "samsAnswer", partyFace);
      expect(got, JSON.stringify(got)).toMatchObject({
        result: "committed",
        turnId: SECOND.turn3,
        repeated: false,
      });
      expect(validator.check("gateAndCommit", "response", got)).toEqual([]);
      const committed = got as unknown as Committed;
      expect(committed.parts).toEqual([
        expect.objectContaining({ part: 0, choiceId: "c-01", result: "committed", gives: ["companies"] }),
      ]);
      expect(committed.written.written).toEqual([
        { table: "companies", rowId: rows.company, version: 1 },
        { table: "company_kinds", rowId: `${rows.company}/plumber`, version: 1 },
        { table: "company_kinds", rowId: `${rows.company}/electrician`, version: 1 },
        ...[1, 2, 3].map((n) => ({ table: "picked_kinds", rowId: pickOf(SECOND, n), version: 2 })),
        ...PF_KEYS_BY_KEY.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${pickOf(SECOND, 1)}/${key}`,
          version: 2,
        })),
        { table: "open_questions", rowId: rows.question, version: 1 },
        { table: "open_questions", rowId: SECOND.question2, version: openAt + 1 },
        { table: "clock_rows", rowId: rows.clock, version: 1 },
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rows.plan, rows.asked]);
      expect(committed.openQuestions).toEqual({ opened: [rows.question], closed: [SECOND.question2] });

      const { sql } = cdb.db;
      expect(
        await sql<
          Json[]
        >`select id, owner_person_id, name, business_id, version from companies where id = ${rows.company}`,
      ).toEqual([
        {
          id: rows.company,
          owner_person_id: SECOND.person,
          name: "Lee Home Services",
          business_id: null,
          version: 1,
        },
      ]);
      expect(await companyKindsOf(rows.company)).toEqual([
        catalogKind("electrician", null),
        catalogKind("plumber", null),
      ]);
      expect(await picksOf(SECOND)).toEqual([
        {
          id: pickOf(SECOND, 1),
          kind_id: "barber",
          company_id: SECOND.company,
          business_id: SECOND.business,
          version: 2,
        },
        {
          id: pickOf(SECOND, 2),
          kind_id: "plumber",
          company_id: rows.company,
          business_id: null,
          version: 2,
        },
        {
          id: pickOf(SECOND, 3),
          kind_id: "electrician",
          company_id: rows.company,
          business_id: null,
          version: 2,
        },
      ]);
      expect(await textsOf(pickOf(SECOND, 1))).toEqual(
        PF_KEYS_BY_KEY.map((key) => ({ pf_key: key, business_id: SECOND.business, version: 2 })),
      );
      // The turn's company keeps its barber kind alone: the barbershop's kind is on file there.
      expect((await companyKindsOf(SECOND.company)).map((kind) => kind.kind_id)).toEqual(["barber"]);
      expect(await questionRow(SECOND.question2)).toEqual({
        status: "answered",
        version: openAt + 1,
        step: "S1-04",
      });
      await turnThreeOutbox(SECOND);
      expect(await kindsRows()).toEqual({
        ...before,
        companies: before.companies + 1,
        company_kinds: before.company_kinds + 2,
      });
    },
  );
});

// ---- owner 3: the user's phone, one kept pick on file with S1-04 asked under bundle v1 ----------------------------------------

describe("the user's phone: one kept pick on file with S1-04 asked under bundle v1; 'All share one' under bundle v2 places it and sends S1-08's plan and S1-09's question (T-1484; rule-onekind.json card 14)", () => {
  let openAt = 0;
  const rows = turnThreeRows(THIRD);

  it(
    "'Plumbing' under bundle v1 through T-1503's binding opens S1-04 with one listed pick on file, no company, its 11 blocks with no business",
    SLOW,
    async () => {
      await join(THIRD, false);
      const kindsBefore = await kindsRows();
      openAt = await askS1_04(THIRD, PLUMBING, beforeFace, V1);
      expect(await picksOf(THIRD)).toEqual([
        { id: pickOf(THIRD, 1), kind_id: "plumber", company_id: null, business_id: null, version: 1 },
      ]);
      expect(await textsOf(pickOf(THIRD, 1))).toEqual(
        PF_KEYS_BY_KEY.map((key) => ({ pf_key: key, business_id: null, version: 1 })),
      );
      expect(await kindsRows()).toEqual({
        ...kindsBefore,
        picked_kinds: kindsBefore.picked_kinds + 1,
        picked_kind_texts: kindsBefore.picked_kind_texts + 11,
      });
    },
  );

  it(
    "'They all share one company' under bundle v2 is one commit: the pick placed by an update at its version, its plumber company kind first (barber kept), its 11 blocks given the business, S1-04's question closed, S1-08's row and S1-09's question",
    SLOW,
    async () => {
      const before = await kindsRows();
      const { answer: got } = await answer(THIRD, "allShareOne", face);
      expect(got, JSON.stringify(got)).toMatchObject({
        result: "committed",
        turnId: THIRD.turn3,
        repeated: false,
      });
      expect(validator.check("gateAndCommit", "response", got)).toEqual([]);
      const committed = got as unknown as Committed;
      expect(committed.written.written).toEqual([
        { table: "company_kinds", rowId: `${THIRD.company}/plumber`, version: 1 },
        { table: "picked_kinds", rowId: pickOf(THIRD, 1), version: 2 },
        ...PF_KEYS_BY_KEY.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${pickOf(THIRD, 1)}/${key}`,
          version: 2,
        })),
        { table: "open_questions", rowId: rows.question, version: 1 },
        { table: "open_questions", rowId: THIRD.question2, version: openAt + 1 },
        { table: "clock_rows", rowId: rows.clock, version: 1 },
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rows.plan, rows.asked]);
      expect(committed.openQuestions).toEqual({ opened: [rows.question], closed: [THIRD.question2] });
      expect(await picksOf(THIRD)).toEqual([
        {
          id: pickOf(THIRD, 1),
          kind_id: "plumber",
          company_id: THIRD.company,
          business_id: THIRD.business,
          version: 2,
        },
      ]);
      expect(await textsOf(pickOf(THIRD, 1))).toEqual(
        PF_KEYS_BY_KEY.map((key) => ({ pf_key: key, business_id: THIRD.business, version: 2 })),
      );
      expect(await companyKindsOf(THIRD.company)).toEqual([
        expect.objectContaining({ kind_id: "barber", business_id: THIRD.business, version: 1 }),
        catalogKind("plumber", THIRD.business),
      ]);
      expect(await questionRow(THIRD.question2)).toEqual({
        status: "answered",
        version: openAt + 1,
        step: "S1-04",
      });
      await turnThreeOutbox(THIRD);
      expect(await kindsRows()).toEqual({ ...before, company_kinds: before.company_kinds + 1 });
    },
  );

  it(
    "S1-08's row, the first text about the business, opens with signUpOpener, the opt-out line and the privacy link and states the four term lines; S1-09's after it carries no opener; neither names the stand-in business",
    SLOW,
    async () => {
      const standIn = await standInName(THIRD);
      const plan = await composed(THIRD, rows.plan);
      expect(plan.facts.map((fact) => fact.value)).toEqual(PLAN_TERMS);
      const first = await finalized(THIRD, rows.plan, planOfS108(PLAN_TERMS));
      expect(first.finalParts.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
      const firstText = first.finalParts.sends[0]?.text ?? "";
      expect(firstText.startsWith(`${SIGN_UP_OPENER} ${PLAN_LINE}`)).toBe(true);
      for (const line of PLAN_TERMS) expect(firstText, line).toContain(line);
      for (const line of WITHHELD) expect(firstText, line).not.toContain(line);
      expect(firstText).not.toContain(standIn);
      expect(firstText).not.toContain("booking assistant for");

      const asked = await composed(THIRD, rows.asked);
      expect(asked).toMatchObject({ masterText: { step: "S1-09", text: S1_09_LINE }, options: [] });
      const second = await finalized(THIRD, rows.asked, planOfS109());
      expect(second.finalParts.fixedLines).toEqual(["optOutLine"]);
      const secondText = second.finalParts.sends[0]?.text ?? "";
      expect(secondText).not.toContain(SIGN_UP_OPENER);
      expect(secondText).not.toContain(standIn);
      for (const text of sent.app) expect(text).not.toMatch(SPANS_BUSINESSES);
    },
  );
});
