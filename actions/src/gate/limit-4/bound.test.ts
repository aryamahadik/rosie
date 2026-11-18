// T-1448's unit proofs (DL-938; T-1436's open question 3 and its security reviewer's note b): limit 4's reload reads the
// rows an open question showed within the bound of the stored question row, its business and the turn that wrote it,
// never the request's business or the turn now answering; a setup row read at a moved version shows as changed, and one
// left out of the read (outside the bound) reads as gone, failing closed. Doubles stand in for limit 4's ports (the
// questions' read and today's facts), never for limit 4; the real read, on PostgreSQL, is pg/reload.int.test.ts's.
//
// Rows come only from the contracts' fixtures: K-09 v1's commit-limit-4-changed.json (Sam's "1" to S2-22), K-35's
// seed-license-as-given.json (Riley's license), K-23's seed-business-demo-shop.json (the barbershop's setup row, by its
// business id, and its flow A defaults, by K-05 v1.18 item 77's "business id/flow") and seed-company-two-kinds.json (Lee
// Home Services' plumbing kind, "company id/kind id"). The turn that wrote S2-22's row is a new id.

import { describe, expect, it } from "vitest";

import type { RowRef } from "../limit-3/facts";
import { exchangeRequest, partOf, turnOf } from "../limit-3/test-support";
import {
  freshYesOutcome,
  saidWhatChangedOutcome,
  setupBoundOf,
  toPersonOutcome,
  type StoredQuestion,
  type TodayReader,
  type VersionsDecision,
} from "./index";
import {
  LIMIT_4_FIXTURE,
  S2_22,
  counted,
  limitIn,
  plainRow,
  teamRow,
  versionsFake,
  type TodayReads,
  type VersionsFake,
  type World,
} from "./test-support";

const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
/** The turn that wrote S2-22's row (K-04 open_questions.turn_id): Riley's join, after which Sam is asked. */
const WRITTEN_BY = "turn-t1448-riley-joins";

/** Riley's barber license (K-35 seed-license-as-given.json), a one-column setup row by its id. */
const RILEY_LICENSE: RowRef = { table: "documents", rowId: "doc-riley-barber-license", version: 1 };
/** The barbershop's setup row (K-23 seed-business-demo-shop.json), a one-column key: its business id. */
const SHOP_SETUP: RowRef = { table: "business_setup", rowId: BARBERSHOP, version: 4 };
/** The barbershop's flow A defaults (the same seed), a two-column key by item 77's name. */
const FLOW_A: RowRef = { table: "flow_defaults", rowId: `${BARBERSHOP}/A`, version: 1 };
/** Lee Home Services' plumbing kind (K-23 seed-company-two-kinds.json), another business's two-column row. */
const PLUMBING: RowRef = { table: "company_kinds", rowId: "company-lee-home-services/plumber", version: 1 };

/** Sam's "1" to S2-22, as K-09 v1's commit-limit-4-changed.json sends it. */
const request = () => exchangeRequest(LIMIT_4_FIXTURE);

/** S2-22's row to Sam as K-04 stores it, naming `versionsRead`, written by WRITTEN_BY unless `row` says otherwise. */
function s222(versionsRead: readonly RowRef[], row: Partial<StoredQuestion> = {}): StoredQuestion {
  return { ...teamRow(request()), versionsRead, turnId: WRITTEN_BY, ...row };
}

/** Limit 4's decision on Sam's "1", over `world`. */
function decided(world: World): Promise<VersionsDecision> {
  const sent = request();
  return limitIn(world).decide(partOf(sent), turnOf(sent));
}

/** The K-05 fake holding each row as given. */
function holding(rows: readonly RowRef[]): VersionsFake {
  const fake = versionsFake();
  fake.seed(rows.map((row) => plainRow(row)));
  return fake;
}

/** A row the double holds, with the business that holds it. */
interface HeldRow extends RowRef {
  readonly businessId: string;
}

/** Today's facts as currentVersionsOf reads a business-scoped setup row: only one of the bound's business answers. */
function businessBound(rows: readonly HeldRow[]): TodayReader {
  return {
    currentVersions(asked, bound) {
      return Promise.resolve(
        asked.flatMap((ref) => {
          const row = rows.find((each) => each.table === ref.table && each.rowId === ref.rowId);
          return row?.businessId === bound.businessId
            ? [{ table: row.table, rowId: row.rowId, version: row.version }]
            : [];
        }),
      );
    },
    booking: () => Promise.resolve(null),
  };
}

describe("T-1448: limit 4's reload reads a question's setup rows within its stored row's bound (DL-938)", () => {
  it("hands today's facts the stored row's bound, its business and the turn that wrote it, never the request's business or the turn now answering", async () => {
    const shown = [RILEY_LICENSE, SHOP_SETUP, FLOW_A];
    const question = s222(shown);
    const reads: TodayReads = { versions: [], bookings: [], bounds: [] };
    const world: World = { questions: [question], today: counted(holding(shown).today, reads) };
    expect(await decided(world)).toEqual({ result: "pass", compareAndSet: shown });
    expect(reads.versions).toEqual([shown]);
    expect(reads.bounds).toEqual([{ businessId: BARBERSHOP, turnId: WRITTEN_BY }]);
    expect(setupBoundOf(question)).toEqual({ businessId: BARBERSHOP, turnId: WRITTEN_BY });
    // The request names Sam's answering turn and the barbershop: the bound takes neither from it.
    const sent = request();
    expect(sent.turn?.id).toBe("turn-sam-s2-22-changed");
    expect(turnOf(sent).businessId).toBe(BARBERSHOP);

    // A row stored for another business gives that business, whatever the request names.
    const elsewhere: TodayReads = { versions: [], bookings: [], bounds: [] };
    await decided({
      questions: [s222(shown, { businessId: HOME_SERVICES })],
      today: counted(holding(shown).today, elsewhere),
    });
    expect(elsewhere.bounds).toEqual([{ businessId: HOME_SERVICES, turnId: WRITTEN_BY }]);
  });

  it("a setup row read at a moved version shows as changed: today's facts and a fresh yes, from today's versions; a question asked twice goes to a person", async () => {
    const shown = [RILEY_LICENSE, SHOP_SETUP, FLOW_A];
    const fake = holding(shown);
    fake.commitElsewhere("flow_defaults", FLOW_A.rowId);
    expect(await decided({ questions: [s222(shown)], today: fake.today })).toEqual({
      result: "fail",
      outcome: freshYesOutcome(),
      next: {
        kind: "freshYes",
        openQuestionId: S2_22,
        step: "S2-22",
        bookingId: null,
        askCount: 2,
        changed: [{ table: "flow_defaults", rowId: FLOW_A.rowId, readVersion: 1, currentVersion: 2 }],
        versionsToday: [RILEY_LICENSE, SHOP_SETUP, { ...FLOW_A, version: 2 }],
      },
    });
    const twice = await decided({ questions: [s222(shown, { askCount: 2 })], today: fake.today });
    expect(twice.result === "fail" ? twice.outcome : twice).toEqual(toPersonOutcome());
  });

  it("a setup row outside the bound reads as gone: no longer possible, failing closed; the bound follows the stored row's business", async () => {
    const today = businessBound([
      { ...SHOP_SETUP, businessId: BARBERSHOP },
      { ...FLOW_A, businessId: BARBERSHOP },
      { ...PLUMBING, businessId: HOME_SERVICES },
    ]);
    const gone = (row: RowRef) => ({
      table: row.table,
      rowId: row.rowId,
      readVersion: row.version,
      currentVersion: null,
    });
    const said = (changed: ReturnType<typeof gone>[]): VersionsDecision => ({
      result: "fail",
      outcome: saidWhatChangedOutcome(),
      next: {
        kind: "saidWhatChanged",
        openQuestionId: S2_22,
        step: "S2-22",
        bookingId: null,
        why: "rowGone",
        changed,
      },
    });
    const shown = [SHOP_SETUP, FLOW_A, PLUMBING];
    expect(await decided({ questions: [s222(shown)], today })).toEqual(said([gone(PLUMBING)]));
    expect(await decided({ questions: [s222(shown, { businessId: HOME_SERVICES })], today })).toEqual(
      said([gone(SHOP_SETUP), gone(FLOW_A)]),
    );
    expect(await decided({ questions: [s222([SHOP_SETUP, FLOW_A])], today })).toEqual({
      result: "pass",
      compareAndSet: [SHOP_SETUP, FLOW_A],
    });
  });
});
