// T-1533's proof on local PostgreSQL (the card's Proves; K-09 README defaults 210 and 211; DL-1167): `npm run db:up`,
// then `npm run test:integration -- actions/src/tool-api/journey-1/mobile-id`. Over a fresh schema migrated with every
// migration (commit/pg/test-support.ts: one schema per file, dropped when the file ends; the public schema is never
// touched), with K-04's seeds (the three shops and their people: Sam Lee at Lee's Barbershop, handle-sam, and the
// phones rows of seed-phone-chat-open.json, Sam's +15555550100 among them), K-23's seed-company-two-kinds.json (Sam's own
// company of Lee's Barbershop) and bundle v1's registry row.
//
// Real here: S1-09's settler and writer and S1-10's writer (mobileIdSteps, the code under test) over their PostgreSQL
// reads (pgListingReads and pgMobileIdReads: item 79 and item 26 as rosie_job, each in a read-only transaction of its
// own), and the commit's request (build.ts) with K-05's commitTurn as rosie_job (commit/pg pgCommitTurn), with K-04's,
// K-22's and K-23's tables, constraints, row-level security and grants as migrated. Doubles, because their tasks bind
// them: T-434's Places double (K-15), the stop home's reads (T-317's and T-307's doubles over the frozen seeds) and
// T-319's paging reader. The rows are committed directly, as the walk hands them to the commit for the part (the walk on
// bundle v3 is mobile-id.test.ts's; card 7 binds it).
//
// Proven: one commit lands the owner's accounts row (the chat's number, proven at the turn's last text), the page_links
// row (the code's sha256 alone, setup_id_check, S1-10, 7 days, live, sent to the turn's handle) and S1-10's line 2 row,
// every foreign key holding (page_links_sent_to_fk among them); the reads then find the account on file, proven, and a
// later S1-10 writes no accounts row and a second link; a helper's claim lands its accounts row alone; a row with mobile
// null is updated at its version; and another person's account holding the number is refused by accounts_mobile_key
// (23505, answered constraint, rolled back, nothing written, no one named), with the writer reading no other account.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlacesDouble } from "../../../../../adapters/src/places/double";
import { buildCommitRequest } from "../../../commit/build";
import type { CommitTurnContext, UnitWrites } from "../../../commit";
import { pgCommitTurn } from "../../../commit/pg";
import {
  insertRow,
  openCommitDatabase,
  seed,
  seedRows,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import type { StepRows } from "../../../commit/walk";
import { bundleV1Id, decidedOf, type WalkTestRepo } from "../../../commit/walk/test-support";
import { pagingWorld, readerOn } from "../../../domain/paging/test-support";
import { readsOn, seedWorld } from "../../../homes/stop/test-support";
import { HeldLinks } from "../../turn-face/held";
import { HELPS_RUN_IT, NO_MATCH, OWNER_MATCHES, pgListingReads } from "../listing";
import {
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
} from "../listing/test-support";
import { mobileIdSteps, pgMobileIdReads } from "./index";
import { LAST_TEXT_AT, SAM_NUMBER, linkDeps, s1_10Step } from "./test-support";

/** Connections per application client: item 79 and item 26 each take one of their own beside the commit's. */
const POOL = 4;

const SLOW = { timeout: 120_000 };

const nodeSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

let cdb: CommitDatabase;

/**
 * Empties the schema's heads and loads the seeds, the phones rows of seed-phone-chat-open.json (its people are the
 * company seed's own, loaded once) and bundle v1's registry row (each test starts here).
 */
async function fresh(): Promise<void> {
  await seed(cdb, ["seed-bundle-registry.json", "../../business-setup/fixtures/seed-company-two-kinds.json"]);
  for (const row of seedRows(["seed-phone-chat-open.json"]).filter((each) => each.table === "phones")) {
    await insertRow(cdb.db.sql, new Map(), row.table, row.values);
  }
  const { hash, build } = bundleV1Id();
  await cdb.db.sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${hash}, ${build}, ${`bundle/${hash}/${String(build)}/manifest`}, ${"2026-11-18T10:26:00Z"})
  `;
}

beforeAll(async () => {
  cdb = await openCommitDatabase("j1_mobile_id_s1_10", POOL);
}, 180_000);

afterAll(async () => {
  await cdb.close();
});

/** Sam's answer to S1-09 under its own turn id (a turn row each commit writes once). */
function samAnswer(branch: string, turnId: string): S1_09Turn {
  const turn = s1_09Turn(branch, RULING_WORDS_CURLY);
  const context: CommitTurnContext<WalkTestRepo> = {
    ...turn.context,
    turn: { ...turn.context.turn, id: turnId },
  };
  return { ...turn, context };
}

/** The walk's calls for the part, as card 7's binding will make them, over PostgreSQL's reads and the doubles. */
async function walked(turn: S1_09Turn, links: HeldLinks) {
  const paging = pagingWorld();
  paging.rows.set(`businesses/${SAM_BUSINESS}`, { version: 3, businessId: SAM_BUSINESS });
  const reader = readerOn(paging);
  const steps = mobileIdSteps<WalkTestRepo>({
    places: createPlacesDouble(),
    reads: pgListingReads(cdb.runtime),
    stop: readsOn(seedWorld(), null),
    paging: { reader: () => reader },
    mobileId: { reads: pgMobileIdReads(cdb.runtime), link: linkDeps(links) },
  });
  const key = turn.context.turn.id;
  const branch = await steps.settlers["S1-09"](settlerCall(turn));
  const rows: StepRows[] = [await steps.writers["S1-09"](writerCall(turn, s1_09Step(), branch, key))];
  if (branch === NO_MATCH)
    rows.push(await steps.writers["S1-76"](writerCall(turn, s1_76Step(), branch, key)));
  rows.push(await steps.writers["S1-10"](writerCall(turn, s1_10Step(), branch, key)));
  return { branch, rows };
}

/** The part's one unit, as the walk hands the commit S1-09's rows, then S1-76's, then S1-10's. */
function unitOf(turn: S1_09Turn, rows: readonly StepRows[]): UnitWrites {
  return {
    why: { step: "S1-09", choice: turn.choice.branch },
    versionsRead: [],
    state: rows.flatMap((each) => each.state),
    stateEvents: rows.flatMap((each) => each.stateEvents),
    asks: [],
    closes: [],
    clockCancels: [],
    messages: rows.flatMap((each) => each.messages),
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [...new Set(rows.flatMap((each) => each.gives))],
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

/** Every accounts row, as the owner reads it. */
async function accounts() {
  return cdb.db.sql<Record<string, unknown>[]>`
    select person_id, mobile, mobile_proven_at, email, email_proven_at, version from accounts order by person_id
  `;
}

/** Every page_links row, as the owner reads it. */
async function pageLinks() {
  return cdb.db.sql<Record<string, unknown>[]>`
    select id, business_id, person_id, purpose, step_id, code_sha256, sent_to_handle_id, issued_at, expires_at,
           ended_at, ended_why, ended_by_contact_change_id, version
    from page_links order by issued_at, id
  `;
}

/** The outbox rows a turn wrote, as the owner reads them. */
async function outboxOf(turnId: string) {
  return cdb.db.sql<Record<string, unknown>[]>`
    select id, recipient_handle_id, recipient_person_id, business_id, send_class, open_question_id, step, line_no
    from outbox_rows where turn_id = ${turnId} order by id
  `;
}

/** The code at the end of the link held for `rowId`. */
function heldCode(links: HeldLinks, rowId: string): string {
  const link = links.of(rowId) ?? "";
  return link.slice(link.lastIndexOf("/") + 1);
}

/** The face's step after a fresh commit: the link staged for the turn's rows held (turn-face.ts gateAndCommit). */
function keepFresh(links: HeldLinks, turnId: string, rowIds: readonly string[]): void {
  links.keep(turnId, rowIds);
}

describe("S1-10's rows land in K-22 and K-04 in one commit (defaults 210 and 211)", () => {
  it(
    "an owner's claim: the accounts row, the page_links row (the code's sha256 alone, 7 days) and S1-10's line 2 row",
    SLOW,
    async () => {
      await fresh();
      const links = new HeldLinks();
      const turnId = "turn-s1-10-sam-owner";
      const turn = samAnswer(OWNER_MATCHES, turnId);
      const { branch, rows } = await walked(turn, links);
      expect(branch).toBe(OWNER_MATCHES);
      const answer = await committed(turn.context, unitOf(turn, rows));
      expect(answer).toMatchObject({ result: "committed", turnId, repeated: false });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      const rowIds = answer.committed.outboxRows.map((row) => row.id);
      expect(rowIds).toEqual([`outbox-s1-09-${turnId}-1`, `outbox-s1-10-${turnId}-1`]);
      expect(answer.committed.written).toEqual(
        expect.arrayContaining([
          { table: "accounts", rowId: SAM_PERSON, version: 1 },
          { table: "page_links", rowId: `link-s1-10-${turnId}-1`, version: 1 },
        ]),
      );
      keepFresh(links, turnId, rowIds);
      const code = heldCode(links, `outbox-s1-10-${turnId}-1`);
      expect(code).toMatch(/^[0-9a-f]{32}$/);

      expect(await accounts()).toEqual([
        {
          person_id: SAM_PERSON,
          mobile: SAM_NUMBER,
          mobile_proven_at: new Date(LAST_TEXT_AT),
          email: null,
          email_proven_at: null,
          version: 1,
        },
      ]);
      expect(await pageLinks()).toEqual([
        {
          id: `link-s1-10-${turnId}-1`,
          business_id: SAM_BUSINESS,
          person_id: SAM_PERSON,
          purpose: "setup_id_check",
          step_id: "S1-10",
          code_sha256: nodeSha256(code),
          sent_to_handle_id: SAM_HANDLE,
          issued_at: new Date("2026-10-19T14:05:06Z"),
          expires_at: new Date("2026-10-26T14:05:06Z"),
          ended_at: null,
          ended_why: null,
          ended_by_contact_change_id: null,
          version: 1,
        },
      ]);
      expect(await outboxOf(turnId)).toEqual([
        {
          id: `outbox-s1-09-${turnId}-1`,
          recipient_handle_id: SAM_HANDLE,
          recipient_person_id: SAM_PERSON,
          business_id: SAM_BUSINESS,
          send_class: "quick_reply",
          open_question_id: null,
          step: "S1-09",
          line_no: 1,
        },
        {
          id: `outbox-s1-10-${turnId}-1`,
          recipient_handle_id: SAM_HANDLE,
          recipient_person_id: SAM_PERSON,
          business_id: SAM_BUSINESS,
          send_class: "quick_reply",
          open_question_id: null,
          step: "S1-10",
          line_no: 2,
        },
      ]);
      // No column holds the code or the link: only its hash.
      const stored = JSON.stringify([await accounts(), await pageLinks(), await outboxOf(turnId)]);
      expect(stored).not.toContain(code);

      // The reads on PostgreSQL now find Sam's account on file, proven; a later S1-10 writes a second link alone.
      const reads = pgMobileIdReads(cdb.runtime);
      expect(
        await reads.account(turn.context.repo, {
          handleId: SAM_HANDLE,
          businessId: SAM_BUSINESS,
          personId: SAM_PERSON,
        }),
      ).toEqual({ mobile: SAM_NUMBER, mobileProvenAt: LAST_TEXT_AT, version: 1 });
      const laterId = "turn-s1-10-sam-later";
      const later = samAnswer(OWNER_MATCHES, laterId);
      const again = await walked(later, links);
      const s1_10 = again.rows.at(-1);
      expect(s1_10?.state.map((write) => write.table)).toEqual(["page_links"]);
      expect(await committed(later.context, unitOf(later, again.rows))).toMatchObject({
        result: "committed",
      });
      // Both links live: the first stands as it is until it lapses or ends (default 211).
      const stored2 = await pageLinks();
      expect(stored2.map((row) => [row.id, row.ended_at]).sort()).toEqual([
        [`link-s1-10-${laterId}-1`, null],
        [`link-s1-10-${turnId}-1`, null],
      ]);
      expect(await accounts()).toHaveLength(1);
    },
  );

  it("a helper's claim: the helper's own accounts row alone, no link and no S1-10 row", SLOW, async () => {
    await fresh();
    const links = new HeldLinks();
    const turnId = "turn-s1-10-sam-helper";
    const turn = samAnswer(HELPS_RUN_IT, turnId);
    const { branch, rows } = await walked(turn, links);
    expect(branch).toBe(HELPS_RUN_IT);
    expect(await committed(turn.context, unitOf(turn, rows))).toMatchObject({ result: "committed", turnId });
    expect(await accounts()).toEqual([
      expect.objectContaining({ person_id: SAM_PERSON, mobile: SAM_NUMBER, version: 1 }),
    ]);
    expect(await pageLinks()).toEqual([]);
    expect(await outboxOf(turnId)).toEqual([]);
    expect(links.stagedTurns).toBe(0);
  });

  it(
    "an accounts row on file with mobile null: mobile and mobile_proven_at set at its version",
    SLOW,
    async () => {
      await fresh();
      await cdb.db.sql`insert into accounts (person_id) values (${SAM_PERSON})`;
      const turn = samAnswer(OWNER_MATCHES, "turn-s1-10-sam-null");
      const { rows } = await walked(turn, new HeldLinks());
      expect(await committed(turn.context, unitOf(turn, rows))).toMatchObject({ result: "committed" });
      expect(await accounts()).toEqual([
        expect.objectContaining({
          person_id: SAM_PERSON,
          mobile: SAM_NUMBER,
          mobile_proven_at: new Date(LAST_TEXT_AT),
          version: 2,
        }),
      ]);
    },
  );

  it(
    "another person's account holding the number: accounts_mobile_key refuses it (23505), rolled back, nothing written, no one named",
    SLOW,
    async () => {
      await fresh();
      // Alex's own account holds Sam's number (made up here: the database's one-mobile-per-account rule is the guard).
      await cdb.db.sql`
        insert into accounts (person_id, mobile, mobile_proven_at)
        values (${"person-alex"}, ${SAM_NUMBER}, ${"2026-10-01T10:00:00Z"})
      `;
      const turnId = "turn-s1-10-sam-taken";
      const turn = samAnswer(OWNER_MATCHES, turnId);
      const { rows } = await walked(turn, new HeldLinks());
      const answer = await committed(turn.context, unitOf(turn, rows));
      expect(answer).toEqual({ error: "constraint", sqlstate: "23505", constraint: "accounts_mobile_key" });
      expect(JSON.stringify(answer)).not.toContain("alex");
      expect(JSON.stringify(answer)).not.toContain("555");
      // Rolled back whole: no turn row, no link, no outbox row, the head as seeded, Alex's account as it was.
      const [turnRow] = await cdb.db.sql`select id from turns where id = ${turnId}`;
      expect(turnRow).toBeUndefined();
      expect(await pageLinks()).toEqual([]);
      expect(await outboxOf(turnId)).toEqual([]);
      const [head] = await cdb.db.sql<{ version: number }[]>`
        select version from businesses where id = ${SAM_BUSINESS}
      `;
      expect(head?.version).toBe(3);
      expect(await accounts()).toEqual([
        expect.objectContaining({ person_id: "person-alex", mobile: SAM_NUMBER, version: 1 }),
      ]);
    },
  );
});
