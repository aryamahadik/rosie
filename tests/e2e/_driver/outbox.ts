// The outbox rows a turn wrote (T-465; C-148), read as K-07 v1 records: one outbox row's life each (the row, its parts,
// its claim, every move in order). Each is checked against K-07 v1's schema, which lists the only moves allowed, and
// its named rule lifeChain, which checks that the moves chain in time under the retry rules (contracts/outbox-effects
// README). The rows come from an OutboxReader the target is given: the local database through the data-access calls
// once they exist, or any other reader of K-04's outbox tables in K-07's names.
//
// Problems name a row by its id and say what is wrong by place and rule, never by a part's words.

import type { OutboxLife } from "../../../contracts/generated/outbox-effects/outbox-effects.v1";
import { K07, lifeChain, schemaProblems } from "./contracts";

/** Reads the outbox rows written under one trace id, as K-07 v1 records (`record: "outboxRow"`). */
export type OutboxReader = (traceId: string) => readonly unknown[] | Promise<readonly unknown[]>;

export interface OutboxCheck {
  /** The records that are K-07 v1 outbox rows, in the order read. */
  readonly rows: readonly OutboxLife[];
  /** One line per problem, each naming its row; empty when every record passes. */
  readonly problems: readonly string[];
}

function nameOf(record: unknown, index: number): string {
  const row = (record as { row?: { id?: unknown } } | null)?.row;
  return typeof row?.id === "string" ? `row ${row.id}` : `record ${String(index + 1)}`;
}

/**
 * Checks each record as one K-07 v1 outbox row's life: the schema (its moves are allowed ones) and lifeChain (they
 * chain). With `traceId`, each row must also have been written under that trace.
 */
export async function checkOutboxRows(records: readonly unknown[], traceId?: string): Promise<OutboxCheck> {
  const chain = await lifeChain();
  const rows: OutboxLife[] = [];
  const problems: string[] = [];
  records.forEach((record, index) => {
    const name = nameOf(record, index);
    if ((record as { record?: unknown } | null)?.record !== "outboxRow") {
      problems.push(`${name} is not a K-07 v1 outbox row (record "outboxRow")`);
      return;
    }
    const schema = schemaProblems(K07, undefined, record);
    if (schema.length > 0) {
      problems.push(...schema.map((line) => `${name}: ${line}`));
      return;
    }
    const life = record as OutboxLife;
    problems.push(...chain(life).map((line) => `${name}: ${line}`));
    if (traceId !== undefined && life.row.traceId !== traceId) {
      problems.push(`${name} was written under trace ${life.row.traceId}, not ${traceId}`);
    }
    rows.push(life);
  });
  return { rows, problems };
}
