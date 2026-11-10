// The database the turn face's integration tests run on (T-315). Never imported by the Worker.
//
// One fresh schema per test file, migrated with every migration of db/migrations/ and dropped when the file ends (T-306's
// openCommitDatabase over db/repo/test-db.ts; the public schema is never touched), with three clients: the owner's, which
// writes the stored state; the runtime side's, as rosie_job, which the frontier's scope runs on (K-05 v1.2 item 26); and
// the Tool API's, as rosie_app.
//
// The stored state Sam's answer to S1-02 is read from (build-frontier-s1-02.json's note: "the guard lists his two owner
// roles and the open question"):
//   - K-04's seeds: bundle v0's registry row, and seed-phone-chat-open.json with its chain: Lee's Barbershop, the yoga
//     studio and the movers, Sam with his handle, his phone (chat open) and his owner role at each;
//   - turn 1's rows as its commit and its send leave them (DL-322: turn 1 is Sam's first text, and its one reply asks
//     S1-02): the turn turn-s1-01-sam (K-09's compose-input-s1-02.json and finalize-pass.json; its text and trace are K-08
//     trace-skeleton.json's), the open question oq-s1-02 (build-frontier-s1-02.json: S1-02 at Lee's Barbershop, about no
//     booking, asked once under bundle v0, with no options as sent: S1-02's question is typed back, finalize-pass.json's
//     optionIds []), and its one outbox row outbox-s1-02-sam-1 with the plan and final parts finalize-pass.json writes,
//     whose one part was sent and delivered at 14:02:00Z, the send time build-frontier-s1-02.json's open question names;
//   - this test's own rows: at Sam's yoga studio, S1-02 asked of the same handle too (sent at 14:03:00Z), so each
//     business's call has a question of its own that the other's must never see.
// Every row is written directly as the owner, since the calls that write them (T-1139's walk, T-1141's commit and
// finalize, the dispatcher's send and receipt) are not all on main: as in T-219's and T-306's tests, each of turn 1's rows
// is what its fixture states. Values come only from the contracts' fixtures and the master's sample cast (rule 9).

import { insertRow, openCommitDatabase, seed, type CommitDatabase } from "../../../commit/pg/test-support";
import { BUNDLE_V0 } from "../../../frontier/assemble/test-support";
import { fixture } from "../../test-support";

export const BARBERSHOP = "biz-lees-barbershop";
export const YOGA = "biz-yoga-studio";
export const SAM_HANDLE = "handle-sam";

/** K-04's seeds every test loads (each file's own `after` chain first). */
export const CORE_SEEDS = ["seed-bundle-registry.json", "seed-phone-chat-open.json"];

/** The yoga studio's own S1-02 question to Sam: this test's rows, and when its part went. */
export const YOGA_QUESTION = "oq-t315-yoga";
export const YOGA_SENT_AT = "2026-10-19T14:03:00Z";

interface Row {
  readonly table: string;
  readonly values: Record<string, unknown>;
}

interface FinalizePass {
  readonly request: { readonly plan: unknown };
  readonly outcome: { readonly finalParts: unknown };
}

const bundle = { bundle_hash: BUNDLE_V0.hash, bundle_build: BUNDLE_V0.build };

/** One question asked of Sam's handle by one committed turn, and its one outbox row, delivered (see the top). */
function askedRows(asked: {
  turnId: string;
  eventId: string;
  traceId: string;
  committedAt: string;
  questionId: string;
  businessId: string;
  rowId: string;
  plan: unknown;
  finalParts: unknown;
  linqMessageId: string;
  sentAt: string;
}): Row[] {
  return [
    {
      table: "turns",
      values: {
        id: asked.turnId,
        handle_id: SAM_HANDLE,
        event_ids: [asked.eventId],
        state: "committed",
        ...bundle,
        trace_id: asked.traceId,
        committed_at: asked.committedAt,
      },
    },
    {
      table: "open_questions",
      values: {
        id: asked.questionId,
        turn_id: asked.turnId,
        handle_id: SAM_HANDLE,
        person_id: "person-sam",
        business_id: asked.businessId,
        booking_id: null,
        step: "S1-02",
        options: [],
        readback: null,
        versions_read: [],
        ...bundle,
        clock: null,
        ask_count: 1,
        status: "open",
      },
    },
    {
      table: "outbox_rows",
      values: {
        id: asked.rowId,
        turn_id: asked.turnId,
        recipient_handle_id: SAM_HANDLE,
        recipient_person_id: "person-sam",
        business_id: asked.businessId,
        booking_id: null,
        channel: "imessage",
        versions_read: [],
        open_question_id: asked.questionId,
        plan: asked.plan,
        final_parts: asked.finalParts,
        state: "delivered",
        ...bundle,
        trace_id: asked.traceId,
      },
    },
    {
      table: "outbox_parts",
      values: {
        outbox_row_id: asked.rowId,
        part_no: 1,
        try_no: 1,
        idempotency_key: `${asked.rowId}/1/1`,
        kind: "words",
        linq_message_id: asked.linqMessageId,
        state: "delivered",
        sent_at: asked.sentAt,
        delivered_at: asked.sentAt,
      },
    },
  ];
}

/** Turn 1's rows (Lee's Barbershop asks S1-02), then the yoga studio's own S1-02 question to the same handle. */
export function questionRows(): Row[] {
  const pass = fixture("finalize-pass.json") as FinalizePass;
  return [
    ...askedRows({
      turnId: "turn-s1-01-sam",
      eventId: "evt-sam-0000",
      traceId: "trace-sam-0000",
      committedAt: "2026-10-19T14:01:55.930Z",
      questionId: "oq-s1-02",
      businessId: BARBERSHOP,
      rowId: "outbox-s1-02-sam-1",
      plan: pass.request.plan,
      finalParts: pass.outcome.finalParts,
      linqMessageId: "linq-msg-demo-0100",
      sentAt: "2026-10-19T14:02:00Z",
    }),
    ...askedRows({
      turnId: "turn-t315-yoga",
      eventId: "evt-t315-yoga",
      traceId: "trace-t315-yoga",
      committedAt: "2026-10-19T14:02:55Z",
      questionId: YOGA_QUESTION,
      businessId: YOGA,
      rowId: "out-t315-yoga",
      plan: null,
      finalParts: null,
      linqMessageId: "linq-msg-t315-yoga",
      sentAt: YOGA_SENT_AT,
    }),
  ];
}

/** The jsonb and bytea columns of this schema's tables, by `table.column` (insertRow's conversions). */
async function typedColumns(cdb: CommitDatabase): Promise<Map<string, string>> {
  const rows = await cdb.db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${cdb.db.schema} and data_type in ('jsonb', 'bytea')
  `;
  return new Map(rows.map((row) => [row.key, row.type]));
}

/**
 * This file's schema and clients (connections per client: `max`), with K-04's seeds and the questions above loaded as the
 * owner. The caller closes it.
 */
export async function openTurnFaceDatabase(max: number): Promise<CommitDatabase> {
  const cdb = await openCommitDatabase("turn_face", max);
  try {
    await seed(cdb, CORE_SEEDS);
    const typed = await typedColumns(cdb);
    const rows = questionRows();
    await cdb.db.sql.begin(async (tx) => {
      for (const row of rows) await insertRow(tx, typed, row.table, row.values);
    });
  } catch (error) {
    await cdb.close();
    throw error;
  }
  return cdb;
}
