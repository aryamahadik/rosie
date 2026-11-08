// The outbox rows the messages-and-consent service gives the commit (T-307; C-102; arch 01 line 65: "One message to one
// recipient on one channel: send class (RULES 4.3), versions read, question and plan"), and the rules a row keeps before
// the commit writes it: K-05 v1 outboxRowNew's fields, K-07 v1's channel and port, and the versions the read-back showed.
//
// The commit writes each row as K-07's `planned`, with no plan: words go in after the commit (arch 01 lines 39 to 41;
// K-05 v1 writePlan). Sending is the dispatcher's (C-124), and limit 8 reads every row again at send (C-125).

import type { OutboxRowNew, RowRef } from "../../commit";

/** K-03 v1 channel (K-05 v1 channel; K-04 outbox_rows_channel_known): imessage, rcs or sms through Linq, or email. */
export type Channel = OutboxRowNew["channel"];
export const CHANNELS: readonly Channel[] = ["imessage", "rcs", "sms", "email"];

/** RULES 4.3's send classes (K-05 v1 sendClass): only routine waits for text hours. */
export type SendClass = OutboxRowNew["sendClass"];
export const SEND_CLASSES: readonly SendClass[] = ["routine", "quick_reply", "visit_now", "safety"];

/**
 * K-07 v1 port: linq for the imessage, rcs and sms channels (Linq's own services on Rosie's one number: DL-031), email
 * (Resend) for the email channel. There is no SMS port: no SMS provider (DL-012; MC C9; MC 8 "SMS").
 */
export type Port = "linq" | "email";

/** The port a channel goes through (K-07 v1 outboxRow dependentSchemas: "The port follows the channel"). */
export function portOf(channel: Channel): Port {
  return channel === "email" ? "email" : "linq";
}

/** Why a row is refused before the commit: each names a fault, never a value. */
export type OutboxFault =
  /** A send by an SMS port: there is none (DL-012; K-07 refuse-sms-channel.json). */
  | "smsPort"
  /** A channel and port K-07 v1 does not pair: email by the email port, imessage, rcs and sms through Linq. */
  | "portNotOfChannel"
  /** Not one of K-03 v1's channels. */
  | "channelUnknown"
  /** Not one of RULES 4.3's send classes. */
  | "sendClassUnknown"
  /** A versions-read entry that is not a table, a row id and a version from 1. */
  | "versionNotWellFormed"
  /** One row at two versions: one read-back shows each row once (limit 4 compares one version per row). */
  | "versionTwice";

/** A row refused before the commit (fail closed: nothing is built for it). */
export class OutboxRefusedError extends Error {
  readonly fault: OutboxFault;

  constructor(fault: OutboxFault) {
    super(`outbox row refused: ${fault}`);
    this.name = "OutboxRefusedError";
    this.fault = fault;
  }
}

/** A row's channel and port as K-07 v1 outboxRow carries them. */
export interface ChannelAndPort {
  readonly channel: string;
  readonly port: string;
}

/**
 * Refuses a channel and port K-07 v1 refuses: an SMS port above all (DL-012: there is no SMS provider;
 * refuse-sms-channel.json), then any pair where the port does not follow the channel. Linq's own SMS service in the same
 * chat is the sms channel through the linq port, which passes (DL-031; DL-108 (2)).
 */
export function checkChannelAndPort(row: ChannelAndPort): void {
  if (row.port === "sms") throw new OutboxRefusedError("smsPort");
  const channel = CHANNELS.find((each) => each === row.channel);
  if (channel === undefined) throw new OutboxRefusedError("channelUnknown");
  if (row.port !== portOf(channel)) throw new OutboxRefusedError("portNotOfChannel");
}

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function isRowRef(value: unknown): value is RowRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Partial<Record<keyof RowRef, unknown>>;
  return (
    typeof ref.table === "string" &&
    TABLE_NAME.test(ref.table) &&
    typeof ref.rowId === "string" &&
    ref.rowId.trim() !== "" &&
    typeof ref.version === "number" &&
    Number.isSafeInteger(ref.version) &&
    ref.version >= 1
  );
}

/**
 * Every version the read-back showed, each row once and in the order shown (K-05 v1 outboxRowNew.versionsRead: "The
 * versions it was decided on; limit 8 compares them at send"; arch 06 line 313). Nothing is left out, so a change to any
 * row the message rests on makes it stale at send (S13-57). One row at two versions is refused.
 */
export function versionsReadOf(shown: readonly RowRef[]): RowRef[] {
  const versions: RowRef[] = [];
  const seen = new Map<string, number>();
  for (const entry of shown) {
    if (!isRowRef(entry)) throw new OutboxRefusedError("versionNotWellFormed");
    const key = JSON.stringify([entry.table, entry.rowId]);
    const version = seen.get(key);
    if (version === entry.version) continue;
    if (version !== undefined) throw new OutboxRefusedError("versionTwice");
    seen.set(key, entry.version);
    versions.push({ table: entry.table, rowId: entry.rowId, version: entry.version });
  }
  return versions;
}

/** The fields of K-05 v1 outboxRowNew, in its order: a row the service gives the commit carries these and nothing else. */
export const OUTBOX_ROW_FIELDS: readonly (keyof OutboxRowNew)[] = [
  "id",
  "recipientHandleId",
  "recipientPersonId",
  "businessId",
  "bookingId",
  "channel",
  "sendClass",
  "openQuestionId",
  "copyOfRowId",
  "versionsRead",
];

/** The email copy's id: the text row's id with "-email" (K-04 v1 seed-outbox-row: out-a7-03-alex-email). */
export function emailCopyId(rowId: string): string {
  return `${rowId}-email`;
}
