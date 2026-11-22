// T-635a's proof on local PostgreSQL (the card's Proves; K-09 README defaults 204 and 205): `npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/journey-1/listing`. Over a fresh schema migrated with every migration
// (commit/pg/test-support.ts: one schema per file, dropped when the file ends; the public schema is never touched), with
// K-04's seeds (bundle v0's registry, the three shops and their people: Sam Lee at Lee's Barbershop, handle-sam; the
// barbershop's head seeded live at version 3, open gap 188's), K-23's seed-company-two-kinds.json (Sam's own company of
// Lee's Barbershop, and no business_setup row for it) and bundle v1's registry row.
//
// Real here: S1-09's settler and S1-09's and S1-76's writers (the code under test) over this folder's PostgreSQL reads
// (pgListingReads: item 79 and item 26 as rosie_job, each in a read-only transaction of its own), and the commit's
// request (build.ts) with K-05's commitTurn as rosie_job (commit/pg pgCommitTurn), with K-04's, K-23's and K-37's tables,
// constraints, row-level security and grants as migrated. Doubles, because their tasks bind them: T-434's Places double
// (K-15), the stop home's reads (T-317's and T-307's doubles over the frozen seeds) and T-319's paging reader over the
// in-memory world (T-1444's runtime reader is not built). No bundle carries S1-76 or S1-10 yet, so the walk is card 7's:
// the rows are committed directly, as the walk would hand them to the commit for the part (DL-1133's lead note on
// action-layer note 8).
//
// Proven: one commit lands S1-09's rows (the business head renamed to the typed name at the version read, status left as
// it was; business_setup inserted with its listing columns null and no control), the read-back on an owner's match, and on
// no match S1-76's row and its listing_match review item, whose summary carries the claim and the reason, every foreign
// key holding; and the writer's reads on PostgreSQL then find the setup row on file and the head at its new version.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlacesDouble } from "../../../../../adapters/src/places/double";
import { buildCommitRequest } from "../../../commit/build";
import type { CommitTurnContext, UnitWrites } from "../../../commit";
import { pgCommitTurn } from "../../../commit/pg";
import { openCommitDatabase, seed, type CommitDatabase } from "../../../commit/pg/test-support";
import type { StepRows } from "../../../commit/walk";
import { bundleV1Id, decidedOf, type WalkTestRepo } from "../../../commit/walk/test-support";
import { pagingWorld, readerOn } from "../../../domain/paging/test-support";
import { readsOn, seedWorld } from "../../../homes/stop/test-support";
import {
  NO_MATCH,
  OWNER_MATCHES,
  HELPS_RUN_IT,
  listingSteps,
  listingSummaryOf,
  pgListingReads,
} from "./index";
import {
  DEMO_NAME,
  MADE_UP_NAME,
  MADE_UP_WORDS,
  RULING_WORDS_CURLY,
  SAM_BUSINESS,
  SAM_HANDLE,
  SAM_PERSON,
  s1_09Step,
  s1_09Turn,
  s1_76Step,
  settlerCall,
  writerCall,
  type S1_09Turn,
} from "./test-support";

/** Connections per application client: item 79 and item 26 each take one of their own beside the commit's. */
const POOL = 4;

const SLOW = { timeout: 120_000 };

let cdb: CommitDatabase;

/** Empties the schema's heads and loads the seeds and bundle v1's registry row (each test starts here). */
async function fresh(): Promise<void> {
  await seed(cdb, ["seed-bundle-registry.json", "../../business-setup/fixtures/seed-company-two-kinds.json"]);
  const { hash, build } = bundleV1Id();
  await cdb.db.sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${hash}, ${build}, ${`bundle/${hash}/${String(build)}/manifest`}, ${"2026-11-18T10:26:00Z"})
  `;
}

beforeAll(async () => {
  cdb = await openCommitDatabase("j1_listing_s1_09", POOL);
}, 180_000);

afterAll(async () => {
  await cdb.close();
});

/** Sam's answer to S1-09 under its own turn id (a turn row each commit writes once). */
function samAnswer(branch: string, words: string, turnId: string): S1_09Turn {
  const turn = s1_09Turn(branch, words);
  const context: CommitTurnContext<WalkTestRepo> = {
    ...turn.context,
    turn: { ...turn.context.turn, id: turnId },
  };
  return { ...turn, context };
}

/** The walk's three calls for the part, as card 7's binding will make them, over PostgreSQL's reads and the doubles. */
async function walked(turn: S1_09Turn) {
  const paging = pagingWorld();
  paging.rows.set(`businesses/${SAM_BUSINESS}`, { version: 3, businessId: SAM_BUSINESS });
  const reader = readerOn(paging);
  const steps = listingSteps<WalkTestRepo>({
    places: createPlacesDouble(),
    reads: pgListingReads(cdb.runtime),
    stop: readsOn(seedWorld(), null),
    paging: { reader: () => reader },
  });
  const branch = await steps.settlers["S1-09"](settlerCall(turn));
  const s1_09 = await steps.writers["S1-09"](writerCall(turn, s1_09Step(), branch, turn.context.turn.id));
  const s1_76 =
    branch === NO_MATCH
      ? await steps.writers["S1-76"](writerCall(turn, s1_76Step(), branch, turn.context.turn.id))
      : null;
  return { branch, s1_09, s1_76 };
}

/** The part's one unit, as the walk hands the commit S1-09's rows and S1-76's after them. */
function unitOf(turn: S1_09Turn, rows: readonly (StepRows | null)[]): UnitWrites {
  const walkedRows = rows.flatMap((each) => (each === null ? [] : [each]));
  return {
    why: { step: "S1-09", choice: turn.choice.branch },
    versionsRead: [],
    state: walkedRows.flatMap((each) => each.state),
    stateEvents: walkedRows.flatMap((each) => each.stateEvents),
    asks: [],
    closes: [],
    clockCancels: [],
    messages: walkedRows.flatMap((each) => each.messages),
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: walkedRows.flatMap((each) => each.gives),
  };
}

/** The unit committed through K-05's commitTurn as rosie_job, in one transaction, under the turn's row. */
async function committed(context: CommitTurnContext<WalkTestRepo>, writes: UnitWrites) {
  const { people } = decidedOf(context.request).context.writer;
  const personId = context.request.caller.personId;
  const person = people.find((each) => each.personId === personId);
  const request = buildCommitRequest({
    turn: context.turn,
    zone: "America/New_York",
    businessId: context.businessId,
    actor: {
      personId,
      roleAt: (businessId) => person?.roles.find((role) => role.businessId === businessId)?.role ?? null,
    },
    units: [{ writes, answer: null }],
  });
  const commitTurn = pgCommitTurn<WalkTestRepo>(cdb.runtime, { now: () => new Date(context.request.now) });
  return commitTurn(request, {
    repo: context.repo,
    businessId: context.businessId,
    span: { limits: [], rows: [] },
  });
}

/** The barbershop's head as the owner reads it. */
async function head() {
  const [row] = await cdb.db.sql<{ name: string; display_name: string; status: string; version: number }[]>`
    select name, display_name, status, version from businesses where id = ${SAM_BUSINESS}
  `;
  return row;
}

/** The barbershop's business_setup row as the owner reads it, or undefined. */
async function setupRow() {
  const [row] = await cdb.db.sql<Record<string, unknown>[]>`
    select listing_phone, listing_email, website, about, control_proven_at, control_proven_via, no_money, version
    from business_setup where business_id = ${SAM_BUSINESS}
  `;
  return row;
}

/** The outbox rows a turn wrote, as the owner reads them. */
async function outboxOf(turnId: string) {
  return cdb.db.sql<Record<string, unknown>[]>`
    select id, recipient_handle_id, recipient_person_id, business_id, booking_id, send_class, open_question_id
    from outbox_rows where turn_id = ${turnId} order by id
  `;
}

/** The review items a turn opened, as the owner reads them. */
async function reviewItemsOf(turnId: string) {
  return cdb.db.sql<Record<string, unknown>[]>`
    select kind, business_id, subject_table, subject_row_id, raised_by_person_id, summary, state, version
    from review_items where turn_id = ${turnId}
  `;
}

/** The setup row's columns S1-09's writer inserts: its listing columns null, no control, the rest at their defaults. */
const NEW_SETUP = {
  listing_phone: null,
  listing_email: null,
  website: null,
  about: null,
  control_proven_at: null,
  control_proven_via: null,
  no_money: false,
  version: 1,
};

describe("S1-09's and S1-76's rows land in K-04, K-23 and K-37 in one commit", () => {
  it(
    "an owner's 'Lee’s Barbershop in Springfield, I’m the owner': the head renamed as typed, the setup row, the read-back",
    SLOW,
    async () => {
      await fresh();
      expect(await setupRow()).toBeUndefined();
      const turn = samAnswer(OWNER_MATCHES, RULING_WORDS_CURLY, "turn-s1-09-sam-owner");
      const { branch, s1_09, s1_76 } = await walked(turn);
      expect(branch).toBe(OWNER_MATCHES);
      expect(s1_76).toBeNull();
      const answer = await committed(turn.context, unitOf(turn, [s1_09]));
      expect(answer).toMatchObject({ result: "committed", turnId: "turn-s1-09-sam-owner", repeated: false });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      expect(answer.committed.written.slice(0, 2)).toEqual([
        { table: "businesses", rowId: SAM_BUSINESS, version: 4 },
        { table: "business_setup", rowId: SAM_BUSINESS, version: 1 },
      ]);
      // The typed name, the four marks folded; the seed's status stands (S1-09 writes none: open gap 188).
      expect(await head()).toEqual({ name: DEMO_NAME, display_name: DEMO_NAME, status: "live", version: 4 });
      expect(await setupRow()).toEqual(NEW_SETUP);
      expect(await outboxOf("turn-s1-09-sam-owner")).toEqual([
        {
          id: "outbox-s1-09-turn-s1-09-sam-owner-1",
          recipient_handle_id: SAM_HANDLE,
          recipient_person_id: SAM_PERSON,
          business_id: SAM_BUSINESS,
          booking_id: null,
          send_class: "quick_reply",
          open_question_id: null,
        },
      ]);
      expect(await reviewItemsOf("turn-s1-09-sam-owner")).toEqual([]);

      // The writer's reads on PostgreSQL now find the setup row on file and the head at its new version.
      const reads = pgListingReads(cdb.runtime);
      const asked = { handleId: SAM_HANDLE, businessId: SAM_BUSINESS };
      expect(await reads.setupOnFile(turn.context.repo, asked)).toBe(true);
      expect(await reads.businessHead(turn.context.repo, asked)).toEqual({ version: 4 });
      expect(await reads.turnCompany({ businessId: SAM_BUSINESS, personId: SAM_PERSON })).toMatchObject({
        id: "company-lees-barbershop",
      });
    },
  );

  it(
    "a real-looking name and town: the head renamed as typed, the setup row, S1-76's row and its review item",
    SLOW,
    async () => {
      await fresh();
      const turn = samAnswer(OWNER_MATCHES, MADE_UP_WORDS, "turn-s1-09-sam-nomatch");
      const { branch, s1_09, s1_76 } = await walked(turn);
      expect(branch).toBe(NO_MATCH);
      const answer = await committed(turn.context, unitOf(turn, [s1_09, s1_76]));
      expect(answer).toMatchObject({ result: "committed", turnId: "turn-s1-09-sam-nomatch" });
      expect(await head()).toEqual({
        name: MADE_UP_NAME,
        display_name: MADE_UP_NAME,
        status: "live",
        version: 4,
      });
      expect(await setupRow()).toEqual(NEW_SETUP);
      expect(await outboxOf("turn-s1-09-sam-nomatch")).toEqual([
        {
          id: "outbox-s1-76-turn-s1-09-sam-nomatch-1",
          recipient_handle_id: SAM_HANDLE,
          recipient_person_id: SAM_PERSON,
          business_id: SAM_BUSINESS,
          booking_id: null,
          send_class: "quick_reply",
          open_question_id: null,
        },
      ]);
      expect(await reviewItemsOf("turn-s1-09-sam-nomatch")).toEqual([
        {
          kind: "listing_match",
          business_id: SAM_BUSINESS,
          subject_table: "businesses",
          subject_row_id: SAM_BUSINESS,
          raised_by_person_id: SAM_PERSON,
          summary: listingSummaryOf("owner", "noListing"),
          state: "open",
          version: 1,
        },
      ]);
    },
  );

  it(
    "a helper's words with no match: the item's summary carries 'Claim: helper.'; a helper with a match no item",
    SLOW,
    async () => {
      await fresh();
      const noMatch = samAnswer(HELPS_RUN_IT, MADE_UP_WORDS, "turn-s1-09-sam-helper");
      const first = await walked(noMatch);
      expect(first.branch).toBe(NO_MATCH);
      expect(await committed(noMatch.context, unitOf(noMatch, [first.s1_09, first.s1_76]))).toMatchObject({
        result: "committed",
      });
      const [item] = await reviewItemsOf("turn-s1-09-sam-helper");
      expect(item?.summary).toBe(listingSummaryOf("helper", "noListing"));

      // A helper with the demo listing, at the head's next version: the helper's branch, no row to the owner, no item.
      const matched = samAnswer(HELPS_RUN_IT, RULING_WORDS_CURLY, "turn-s1-09-sam-helper-match");
      const second = await walked(matched);
      expect(second.branch).toBe(HELPS_RUN_IT);
      expect(await committed(matched.context, unitOf(matched, [second.s1_09]))).toMatchObject({
        result: "committed",
      });
      expect(await head()).toEqual({ name: DEMO_NAME, display_name: DEMO_NAME, status: "live", version: 5 });
      expect(await outboxOf("turn-s1-09-sam-helper-match")).toEqual([]);
      expect(await reviewItemsOf("turn-s1-09-sam-helper-match")).toEqual([]);
      // The setup row was on file by then, so it was not written again.
      expect(await setupRow()).toEqual(NEW_SETUP);
    },
  );
});
