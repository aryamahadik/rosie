// Where the messages-and-consent service (T-307; C-102) gets its facts: K-04 v1's people, handles, phones and threads,
// and K-29 v1's consent rows, through the data-access calls (db/repo: T-183, T-184, T-192), and one narrow port for the
// reach card, which no frozen part this card reads holds.
//
// The reads hand back K-04's and K-29's rows as db/repo gives them, a phone's number and a handle's address included, so
// the service is the one place that keeps them in: what it answers carries ids, flags and closed lists only, never a
// number, an address, a name or a person's words (K-08 v1 "Never the raw number or words"; CQ-59).

import { listConsentsOfPersons, type ConsentRead } from "../../../../db/repo/consent";
import { getPerson, type Person } from "../../../../db/repo/people";
import {
  getHandle,
  getPhoneByHandle,
  listHandleIdsOfPerson,
  type Handle,
  type Phone,
} from "../../../../db/repo/phones";
import type { Sql, Tx } from "../../../../db/repo/scope";
import { getChatThread, type Thread } from "../../../../db/repo/threads";

/** The K-04 v1 and K-29 v1 reads the service makes, each one data-access call (db/repo). */
export interface MessagesReader {
  /** K-04 persons: the person's stored language (null: the business's language). */
  person(personId: string): Promise<Person | null>;
  /** K-04 person_handles: the handles a person writes from, by id. */
  handleIdsOfPerson(personId: string): Promise<readonly string[]>;
  /** K-04 handles: a phone number or an email address (its kind). */
  handle(handleId: string): Promise<Handle | null>;
  /** K-04 phones: a mobile's one row across every business, with chat open, the service Linq reports and stopped. */
  phoneOfHandle(handleId: string): Promise<Phone | null>;
  /** K-04 threads: the handle's one chat with Rosie's number, or null. */
  chatThreadOf(handleId: string): Promise<Thread | null>;
  /**
   * K-29 consents of these people, without their words, as the call's scope shows them: under a business scope that
   * business's rows only, never a STOP or START row, which has no business (K-29 rule 4; db/repo/consent.ts).
   */
  consentsOfPersons(personIds: readonly string[]): Promise<readonly ConsentRead[]>;
}

/**
 * The reader over the data-access calls, on the call's own transaction: the Tool API's scoped repo (T-290, scope.ts),
 * which reads the primary, uncached, as every decision does (arch 10 line 538).
 */
export function messagesReaderOf(db: Sql | Tx): MessagesReader {
  return {
    person: (personId) => getPerson(db, personId),
    handleIdsOfPerson: (personId) => listHandleIdsOfPerson(db, personId),
    handle: (handleId) => getHandle(db, handleId),
    phoneOfHandle: (handleId) => getPhoneByHandle(db, handleId),
    chatThreadOf: (handleId) => getChatThread(db, handleId),
    consentsOfPersons: (personIds) => listConsentsOfPersons(db, personIds),
  };
}

// ---- the reach card (RULES 4.8; S13-19) ------------------------------------------------------------------------------

/**
 * How a person is reached (RULES 4.8: "texts, calls only, texts only, or email"): calls only is not offered while there
 * is no voice, and texts only works like texts (Q-07's default; MC C2).
 */
export const REACH_WAYS = ["texts", "textsonly", "email"] as const;
export type ReachWay = (typeof REACH_WAYS)[number];

/**
 * A person's reach card at one business (RULES 4.8: "One card asks a mobile ..., an email if they have one, and the
 * way"; S13-19): the way, and the contacts on file by handle id. A null way means no contact is on file, so Rosie sends
 * them nothing and the business reaches them its own way (S13-19).
 */
export interface ReachCard {
  readonly way: ReachWay | null;
  readonly mobileHandleId: string | null;
  readonly emailHandleId: string | null;
}

/**
 * The reach cards on file. No frozen part this card reads holds them (K-04 v1 has no reach way), so the service asks
 * through this port; a reader of the business's customer record is another task's.
 */
export interface ReachCards {
  /** The person's card at the business, or null when none is on file (an owner, a staff member, or none yet). */
  cardOf(businessId: string, personId: string): Promise<ReachCard | null>;
}

/**
 * No card on file for anyone: every message goes back the way the person is writing (S13-19: "Default: the channel
 * they're using"). The default until a reader of the reach card exists.
 */
export const NO_REACH_CARDS: ReachCards = {
  cardOf: () => Promise.resolve(null),
};
