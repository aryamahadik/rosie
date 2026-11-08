// The hard invariant of the stopped flag (T-317; C-078; arch 03 line 175: "Stopped (phone, every business): only stop
// replies, safety lines and a new booking's texts after its fresh yes from that phone"; RULES 7.2, 7.3, 7.5; MC C1;
// S13-32 line 7242): with a phone stopped, the turn's commit holds no text row to it but
//   - the stop's own reply (or START's), which this commit's recordStopOrStart built (its reply row id);
//   - a safety line (send class safety: arch 02 line 111, "past any opt-out"; RULES 4.12);
//   - a text about a booking whose fresh yes to texts came from that phone in this turn (T-307's yes() for a stopped
//     mobile: kind texts, that booking, sent by text from that number), newer than the stop.
// "Stopped" is the phone's flag as this commit leaves it: a STOP written in the same commit binds every row beside it,
// and a texts row withdrawn at one business (a work phone's answer, a contact that switched away) binds that business's
// rows the same way (STATE notes 9 to 11; QUESTIONS.md CQ-74).
//
// keepStop takes every other row to a stopped phone out of the commit before it is sent (limit 8 drops them at send too:
// arch 06 line 313; T-1099), and an email copy of a text row taken out goes alone; assertStopKept refuses a commit that
// still holds one. rowsAfterFreshYes builds the one row a fresh yes lets through, which T-307's outboxRows reports
// stopped (it fails closed for every row a stopped mobile does not take).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A yes lifts a stop for its booking only when the commit that writes it is the turn of that phone itself: the
//      record does not say who gave an older yes or from where (K-29 v1 has no such column; limit 8's notKnown), so a
//      later turn's rows for that booking stay out until START (fail closed, as limit 8 does at send).
//   2. A stop whose time is not known lets no yes past it.
//   3. A text row's channel is imessage, rcs or sms (all through Linq: DL-031); an email row is never a text, so a STOP of
//      the phone never takes it out (RULES 7.2: it stops texts from the number it answers).

import type { CommitUnit, OutboxRowNew, StateWrite } from "../../commit";
import {
  CONSENTS_TABLE,
  checkChannelAndPort,
  emailCopyId,
  newestDecides,
  portOf,
  versionsReadOf,
  type ConsentWrite,
  type MessageRequest,
  type MessageRows,
  type MessagesConsent,
  type MessagesReader,
} from "../messages-consent";
import { FlagRefusedError } from "./errors";
import type { ConsentRead, Phone } from "./reads";

const TEXT_CHANNELS: readonly string[] = ["imessage", "rcs", "sms"];

/** Whether a row goes by text (imessage, rcs or sms through Linq), not by email (default 3). */
export const isTextRow = (row: Pick<OutboxRowNew, "channel">): boolean => TEXT_CHANNELS.includes(row.channel);

/** What the stopped flag lets through, a label (never a value). */
export type LetThrough = "safety" | "reply" | "freshYes";

/** The turn whose commit it is: a yes in it, sent from its handle, came from that number. */
export interface CommitTurnRef {
  readonly id: string;
  readonly handleId: string;
}

/** What one commit's rows are held to. */
export interface CommitStop {
  /** The turn the commit is under, or null for a commit with no turn (it writes no outbox row anyway). */
  readonly turn: CommitTurnRef | null;
  /** The replies this commit's own STOP and START records built (recordStopOrStart's reply row ids). */
  readonly replies: ReadonlySet<string>;
}

/** The reads the invariant makes: a mobile's phone row, and the texts rows on file of the people a row is for. */
export interface StopReads {
  phoneOfHandle(handleId: string): Promise<Phone | null>;
  /** K-29 consents as the call's scope shows them (a business's own rows; on the runtime side every row). */
  consentsOfPersons(personIds: readonly string[]): Promise<readonly ConsentRead[]>;
}

/** A texts row as the invariant compares it: on file (ConsentRead) or written by this commit (a consent insert). */
interface TextsRow {
  readonly id: string;
  readonly personId: string;
  readonly businessId: string | null;
  readonly handleId: string | null;
  readonly bookingId: string | null;
  readonly revoked: boolean;
  readonly at: Date;
  readonly channel: string;
  readonly turnId: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A texts row on file, as the invariant compares it (never its words: ConsentRead has none). */
const textsRowOf = (row: ConsentRead): TextsRow => ({
  id: row.id,
  personId: row.personId,
  businessId: row.businessId,
  handleId: row.handleId,
  bookingId: row.bookingId,
  revoked: row.revoked,
  at: row.at,
  channel: row.channel,
  turnId: row.turnId,
});

/** The texts rows a commit's state writes insert (K-29 consents, kind texts). */
function textsInserted(state: readonly StateWrite[]): TextsRow[] {
  const rows: TextsRow[] = [];
  for (const write of state) {
    if (write.op !== "insert" || write.table !== CONSENTS_TABLE) continue;
    const { values } = write;
    const id = text(values.id);
    const personId = text(values.person_id);
    const at = text(values.at);
    if (id === null || personId === null || at === null || values.kind !== "texts") continue;
    rows.push({
      id,
      personId,
      businessId: text(values.business_id),
      handleId: text(values.handle_id),
      bookingId: text(values.booking_id),
      revoked: values.revoked === true,
      at: new Date(at),
      channel: text(values.channel) ?? "",
      turnId: text(values.turn_id),
    });
  }
  return rows;
}

/** A phone as this commit leaves it: its flag and stop time after the commit's own phone writes (K-04 phones). */
function phoneAfter(phone: Phone, state: readonly StateWrite[]): { stopped: boolean; stopAt: Date | null } {
  let stopped = phone.stopped;
  let stopAt = phone.stopAt;
  for (const write of state) {
    if (write.op !== "update" || write.table !== "phones" || write.key.number !== phone.number) continue;
    if (typeof write.set.stopped === "boolean") stopped = write.set.stopped;
    const at = text(write.set.stop_at);
    if (at !== null) stopAt = new Date(at);
  }
  return { stopped, stopAt };
}

/** Why a row to a stopped mobile may go, or null when the flag forbids it. */
function letsThrough(
  row: OutboxRowNew,
  since: Date | null,
  inserted: readonly TextsRow[],
  commit: CommitStop,
): LetThrough | null {
  if (row.sendClass === "safety") return "safety";
  if (commit.replies.has(row.id)) return "reply";
  const { turn } = commit;
  if (since === null || turn?.handleId !== row.recipientHandleId) return null;
  if (row.bookingId === null || row.businessId === null) return null;
  const freshYes = inserted.some(
    (yes) =>
      !yes.revoked &&
      yes.bookingId === row.bookingId &&
      yes.businessId === row.businessId &&
      yes.handleId === row.recipientHandleId &&
      yes.channel === "text" &&
      yes.turnId === turn.id &&
      yes.at.getTime() > since.getTime(),
  );
  return freshYes ? "freshYes" : null;
}

/** One row to a stopped mobile the commit may not hold. */
export interface Dropped {
  readonly rowId: string;
  readonly handleId: string;
}

/** The commit's units with every row the stopped flag forbids taken out. */
export interface StopKept {
  readonly units: CommitUnit[];
  readonly dropped: readonly Dropped[];
}

/**
 * The rows of a commit the stopped flag forbids (the module note): each text row to a mobile that is stopped once the
 * commit's own writes are in, or whose texts are withdrawn at the row's business, that is not this commit's own reply, a
 * safety line or a text its booking's fresh yes in this turn lets through.
 */
export async function rowsAfterStop(
  units: readonly CommitUnit[],
  commit: CommitStop,
  reads: StopReads,
): Promise<Dropped[]> {
  const state = units.flatMap((unit) => unit.writes.state);
  const inserted = textsInserted(state);
  const dropped: Dropped[] = [];
  for (const row of units.flatMap((unit) => unit.writes.messages)) {
    if (!isTextRow(row)) continue;
    const phone = await reads.phoneOfHandle(row.recipientHandleId);
    if (phone?.handleId !== row.recipientHandleId) continue;
    const after = phoneAfter(phone, state);
    let since: Date | null = after.stopped ? after.stopAt : null;
    let stopped = after.stopped;
    if (!stopped && row.businessId !== null && row.recipientPersonId !== null) {
      // Texts withdrawn at the row's business: the newest texts row for this contact there, on file or in this commit.
      const onFile = (await reads.consentsOfPersons([row.recipientPersonId]))
        .filter((each) => each.kind === "texts")
        .map(textsRowOf);
      const newest = newestDecides(
        [...onFile, ...inserted].filter(
          (each) =>
            each.personId === row.recipientPersonId &&
            each.handleId === row.recipientHandleId &&
            (each.businessId === row.businessId || each.businessId === null),
        ),
      );
      if (newest?.revoked === true) {
        stopped = true;
        since = newest.at;
      }
    }
    if (!stopped) continue;
    if (letsThrough(row, since, inserted, commit) === null) {
      dropped.push({ rowId: row.id, handleId: row.recipientHandleId });
    }
  }
  return dropped;
}

/**
 * The commit with every row the stopped flag forbids taken out, before anything is sent: a STOP commits at once and
 * whole, so a row it forbids is dropped rather than the commit refused. An email copy of a text row taken out goes alone.
 */
export async function keepStop(
  units: readonly CommitUnit[],
  commit: CommitStop,
  reads: StopReads,
): Promise<StopKept> {
  const dropped = await rowsAfterStop(units, commit, reads);
  const out = new Set(dropped.map((each) => each.rowId));
  const kept = units.map((unit): CommitUnit => {
    const messages = unit.writes.messages
      .filter((row) => !out.has(row.id))
      .map((row) =>
        row.copyOfRowId !== null && out.has(row.copyOfRowId) ? { ...row, copyOfRowId: null } : { ...row },
      );
    return { ...unit, writes: { ...unit.writes, messages } };
  });
  return { units: kept, dropped };
}

/** Refuses a commit that still holds a row the stopped flag forbids (fail closed: FlagRefusedError textAfterStop). */
export async function assertStopKept(
  units: readonly CommitUnit[],
  commit: CommitStop,
  reads: StopReads,
): Promise<void> {
  const dropped = await rowsAfterStop(units, commit, reads);
  if (dropped.length > 0) {
    throw new FlagRefusedError(
      "textAfterStop",
      dropped.map((each) => each.rowId),
    );
  }
}

/**
 * The rows of one message about a booking, with its fresh yes from a stopped mobile in this turn: T-307's rows, and the
 * text row it reports stopped built when the yes lets it through (the module note; S13-32 line 7242), its email copy
 * then naming it. The row waits at send for a chat a stopped phone keeps closed until START (QUESTIONS.md CQ-74).
 */
export async function rowsAfterFreshYes(
  messages: MessagesConsent,
  reader: MessagesReader,
  message: MessageRequest,
  yes: ConsentWrite,
  turn: CommitTurnRef,
): Promise<MessageRows> {
  const built = await messages.outboxRows(message);
  const held = built.notBuilt.find((each) => each.medium === "text" && each.why === "stopped");
  const handleId = held?.handleId ?? null;
  if (held === undefined || handleId === null || message.bookingId === null) return built;
  const phone = await reader.phoneOfHandle(handleId);
  if (phone?.handleId !== handleId || phone.stopAt === null) return built;
  const { values } = yes;
  const lets =
    values.kind === "texts" &&
    !values.revoked &&
    values.booking_id === message.bookingId &&
    values.business_id === messages.businessId &&
    values.handle_id === handleId &&
    values.channel === "text" &&
    values.turn_id === turn.id &&
    turn.handleId === handleId &&
    Date.parse(values.at) > phone.stopAt.getTime();
  if (!lets) return built;
  const channel = phone.chatWay ?? "imessage";
  checkChannelAndPort({ channel, port: portOf(channel) });
  const textRow: OutboxRowNew = {
    id: message.id,
    recipientHandleId: handleId,
    recipientPersonId: message.to.personId,
    businessId: messages.businessId,
    bookingId: message.bookingId,
    channel,
    sendClass: message.sendClass,
    openQuestionId: message.openQuestionId,
    copyOfRowId: null,
    versionsRead: versionsReadOf(message.versionsRead),
  };
  const others = built.rows.map((row) =>
    row.id === emailCopyId(message.id) ? { ...row, copyOfRowId: textRow.id } : row,
  );
  return { rows: [textRow, ...others], notBuilt: built.notBuilt.filter((each) => each !== held) };
}
