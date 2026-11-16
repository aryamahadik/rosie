// What the stop home reads (T-590): one person's contact at one business, through the ports the messages-and-consent
// service (T-307: MessagesReader) and the record flags (T-317: FlagsReader) already read with, each member one data-access
// call on K-04 v1 and K-29 v1 (db/repo). No other read is made, and none is made by default: the caller hands the reads
// in, bound to the side it runs on. On the runtime side (no business scope) K-29's rows for every business show, a STOP's
// and a START's among them; under a business scope they do not (K-29 rule 4), and the stopped flag on the number's one
// phones row tells the stop (MC C1). A default reader on a scoped transaction is never made here (T-1163's lead note 1:
// rosie_app has no grant on phones and sees no row with no business).
//
// The reads hand back rows as db/repo gives them, a number or an address included; the reading keeps ids, flags, times
// and labels only, never a number, an address, a name or anyone's words.

import type { FlagsReader } from "../../domain/flags";
import type { ConsentWrite, MessagesReader } from "../../domain/messages-consent";
import { StopHomeError } from "./errors";
import type { StopReading, TextsRow } from "./stop";

/** The reads the stop home makes: T-307's and T-317's port members, each one data-access call. */
export type StopHomeReads = Pick<
  MessagesReader,
  "handle" | "handleIdsOfPerson" | "phoneOfHandle" | "consentsOfPersons"
> &
  Pick<FlagsReader, "personIdsOfHandle">;

/** One person's contact at one business, and the consent rows this turn's commit writes beside the record's. */
export interface StopReadRequest {
  readonly personId: string;
  /** The business the text would be for; null for Rosie's own texts for no business. */
  readonly businessId: string | null;
  readonly handleId: string;
  /** The consent rows this turn writes (T-307's yes(), stop() and start(); T-317's), read as if on file. */
  readonly written?: readonly ConsentWrite[];
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A consent row this turn writes, as a texts row the home reads (its words left out). */
function rowOfWrite(write: ConsentWrite): TextsRow {
  const { values } = write;
  return {
    id: values.id,
    personId: values.person_id,
    businessId: values.business_id,
    kind: values.kind,
    revoked: values.revoked,
    handleId: values.handle_id,
    bookingId: values.booking_id,
    at: new Date(values.at),
    channel: values.channel,
    turnId: values.turn_id,
  };
}

/** A K-29 row on file, as a texts row the home reads (ConsentRead holds no words). */
function rowOfRead(row: TextsRow): TextsRow {
  return {
    id: row.id,
    personId: row.personId,
    businessId: row.businessId,
    kind: row.kind,
    revoked: row.revoked,
    handleId: row.handleId,
    bookingId: row.bookingId,
    at: row.at,
    channel: row.channel,
    turnId: row.turnId,
  };
}

/**
 * Reads one person's contact at one business through the ports given: the handle's kind, whether it is the person's own,
 * the mobile's phones row (stopped, stop_at, the opt-out line's delivery) and the K-29 texts rows of everyone behind the
 * contact, with the rows this turn writes. Throws StopHomeError for a request that names no person or contact.
 */
export async function readStop(reads: StopHomeReads, request: StopReadRequest): Promise<StopReading> {
  const { personId, businessId: business, handleId }: Record<string, unknown> = { ...request };
  if (!isId(personId)) throw new StopHomeError("the request names no person");
  if (!isId(handleId)) throw new StopHomeError("the request names no contact");
  if (business !== null && !isId(business)) throw new StopHomeError("the request's business is not an id");
  const businessId = isId(business) ? business : null;

  const handle = await reads.handle(handleId);
  const kind = handle?.id === handleId ? handle.kind : null;
  const own = (await reads.handleIdsOfPerson(personId)).includes(handleId);
  const phoneRow = kind === "phone" ? await reads.phoneOfHandle(handleId) : null;
  const phone =
    phoneRow?.handleId === handleId
      ? {
          handleId,
          stopped: phoneRow.stopped,
          stopAt: phoneRow.stopAt,
          optoutLineDeliveredAt: phoneRow.optoutLineDeliveredAt,
        }
      : null;

  // Everyone behind the contact: one number stops every business, whoever on it sent the STOP (MC C1).
  const people = [...new Set([personId, ...(await reads.personIdsOfHandle(handleId))])].sort(byId);
  const ofContact = (row: TextsRow): boolean => row.kind === "texts" && row.handleId === handleId;
  const onFile = (await reads.consentsOfPersons(people)).filter(ofContact).map(rowOfRead);
  const known = new Set(onFile.map((row) => row.id));
  const written = (request.written ?? [])
    .map(rowOfWrite)
    .filter((row) => ofContact(row) && !known.has(row.id));

  return {
    personId,
    businessId,
    handleId,
    kind,
    own,
    phone,
    texts: [...onFile, ...written],
  };
}
