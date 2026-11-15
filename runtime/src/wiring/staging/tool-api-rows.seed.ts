// The seed of staging's row reads' and plan calls' test file (T-1399; ./tool-api-rows.worker.test.ts; key TOOL_API_ROWS in
// infra/test-rig/files.mjs): the rows its calls read and write. The rig's globalSetup (infra/test-rig/rig.mjs) runs it
// once, in Node, on this file's database, after the migrations and bundle v0, with a client of the connecting login.
//
// One database holds one world, so it is the walking skeleton's (D-017's own, the one staging holds), and each K-05
// fixture the test names is answered on it in that fixture's shape:
//
//   the heads   K-04 v1 seed-business-head.json's three business heads, value for value: Lee's Barbershop (the row T-1148's
//               seed writes, checked equal here), the yoga studio (the business K-05's two other-business fixtures read
//               under) and the movers.
//   Sam         T-1148's rows for test owner 1 (db/seeds/skeleton.ts SKELETON_ROWS), as they are: person-sam with no
//               language stored, handle-sam at tp-01's fictional number, and their link. No role at the barbershop, no
//               phone row and no sealing key, as T-1148 leaves them.
//   the kinds   K-23 v1 seed-company-two-kinds.json, in two steps, so a test reads K-05 v1.6's switch both ways on one
//               database: here, the rows of its other business (Lee Home Services: its head, Sam's role there, its company
//               and its two kinds of work, one with a switch on), so the barbershop holds no kind of work while another
//               business does (read-outbox-row-s1-02-no-kinds.json: businessSensitive null); then, from the test, through
//               this file's job binding, the barbershop's own company and its barber kind (`writeBarbershopKinds`: the two
//               rows T-1148's seed writes for it, checked equal here), after which the read answers false
//               (read-outbox-row-s1-02-not-sensitive.json) and the whole fixture is loaded.
//   the turns   K-05's commit-s1-01-sam.json through db/repo's commitTurn, its turn pinned to bundle v0 as the rig
//               publishes it (the one bundle this database holds; nothing else changed), and six more commits of the same
//               request under ids of their own (`TURNS`): the JOIN's turn, under the id the lease hashes from its event id
//               (ai/recordings' recording 4 names that id and its row), which the turn-row port takes where it refuses
//               turn-s1-01-sam; two turns whose rows are composed and finalized side by side; a turn with two rows for
//               writePlan and unplannedRows called directly, and one for the same calls through the root's own rows; and
//               a turn whose question clock cancelClock cancels.
//
// The heads, Sam and the kinds are written in one transaction as the runtime side's role, rosie_job, with no business
// scope, as the core and skeleton seeds write; the commits run as the connecting login, each one transaction of
// commitTurn's own. Test values only (rule 9): the master's sample cast, the fixtures' ids and tp-01's fictional number,
// none of them written here (each comes from its fixture or from T-1148's rows).
//
// What the test file imports from here is constants and `writeBarbershopKinds`, which load inside the Workers runtime;
// T-1148's rows are read at `seed`, in Node, since db/seeds reads the fixture set from disk as it loads.
import joinComposeInput from "../../../../ai/recordings/composer-inputs/join-s1-02.json";
import joinRunContext from "../../../../ai/recordings/contexts/join-s1-01.json";
import commitS101Sam from "../../../../contracts/data-access/fixtures/commit-s1-01-sam.json";
import seedCompanyTwoKinds from "../../../../contracts/db-schema/business-setup/fixtures/seed-company-two-kinds.json";
import seedBusinessHead from "../../../../contracts/db-schema/core/fixtures/seed-business-head.json";
import { commitTurn, type CommitTurnRequest } from "../../../../db/repo/commit-turn";
import { SCOPE_SETTING, type Sql, type Tx } from "../../../../db/repo/scope";

type Values = Readonly<Record<string, unknown>>;

interface SeedRow {
  readonly table: string;
  readonly values: Values;
}

const rowsOf = (fixture: { readonly rows: readonly unknown[] }): readonly SeedRow[] =>
  fixture.rows as readonly SeedRow[];

/** A value that must be there: a fixture or a row this seed is written against. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the tool-api-rows seed: ${what} is missing`);
  return value;
}

// ---- the businesses -------------------------------------------------------------------------------------------------

const K04_HEADS = rowsOf(seedBusinessHead).filter((row) => row.table === "businesses");

/** Lee's Barbershop: commit-s1-01-sam.json's business, test owner 1's (T-1148). */
export const BARBERSHOP = need(
  commitS101Sam.request.writes.outboxRows[0],
  "the fixture's outbox row",
).businessId;

/** The yoga studio: the business K-05's other-business fixtures read under (K-04 seed-business-head.json). */
export const YOGA_STUDIO = "biz-yoga-studio";

const K23_ROWS = rowsOf(seedCompanyTwoKinds);

/** K-23's rows of the barbershop itself: its company and its one kind of work, barber, with no switch on. */
export const BARBERSHOP_KINDS: readonly SeedRow[] = K23_ROWS.filter(
  (row) =>
    (row.table === "companies" || row.table === "company_kinds") && row.values.business_id === BARBERSHOP,
);

/** K-23's every other row: Lee Home Services' head, Sam's role there, its company and its two kinds of work. */
const OTHER_BUSINESS_ROWS: readonly SeedRow[] = K23_ROWS.filter((row) => !BARBERSHOP_KINDS.includes(row));

/** Lee Home Services: the other business K-23's fixture holds kinds of work for, one of them with a switch on. */
export const HOME_SERVICES = String(
  need(
    OTHER_BUSINESS_ROWS.find((row) => row.table === "businesses"),
    "K-23's other business",
  ).values.id,
);

/** Every business head this database holds, in id order. */
export const BUSINESSES: readonly string[] = [
  ...K04_HEADS.map((row) => String(row.values.id)),
  HOME_SERVICES,
].sort();

/** One row as its fixture gives it, written only when its key is free. */
async function insertRow(sql: Sql | Tx, row: SeedRow): Promise<void> {
  await sql`insert into ${sql(row.table)} ${sql(row.values as Record<string, never>)} on conflict do nothing`;
}

/**
 * Writes the barbershop's own company and its barber kind of work (K-23 v1 seed-company-two-kinds.json's two rows for it,
 * the ones T-1148's seed writes), each only when it is not there yet. The test file calls it on its own job-side client
 * (rosie_worker_job, which may insert both: db/migrations/0019), once it has read the barbershop with no kind of work.
 */
export async function writeBarbershopKinds(sql: Sql): Promise<void> {
  for (const row of BARBERSHOP_KINDS) await insertRow(sql, row);
}

// ---- the turns ------------------------------------------------------------------------------------------------------

/** One committed turn of this seed: commit-s1-01-sam.json's request under these ids. */
export interface SeededTurn {
  readonly turnId: string;
  readonly eventId: string;
  readonly traceId: string;
  /** S1-02's question, its question clock row, and the row that asks it. */
  readonly question: string;
  readonly clock: string;
  readonly row: string;
  /** The turn's second outbox row (routine, asking nothing), for the turns that hold two; else null. */
  readonly second: string | null;
  /** The opened question's event-log entry. */
  readonly entry: string;
  /** The commit's moment (K-05 `given.now`). */
  readonly at: string;
}

const FIXTURE_REQUEST = commitS101Sam.request;
const FIXTURE_QUESTION = need(FIXTURE_REQUEST.writes.openQuestions.open[0], "the fixture's question");
const FIXTURE_CLOCK = need(FIXTURE_REQUEST.writes.clockRows.make[0], "the fixture's clock row");
const FIXTURE_ROW = need(FIXTURE_REQUEST.writes.outboxRows[0], "the fixture's outbox row");
const FIXTURE_ENTRY = need(FIXTURE_REQUEST.writes.events[0], "the fixture's entry");

/** commit-s1-01-sam.json's own turn: turn-s1-01-sam, with outbox-s1-02-sam-1. */
const S1_01: SeededTurn = {
  turnId: FIXTURE_REQUEST.turn.id,
  eventId: need(FIXTURE_REQUEST.turn.eventIds[0], "the fixture's text"),
  traceId: FIXTURE_REQUEST.turn.traceId,
  question: FIXTURE_QUESTION.id,
  clock: FIXTURE_CLOCK.id,
  row: FIXTURE_ROW.id,
  second: null,
  entry: FIXTURE_ENTRY.id,
  at: commitS101Sam.given.now,
};

/** A turn of this seed's own: K-09 v1.5 default 131's ids (<kind>-<step>-<turn key>-<n>) under `key`. */
function turnOf(key: string, ids: { turnId: string; eventId: string; at: string; rows: 1 | 2 }): SeededTurn {
  return {
    turnId: ids.turnId,
    eventId: ids.eventId,
    traceId: `trace-${ids.eventId}`,
    question: `oq-s1-02-${key}-1`,
    clock: `clock-oq-s1-02-${key}-1`,
    row: `outbox-s1-02-${key}-1`,
    second: ids.rows === 2 ? `outbox-s1-02-${key}-2` : null,
    entry: `log-oq-s1-02-${key}-1-opened`,
    at: ids.at,
  };
}

/** A turn named for this card, its ids made from `name`. */
const ownTurn = (name: string, at: string, rows: 1 | 2 = 1): SeededTurn =>
  turnOf(name, { turnId: `turn-${name}`, eventId: `evt-${name}`, at, rows });

/** The JOIN's one text, as ai/recordings' recording 2 names it. */
const JOIN_TEXT = need(joinRunContext.texts[0], "the JOIN run's text");

/**
 * The turns this seed commits, each with S1-02's question to Sam, its waiting clock row and the row that asks it:
 *   s101    K-05's commit-s1-01-sam.json itself.
 *   join    the JOIN's turn (ai/recordings' recordings 2 and 4): its id the one the lease hashes from its event id, its
 *           row ids K-09 v1.5 default 131's under that id, as the gate's walk names them.
 *   sideA, sideB   two turns whose rows are composed and finalized side by side.
 *   plan    two rows: writePlan, its repeat and unplannedRows, called directly.
 *   rows    two rows: the same calls through the root's own rows.
 *   cancel  the question clock cancelClock cancels, its question withdrawn.
 */
export const TURNS = Object.freeze({
  s101: S1_01,
  join: turnOf(joinComposeInput.turn, {
    turnId: joinComposeInput.turn,
    eventId: JOIN_TEXT.eventId,
    at: "2026-10-19T14:01:54Z",
    rows: 1,
  }),
  sideA: ownTurn("t1399-side-a", "2026-10-19T18:06:05Z"),
  sideB: ownTurn("t1399-side-b", "2026-10-19T18:06:06Z"),
  plan: ownTurn("t1399-plan", "2026-10-19T18:07:05Z", 2),
  rows: ownTurn("t1399-rows", "2026-10-19T18:08:05Z", 2),
  cancel: ownTurn("t1399-cancel", "2026-10-19T18:09:05Z"),
});

/** A bundle id as K-05 names it. */
interface BundleId {
  readonly hash: string;
  readonly build: number;
}

/**
 * commit-s1-01-sam.json's request for `turn`: every id of the fixture's swapped for the turn's wherever the request
 * names it as a whole string, the turn pinned to `bundleId`, and for a turn of two rows a second outbox row beside the
 * first: routine, asking nothing.
 */
function requestOf(turn: SeededTurn, bundleId: BundleId): CommitTurnRequest {
  const pairs: readonly (readonly [string, string])[] = [
    [S1_01.turnId, turn.turnId],
    [S1_01.eventId, turn.eventId],
    [S1_01.traceId, turn.traceId],
    [S1_01.question, turn.question],
    [S1_01.clock, turn.clock],
    [S1_01.row, turn.row],
    [S1_01.entry, turn.entry],
  ];
  let text = JSON.stringify(FIXTURE_REQUEST);
  for (const [from, to] of pairs) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  const request = JSON.parse(text) as typeof FIXTURE_REQUEST;
  request.turn.bundleId = { hash: bundleId.hash, build: bundleId.build };
  if (turn.second !== null) {
    const first = need(request.writes.outboxRows[0], "the request's outbox row");
    request.writes.outboxRows.push({
      ...first,
      id: turn.second,
      sendClass: "routine",
      openQuestionId: null as never,
    });
  }
  return request as unknown as CommitTurnRequest;
}

/** Whether two rows hold the same columns with the same values. */
const sameRow = (a: Values, b: Values): boolean => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
};

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  // T-1148's rows, read here, in Node: db/seeds opens the fixture set from disk as it loads.
  const { SKELETON_ROWS } = await import("../../../../db/seeds/skeleton");
  const head = need(
    K04_HEADS.find((row) => row.values.id === BARBERSHOP),
    "K-04's barbershop head",
  );
  const skeletonHead = need(SKELETON_ROWS.businesses[0], "T-1148's business head");
  if (SKELETON_ROWS.businesses.length !== 1 || !sameRow(head.values, skeletonHead as unknown as Values)) {
    throw new Error(
      "the tool-api-rows seed: T-1148's business head is no longer K-04's seed-business-head.json's",
    );
  }
  const skeletonKinds = [...SKELETON_ROWS.companies, ...SKELETON_ROWS.company_kinds] as unknown as Values[];
  if (
    skeletonKinds.length !== BARBERSHOP_KINDS.length ||
    !BARBERSHOP_KINDS.every((row, at) => sameRow(row.values, need(skeletonKinds[at], "T-1148's kind row")))
  ) {
    throw new Error("the tool-api-rows seed: T-1148's company and kind are no longer K-23's fixture's");
  }

  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    for (const row of K04_HEADS) await insertRow(tx, row);
    await tx`insert into persons ${tx([...SKELETON_ROWS.persons], "id", "name", "language")}`;
    await tx`insert into handles ${tx([...SKELETON_ROWS.handles], "id", "kind", "address")}`;
    await tx`insert into person_handles ${tx([...SKELETON_ROWS.person_handles], "person_id", "handle_id")}`;
    for (const row of OTHER_BUSINESS_ROWS) await insertRow(tx, row);
  });

  // Bundle v0 as the rig published it: the one bundle here, active, which every turn of this seed is pinned to.
  const bundles = await sql<{ hash: string; build: number }[]>`select hash, build from bundles where active`;
  const [bundleId] = bundles;
  if (bundleId === undefined || bundles.length !== 1) {
    throw new Error("the tool-api-rows seed: this database holds no one active bundle");
  }
  for (const [name, turn] of Object.entries(TURNS)) {
    const committed = await commitTurn(sql, requestOf(turn, bundleId), { now: new Date(turn.at) });
    if (!("result" in committed) || committed.repeated) {
      throw new Error(`the tool-api-rows seed: the commit of its turn ${name} was not taken`);
    }
  }
}
