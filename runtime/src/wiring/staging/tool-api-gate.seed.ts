// The seed of staging's gate reads' test file (T-1398; ./tool-api-gate.worker.test.ts; key TOOL_API_GATE in
// infra/test-rig/files.mjs): the rows its gates read, seal and commit against. The rig's globalSetup (infra/test-rig/rig.mjs)
// runs it once, in Node, on this file's database, after the migrations and bundle v0, with a client of the connecting login.
//
// One database holds one world, the walking skeleton's (D-017's own, as staging holds it), and each K-05 fixture the test
// names is answered on it in that fixture's shape:
//
//   test owner 1  T-1148's rows as they are (db/seeds/skeleton.ts): Lee's Barbershop's head, Sam with no role and no
//                 phone row, his handle at tp-01's fictional number and their link, so turn 1 (K-09 v1.5 commit-s1-01.json)
//                 is a first text; then Sam's sealing key, made through K-05 v1.2 item 29 (db/repo's handleSealingKeyIn) as
//                 the gateway makes it at first sight, under the test's made-up SEALING_WRAP_KEY, since the read-only sealer
//                 never makes one (critic_size B9).
//   the heads     K-04 v1 seed-business-head.json's other two business heads, value for value: the yoga studio (the
//                 business K-05's read-open-holds-other-business.json reads under) and the movers.
//   the texters   one first sight each (K-05 v1.2 item 29: a handle at a fictional number, its person with no name, their
//                 link and the person's key, under the same made-up key) for the gates the test runs side by side (two, then
//                 six) and for the gate whose env leaves SEALING_WRAP_KEY out; and one handle whose person holds no key, for
//                 the sealer's noSealingKey.
//   two records   K-34 v1 safety_outcomes rows of Sam's, each with the turn row it names, as K-34's own seeds write them
//                 (seed-hold-released.json, seed-threat-pause.json): a No of a text whose outcome another business, the yoga
//                 studio, holds (so under the barbershop's scope it is unread: README default 44); and a record whose label
//                 reads "Needs the business's own line" of unknown tense (K-02 v1 safety-business-own-line.json with an
//                 unknown tense, as actions' safety-ask.test.ts reads it), with the outbox row of its checked line written
//                 under the id the safety service keys it by (KEYED_SAFETY_IDS), so recording that text again is a repeat
//                 whose line carries the danger question (record.ts default 18), with nothing to write.
//
// Everything is written in one transaction as the runtime side's role, rosie_job, with no business scope, as the core and
// skeleton seeds write. Test values only (rule 9): the master's sample cast, the fixtures' ids, whole fiction-range
// 555-01xx numbers, made-up ids, and a made-up wrapping key that wraps nothing but this database's throwaway data keys.
//
// The test file imports this file's constants and `writeOwnerRows`, which load inside the Workers runtime; T-1148's seed
// is loaded at `seed`, in Node, since db/seeds reads its fixture set from disk as it loads.
import { KEYED_SAFETY_IDS } from "../../../../actions/src/domain/safety/ids";
import seedBusinessHead from "../../../../contracts/db-schema/core/fixtures/seed-business-head.json";
import seedPersonRoles from "../../../../contracts/db-schema/core/fixtures/seed-person-roles.json";
import seedOwnerIdUpload from "../../../../contracts/db-schema/people-access/fixtures/seed-owner-id-upload.json";
import { handleSealingKeyIn } from "../../../../db/repo/handle-keys";
import { SCOPE_SETTING, type Sql, type Tx } from "../../../../db/repo/scope";
import { TEST_OWNER_1_PHONE } from "../../../../db/seeds/lib/roster";

type Values = Readonly<Record<string, unknown>>;

interface SeedRow {
  readonly table: string;
  readonly values: Values;
}

const rowsOf = (fixture: { readonly rows: readonly unknown[] }): readonly SeedRow[] =>
  fixture.rows as readonly SeedRow[];

/** A value that must be there: a fixture or a row this seed is written against. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the tool-api-gate seed: ${what} is missing`);
  return value;
}

// ---- the made-up wrapping key ---------------------------------------------------------------------------------------

/** The secret's name the keys are wrapped under (NQ-DB-1's default), the one name staging's resolver takes. */
export const WRAP_KEY_NAME = "SEALING_WRAP_KEY";

/**
 * The test's made-up SEALING_WRAP_KEY: 32 bytes of 0x4e as base64, the form db/repo takes. It wraps nothing but the data
 * keys of this file's database, which hold nothing but test words; never a key of anything else.
 */
export const TEST_WRAP_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x4e)));

/** The resolver the seed makes the keys with: the made-up key under its name, and nothing for any other name. */
const SEED_KEYS = {
  name: WRAP_KEY_NAME,
  resolve: (name: string): string | undefined => (name === WRAP_KEY_NAME ? TEST_WRAP_KEY : undefined),
};

// ---- the businesses -------------------------------------------------------------------------------------------------

/** K-04 seed-business-head.json's three heads; the barbershop's is T-1148's own row, written by the skeleton seed. */
const K04_HEADS = rowsOf(seedBusinessHead).filter((row) => row.table === "businesses");

/** Lee's Barbershop: commit-s1-01.json's business, test owner 1's (T-1148). */
export const BARBERSHOP = "biz-lees-barbershop";

/** The yoga studio: the business K-05's read-open-holds-other-business.json reads under (K-04 seed-business-head.json). */
export const YOGA_STUDIO = "biz-yoga-studio";

// ---- test owner 1 -----------------------------------------------------------------------------------------------------

/** Test owner 1 by the fixtures' ids and tp-01's number (db/seeds/lib/roster.ts; T-1148). */
export const SAM = {
  handleId: TEST_OWNER_1_PHONE.handleId,
  personId: "person-sam",
  number: TEST_OWNER_1_PHONE.fakeNumber,
} as const;

/** The owner's rows business-owner-phone-first.json's given holds beside T-1148's: written by the test (`writeOwnerRows`). */
const OWNER_ROLE = need(
  rowsOf(seedPersonRoles).find(
    (row) =>
      row.table === "person_roles" &&
      row.values.person_id === SAM.personId &&
      row.values.business_id === BARBERSHOP,
  ),
  "K-04's owner role of Sam's at the barbershop",
);
const OWNER_EMAIL_ROWS = rowsOf(seedOwnerIdUpload).filter(
  (row) => row.table === "handles" || row.table === "person_handles",
);

/** Sam's email handle, K-22 seed-owner-id-upload.json's own (its address is the fixture's made-up one). */
export const SAM_EMAIL = {
  handleId: String(need(OWNER_EMAIL_ROWS.find((row) => row.table === "handles"), "K-22's email handle").values.id),
  address: String(
    need(OWNER_EMAIL_ROWS.find((row) => row.table === "handles"), "K-22's email handle").values.address,
  ),
} as const;

/** One row as its fixture gives it, written only when its key is free. */
async function insertRow(sql: Sql | Tx, row: SeedRow): Promise<void> {
  await sql`insert into ${sql(row.table)} ${sql(row.values as Record<string, never>)} on conflict do nothing`;
}

/**
 * Sam made the barbershop's owner, with the email handle he proved (K-04 seed-person-roles.json's role row of his at the
 * barbershop; K-22 seed-owner-id-upload.json's email handle and its link), as business-owner-phone-first.json's given
 * holds them: each row only when it is not there yet. The test file calls it on its own job-side client
 * (rosie_worker_job, which may insert the three), once turn 1 has committed as a first text.
 */
export async function writeOwnerRows(sql: Sql): Promise<void> {
  await insertRow(sql, OWNER_ROLE);
  for (const row of OWNER_EMAIL_ROWS) await insertRow(sql, row);
}

// ---- the texters ------------------------------------------------------------------------------------------------------

/** A handle of this seed's own at a whole fiction-range number, its person, its text and its chat id. */
export interface Texter {
  readonly handleId: string;
  readonly personId: string;
  readonly number: string;
  readonly eventId: string;
  readonly chatId: string;
}

const texter = (name: string, number: string): Texter => ({
  handleId: `handle-t1398-${name}`,
  personId: `person-t1398-${name}`,
  number,
  eventId: `evt-t1398-${name}`,
  chatId: `linq-chat-t1398-${name}`,
});

/** The two texters whose first texts are gated side by side (the audit's "two rows composed side by side"). */
export const SIDE_BY_SIDE: readonly Texter[] = [
  texter("side-a", "+15555550161"),
  texter("side-b", "+15555550162"),
];

/** The six texters whose first texts are gated at once (DL-761). */
export const SIX_AT_ONCE: readonly Texter[] = [
  texter("six-1", "+15555550163"),
  texter("six-2", "+15555550164"),
  texter("six-3", "+15555550165"),
  texter("six-4", "+15555550166"),
  texter("six-5", "+15555550167"),
  texter("six-6", "+15555550168"),
];

/** The texter whose first text is gated in an env with SEALING_WRAP_KEY left out: nothing of it is ever written. */
export const NO_WRAP_KEY = texter("no-wrap", "+15555550169");

/** The texter whose person holds no sealing key: the read-only sealer refuses it (noSealingKey). */
export const NO_KEY = texter("no-key", "+15555550170");

/** Every texter that holds a key, made at its first sight. */
const KEYED = [...SIDE_BY_SIDE, ...SIX_AT_ONCE, NO_WRAP_KEY];

// ---- the two records --------------------------------------------------------------------------------------------------

/** A K-34 record of one of Sam's texts, with the turn row it names. */
export interface SeededRecord {
  readonly eventId: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly businessId: string;
  readonly outcome: string;
  readonly tense: string;
  readonly readAt: string;
}

/** A No of Sam's text whose outcome the yoga studio holds: under the barbershop's scope the text is unread. */
export const OTHER_BUSINESS_RECORD: SeededRecord = {
  eventId: "evt-t1398-other",
  turnId: "turn-t1398-other",
  traceId: "trace-t1398-other",
  businessId: YOGA_STUDIO,
  outcome: "No",
  tense: "now",
  readAt: "2026-10-19T18:20:01Z",
};

/** A record at the barbershop whose line asks the danger question: K-02's business's-own-line read, of unknown tense. */
export const ASK_RECORD: SeededRecord = {
  eventId: "evt-t1398-ask",
  turnId: "turn-t1398-ask",
  traceId: "trace-t1398-ask",
  businessId: BARBERSHOP,
  outcome: "Needs the business's own line",
  tense: "unknown",
  readAt: "2026-10-19T18:30:01Z",
};

/** A bundle id as K-05 names it. */
interface BundleId {
  readonly hash: string;
  readonly build: number;
}

/** The record's turn row (committed, Sam's handle, its one text) and its safety_outcomes row, as K-34's seeds write them. */
async function writeRecord(tx: Tx, record: SeededRecord, bundleId: BundleId): Promise<void> {
  await tx`
    insert into turns (
      id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids, tries, committed_at
    ) values (
      ${record.turnId}, ${SAM.handleId}, ${[record.eventId]}, 'committed', ${bundleId.hash}, ${bundleId.build},
      ${record.traceId}, ${[]}, 1, ${record.readAt}
    )
  `;
  await tx`
    insert into safety_outcomes (
      id, event_id, source, handle_id, person_id, business_id, booking_id, turn_id, read_at, tries, timed_out, labels,
      tenses, danger_word_lists, danger_word_kinds, sealed_words, outcomes, lifted_to_unsure
    ) values (
      ${await KEYED_SAFETY_IDS.rowId("outcome", record.eventId)}, ${record.eventId}, 'text', ${SAM.handleId},
      ${SAM.personId}, ${record.businessId}, null, ${record.turnId}, ${record.readAt},
      ${tx.json([{ model: "haiku", result: "verdict" }])}, false, ${[record.outcome]}, ${[record.tense]}, ${[]}, ${[]},
      null, ${[record.outcome]}, false
    )
  `;
}

/** The outbox row of the ask record's checked line (send class safety, to Sam), under the id the service keys it by. */
async function writeLineRow(tx: Tx, record: SeededRecord, bundleId: BundleId): Promise<void> {
  await tx`
    insert into outbox_rows (
      id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel, send_class, versions_read,
      open_question_id, bundle_hash, bundle_build, trace_id
    ) values (
      ${await KEYED_SAFETY_IDS.rowId("line", record.eventId)}, ${record.turnId}, ${SAM.handleId}, ${SAM.personId},
      ${record.businessId}, null, 'imessage', 'safety', ${tx.json([])}, null, ${bundleId.hash}, ${bundleId.build},
      ${record.traceId}
    )
  `;
}

// ---- the seed ---------------------------------------------------------------------------------------------------------

/** One first sight (K-05 v1.2 item 29) under the made-up key; refused unless it made what it was asked to. */
async function firstSight(
  tx: Tx,
  handle: { readonly number: string; readonly handleId: string; readonly personId: string },
): Promise<void> {
  const made = await handleSealingKeyIn(tx, SEED_KEYS, {
    handle: { kind: "phone", address: handle.number },
    newHandleId: handle.handleId,
    newPersonId: handle.personId,
    wrappingKeyName: WRAP_KEY_NAME,
  });
  const { outcome } = made;
  if (!("result" in outcome) || outcome.personId !== handle.personId || !outcome.created.key) {
    throw new Error("the tool-api-gate seed: a first sight did not make the person's key");
  }
}

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  // T-1148's rows, loaded here, in Node: db/seeds opens the fixture set from disk as it loads.
  const { seedSkeleton } = await import("../../../../db/seeds/skeleton");
  await seedSkeleton(sql);

  // Bundle v0 as the rig published it: the one bundle here, active, which every seeded turn is pinned to.
  const bundles = await sql<{ hash: string; build: number }[]>`select hash, build from bundles where active`;
  const [bundleId] = bundles;
  if (bundleId === undefined || bundles.length !== 1) {
    throw new Error("the tool-api-gate seed: this database holds no one active bundle");
  }

  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    for (const row of K04_HEADS) await insertRow(tx, row);

    // Sam's key: his handle and person are T-1148's, so this sight makes his key alone (handle-key-person-no-key.json).
    const sam = await handleSealingKeyIn(tx, SEED_KEYS, {
      handle: { kind: "phone", address: SAM.number },
      newHandleId: "handle-t1398-unused",
      newPersonId: "person-t1398-unused",
      wrappingKeyName: WRAP_KEY_NAME,
    });
    const samOutcome = sam.outcome;
    if (
      !("result" in samOutcome) ||
      samOutcome.handleId !== SAM.handleId ||
      samOutcome.personId !== SAM.personId ||
      samOutcome.created.handle ||
      samOutcome.created.person ||
      !samOutcome.created.key
    ) {
      throw new Error("the tool-api-gate seed: Sam's sight did not make his key alone");
    }
    for (const each of KEYED) await firstSight(tx, each);

    // A handle whose person holds no key.
    await tx`insert into persons (id) values (${NO_KEY.personId})`;
    await tx`insert into handles (id, kind, address) values (${NO_KEY.handleId}, 'phone', ${NO_KEY.number})`;
    await tx`insert into person_handles (person_id, handle_id) values (${NO_KEY.personId}, ${NO_KEY.handleId})`;

    await writeRecord(tx, OTHER_BUSINESS_RECORD, bundleId);
    await writeRecord(tx, ASK_RECORD, bundleId);
    await writeLineRow(tx, ASK_RECORD, bundleId);
  });
}
