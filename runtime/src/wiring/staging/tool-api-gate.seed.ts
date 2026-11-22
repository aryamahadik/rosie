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
//   the catalog   (T-1470) K-24 v1 seed-kinds-sample.json's eight trade-file kinds rows, value for value, for K-05 v1.19
//                 item 78 (the gate's catalog read). No kind_flows row: item 78 reads none.
//   one question  (T-1470) S1-02's question, live, of a handle of this seed's own (its person holds no key and no pick),
//                 at the barbershop, as staging holds one once it has gone out: its turn row, its outbox row with one
//                 part sent and delivered, and the question open at version 2, raised once as K-05 armClock raises it at
//                 the first delivery receipt. The walk's question read (pgWalkQuestions) reads it on the gate's scope.
//   one-kind      (T-1494; DL-1111) the world staging's real phone texts in: db/seeds/roster-owner.ts run as it is for one
//                 whole fiction-range number at place 1 (biz-roster-owner-1, its setup row, its person with no name, its
//                 handle and their link, company-roster-owner-1 owned by that person with the barber kind of work), that
//                 person's key made at first sight under the made-up key, K-24 v1 seed-kinds-sample.json's sixteen
//                 kind_flows rows value for value (the catalog by id reads a kind's switches from them; item 78 reads
//                 none), the registry row of bundle v2 as bundles/v2 holds it (K-04 bundles: id, manifest key, built at;
//                 not active: bundle v0 stays this database's one active bundle), and S1-02's question to that owner,
//                 live at that business under bundle v2, written as the one above is. A one-kind "Plumbing" to it is the
//                 test's own turn.
//
// Everything but the roster-owner set (its own transaction as rosie_job, as it runs on staging) and the bundle's registry
// row (the connecting login, as a publish writes it) is written in one transaction as the runtime side's role, rosie_job,
// with no business scope, as the core and skeleton seeds write. Test values only (rule 9): the master's sample cast, the
// fixtures' ids, whole fiction-range 555-01xx numbers, made-up ids, and a made-up wrapping key that wraps nothing but this
// database's throwaway data keys.
//
// The test file imports this file's constants and `writeOwnerRows`, which load inside the Workers runtime; T-1148's seed
// and the roster-owner set are loaded at `seed`, in Node, since db/seeds reads its fixture set from disk as it loads.
import { KEYED_SAFETY_IDS } from "../../../../actions/src/domain/safety/ids";
import bundleV2Manifest from "../../../../bundles/v2/bundle/manifest.json";
import seedBusinessHead from "../../../../contracts/db-schema/core/fixtures/seed-business-head.json";
import seedPersonRoles from "../../../../contracts/db-schema/core/fixtures/seed-person-roles.json";
import seedKindsSample from "../../../../contracts/db-schema/kinds-of-work/fixtures/seed-kinds-sample.json";
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

const EMAIL_HANDLE = need(
  OWNER_EMAIL_ROWS.find((row) => row.table === "handles"),
  "K-22's email handle",
);

/** Sam's email handle, K-22 seed-owner-id-upload.json's own (its address is the fixture's made-up one). */
export const SAM_EMAIL = {
  handleId: String(EMAIL_HANDLE.values.id),
  address: String(EMAIL_HANDLE.values.address),
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

// ---- the kinds catalog and the open question (T-1470) -----------------------------------------------------------------

/** K-24 v1 seed-kinds-sample.json's kinds rows: eight trade-file kinds, written value for value. */
const KIND_ROWS = rowsOf(seedKindsSample).filter((row) => row.table === "kinds");

/** (T-1494) Its kind_flows rows, each kind's flows A and B, written value for value after the kinds. */
const KIND_FLOW_ROWS = rowsOf(seedKindsSample).filter((row) => row.table === "kind_flows");

/**
 * (T-1494) A seeded kind's facts and the switches on in flows A and B, as this database holds them (the fixture's rows):
 * what the catalog by id answers for it, and what its company kind takes.
 */
export function seededKindDefaults(kindId: string): {
  readonly facts: readonly unknown[];
  readonly switchesA: readonly unknown[];
  readonly switchesB: readonly unknown[];
} {
  const kind = need(
    KIND_ROWS.find((row) => row.values.id === kindId),
    `the kinds row of ${kindId}`,
  );
  const switchesOf = (flow: string): readonly unknown[] => {
    const row = need(
      KIND_FLOW_ROWS.find((each) => each.values.kind_id === kindId && each.values.flow === flow),
      `the kind_flows row ${kindId}/${flow}`,
    );
    return row.values.switches_on as readonly unknown[];
  };
  return {
    facts: (kind.values.facts ?? []) as readonly unknown[],
    switchesA: switchesOf("A"),
    switchesB: switchesOf("B"),
  };
}

/** A kind as K-05 v1.19 item 78 answers its row, but for its version. */
export interface SeededKind {
  readonly id: string;
  readonly name: string;
  readonly style: string;
  readonly pattern: string;
  readonly source: string;
}

/** The catalog this database holds, as item 78 answers it: every seeded kind, in id order, byte by byte. */
export const CATALOG: readonly SeededKind[] = KIND_ROWS.map(({ values }): SeededKind => ({
  id: String(values.id),
  name: String(values.name),
  style: String(values.style),
  pattern: String(values.pattern),
  source: String(values.source),
})).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * The owner whose S1-02 question is live here: a handle of this seed's own at a whole fiction-range number, its person
 * (no name, no key, no pick), the turn that asked, the question, and the outbox row it went out as (one part, sent and
 * delivered). `version` is the question row's: 2, K-04's first version raised once.
 */
export const ASKED = {
  handleId: "handle-t1470-asked",
  personId: "person-t1470-asked",
  number: "+15555550177",
  turnId: "turn-t1470-asked",
  eventId: "evt-t1470-asked",
  traceId: "trace-t1470-asked",
  questionId: "oq-s1-02-t1470-asked-1",
  outboxRowId: "outbox-s1-02-t1470-asked-1",
  messageId: "linq-msg-t1470-asked-0001",
  committedAt: "2026-10-19T18:05:05Z",
  sentAt: "2026-10-19T18:05:07Z",
  deliveredAt: "2026-10-19T18:05:08Z",
  version: 2,
} as const;

/** An owner whose S1-02 question is live: its handle and person, the turn that asked, the question and its outbox row. */
interface AskedOwner {
  readonly handleId: string;
  readonly personId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly traceId: string;
  readonly questionId: string;
  readonly outboxRowId: string;
  readonly messageId: string;
  readonly committedAt: string;
  readonly sentAt: string;
  readonly deliveredAt: string;
}

/**
 * The asked owner's rows: the handle, its person and their link; then its question (writeLiveQuestion).
 */
async function writeAskedQuestion(tx: Tx, bundleId: BundleId): Promise<void> {
  await tx`insert into persons (id) values (${ASKED.personId})`;
  await tx`insert into handles (id, kind, address) values (${ASKED.handleId}, 'phone', ${ASKED.number})`;
  await tx`insert into person_handles (person_id, handle_id) values (${ASKED.personId}, ${ASKED.handleId})`;
  await writeLiveQuestion(tx, ASKED, BARBERSHOP, bundleId);
}

/**
 * An owner's live S1-02 question at `businessId` under `bundleId`: the committed turn; S1-02's question (no options, no
 * read-back, nothing read, no clock named); its outbox row, delivered, with its one part; then the question made open
 * with its version raised once, as K-05 armClock leaves it at the first delivery receipt.
 */
async function writeLiveQuestion(
  tx: Tx,
  asked: AskedOwner,
  businessId: string,
  bundleId: BundleId,
): Promise<void> {
  await tx`
    insert into turns (
      id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids, tries, committed_at
    ) values (
      ${asked.turnId}, ${asked.handleId}, ${[asked.eventId]}, 'committed', ${bundleId.hash}, ${bundleId.build},
      ${asked.traceId}, ${[]}, 1, ${asked.committedAt}
    )
  `;
  await tx`
    insert into open_questions (
      id, turn_id, handle_id, person_id, business_id, booking_id, step, options, readback, versions_read, bundle_hash,
      bundle_build, clock, ask_count, status
    ) values (
      ${asked.questionId}, ${asked.turnId}, ${asked.handleId}, ${asked.personId}, ${businessId}, null, 'S1-02',
      ${tx.json([])}, null, ${tx.json([])}, ${bundleId.hash}, ${bundleId.build}, null, 1, 'waiting'
    )
  `;
  await tx`
    insert into outbox_rows (
      id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel, send_class, versions_read,
      open_question_id, state, bundle_hash, bundle_build, trace_id
    ) values (
      ${asked.outboxRowId}, ${asked.turnId}, ${asked.handleId}, ${asked.personId}, ${businessId}, null, 'imessage',
      'quick_reply', ${tx.json([])}, ${asked.questionId}, 'delivered', ${bundleId.hash}, ${bundleId.build},
      ${asked.traceId}
    )
  `;
  await tx`
    insert into outbox_parts (
      outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, linq_message_id, state, sent_at, delivered_at
    ) values (
      ${asked.outboxRowId}, 1, 1, ${`${asked.outboxRowId}/1/1`}, 1, 'words', ${asked.messageId}, 'delivered',
      ${asked.sentAt}, ${asked.deliveredAt}
    )
  `;
  await tx`update open_questions set status = 'open', version = version + 1 where id = ${asked.questionId}`;
}

// ---- the one-kind owner (T-1494) ---------------------------------------------------------------------------------------

/** Bundle v2's id and manifest key, as bundles/v2 publishes it (T-1477): the bundle the one-kind owner's turns pin. */
export const BUNDLE_V2_ID: BundleId = {
  hash: bundleV2Manifest.bundleId.hash,
  build: bundleV2Manifest.bundleId.build,
};
const BUNDLE_V2_MANIFEST_KEY = `bundle/${BUNDLE_V2_ID.hash}/${String(BUNDLE_V2_ID.build)}/manifest`;
const BUNDLE_V2_BUILT_AT = "2026-11-20T10:00:00Z";

/**
 * The roster owner at place 1 (db/seeds/roster-owner.ts rosterOwnerIds(1): the set's own ids, checked against what it
 * answers), texting from a whole fiction-range number of this seed's own, with its Linq chat (a stand-in in K-06's form),
 * and its S1-02 question, live at its business under bundle v2. `version` is the question row's: 2, raised once.
 */
export const ONE_KIND = {
  number: "+15555550178",
  businessId: "biz-roster-owner-1",
  companyId: "company-roster-owner-1",
  personId: "person-roster-owner-1",
  handleId: "handle-roster-owner-1",
  chatId: "linq-chat-t1494-one-kind",
  turnId: "turn-t1494-asked",
  eventId: "evt-t1494-asked",
  traceId: "trace-t1494-asked",
  questionId: "oq-s1-02-t1494-asked-1",
  outboxRowId: "outbox-s1-02-t1494-asked-1",
  messageId: "linq-msg-t1494-asked-0001",
  committedAt: "2026-10-19T18:05:05Z",
  sentAt: "2026-10-19T18:05:07Z",
  deliveredAt: "2026-10-19T18:05:08Z",
  version: 2,
} as const;

/** The roster-owner set run as it is for the one-kind owner's number alone; refused unless it answers place 1's ids. */
async function seedOneKindOwner(sql: Sql): Promise<void> {
  const { ALLOWLIST_VARIABLE, seedRosterOwner } = await import("../../../../db/seeds/roster-owner");
  const seeded = await seedRosterOwner(sql, { env: { [ALLOWLIST_VARIABLE]: ONE_KIND.number } });
  const [owner] = seeded.owners;
  if (
    seeded.owners.length !== 1 ||
    owner?.businessId !== ONE_KIND.businessId ||
    owner.companyId !== ONE_KIND.companyId ||
    owner.personId !== ONE_KIND.personId ||
    owner.handleId !== ONE_KIND.handleId
  ) {
    throw new Error("the tool-api-gate seed: the roster-owner set did not give place 1's ids");
  }
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

  // T-1494: bundle v2's registry row, not active, as a publish writes it (the connecting login); and the roster owner at
  // place 1, the roster-owner set as it is, in its own transaction as rosie_job.
  await sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${BUNDLE_V2_ID.hash}, ${BUNDLE_V2_ID.build}, ${BUNDLE_V2_MANIFEST_KEY}, ${BUNDLE_V2_BUILT_AT}::timestamptz)
  `;
  await seedOneKindOwner(sql);

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

    // T-1470: the catalog item 78 reads, and one live S1-02 question the walk's question read reads.
    for (const row of KIND_ROWS) await insertRow(tx, row);
    await writeAskedQuestion(tx, bundleId);

    // T-1494: the catalog by id's kind_flows; the one-kind owner's key at first sight; its S1-02 question, on bundle v2.
    for (const row of KIND_FLOW_ROWS) await insertRow(tx, row);
    // Its handle and person are the roster-owner set's, so this sight makes the person's key alone.
    const oneKind = await handleSealingKeyIn(tx, SEED_KEYS, {
      handle: { kind: "phone", address: ONE_KIND.number },
      newHandleId: "handle-t1494-unused",
      newPersonId: "person-t1494-unused",
      wrappingKeyName: WRAP_KEY_NAME,
    });
    const oneKindOutcome = oneKind.outcome;
    if (
      !("result" in oneKindOutcome) ||
      oneKindOutcome.handleId !== ONE_KIND.handleId ||
      oneKindOutcome.personId !== ONE_KIND.personId ||
      oneKindOutcome.created.handle ||
      oneKindOutcome.created.person ||
      !oneKindOutcome.created.key
    ) {
      throw new Error("the tool-api-gate seed: the one-kind owner's sight did not make its key alone");
    }
    await writeLiveQuestion(tx, ONE_KIND, ONE_KIND.businessId, BUNDLE_V2_ID);
  });
}
