// Who a page or an alert reaches, and on which handle (T-319; QUESTIONS.md M3-M3b.5; K-36 v1 team_page_recipients; Q-18;
// MC C9; build prompt 9.4). Every recipient is a handle's id, never a number or an address (K-08 v1 handleRef).
//
//   - Rosie's team is every member live on team_page_recipients when the page goes (K-36 rule 5), each in their own open
//     chat with Rosie, else by email (M3-M3b.5): Rosie never writes first (MC C9), so a member with no open chat and no
//     email gets no row and the page waits in the team console for them. Until launch the members are Jay and the CTO
//     (Q-18), whose rows the binding reads.
//   - Whoever the owner named (a hand_off page's named_person_id) and the person a hand-off tells are reached the same
//     way: their first open chat, else their first email.
//   - Outside production every recipient resolves to a roster test phone or the test console alone (build prompt 9.4;
//     M3-M3b.5; the user's rule, DL-839): a handle the roster does not list as a test phone gets no row, so no real
//     person's number or address is ever written to from staging. A row to an email address is never a test phone's.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Any ENVIRONMENT other than exactly "production" resolves as staging does (fail closed): a preview, a local run or a
//      mistyped value pages no real person.
//   2. A chat Linq has reported no service for is texted by iMessage (T-307's default 2; arch 02 line 125: "iMessage first
//      for texts").
//   3. The members are taken in the list's order: by added_at, then the recipient row's id; a person is paged once a page
//      even when also named (one row per person).

import type { OutboxRowNew } from "../../commit";
import {
  PRODUCTION_ENVIRONMENT,
  type ChatState,
  type PagingReader,
  type PersonReach,
  type TeamMember,
  type TestRoster,
} from "./ports";

/** K-05 v1 outboxRowNew.channel. */
export type Channel = OutboxRowNew["channel"];

/** A person reached on one handle, by one channel. */
export interface Reached {
  readonly personId: string;
  readonly handleId: string;
  readonly channel: Channel;
}

/** Why a person gets no row and is left to the console. */
export type ConsoleWhy =
  /** No open chat with Rosie and no email: Rosie never writes first (MC C9). */
  | "notReachable"
  /** Outside production, a handle that is not a roster test phone (build prompt 9.4). */
  | "notTestPhone";

/** Where one person's page or alert goes: a row to a handle, or the console alone. */
export type Resolution =
  | { readonly to: "row"; readonly reached: Reached }
  | { readonly to: "console"; readonly personId: string; readonly why: ConsoleWhy };

/** What resolving a recipient reads: the environment and staging's roster. */
export interface RecipientContext {
  /** The Worker's ENVIRONMENT. */
  readonly environment: string;
  readonly roster: TestRoster;
}

/** Whether real people may be paged here: exactly "production" (default 1). */
export function isProduction(environment: string): boolean {
  return environment === PRODUCTION_ENVIRONMENT;
}

/** A chat's channel: its reported service, else iMessage (default 2). */
function chatChannel(chat: ChatState): Channel {
  return chat.way ?? "imessage";
}

/** The members live on the list at `at` (added at or before it, not yet removed), in the list's order (default 3). */
export function membersAt(members: readonly TeamMember[], at: string): TeamMember[] {
  const atMs = Date.parse(at);
  return members
    .filter(
      (member) =>
        Date.parse(member.addedAt) <= atMs &&
        (member.removedAt === null || Date.parse(member.removedAt) > atMs),
    )
    .sort((a, b) =>
      a.addedAt === b.addedAt ? (a.id < b.id ? -1 : 1) : Date.parse(a.addedAt) - Date.parse(b.addedAt),
    );
}

/** A member's way: their own chat while it is open, else their email (M3-M3b.5), else none. */
export async function memberWay(member: TeamMember, reader: PagingReader): Promise<Reached | null> {
  if (member.chatHandleId !== null) {
    const chat = await reader.chat(member.chatHandleId);
    if (chat?.open === true) {
      return { personId: member.personId, handleId: chat.handleId, channel: chatChannel(chat) };
    }
  }
  if (member.emailHandleId !== null) {
    return { personId: member.personId, handleId: member.emailHandleId, channel: "email" };
  }
  return null;
}

/** A person's way: their first open chat, else their first email, else none (MC C9). */
export function personWay(reach: PersonReach): Reached | null {
  const chat = reach.chats.find((each) => each.open);
  if (chat !== undefined)
    return { personId: reach.personId, handleId: chat.handleId, channel: chatChannel(chat) };
  const email = reach.emails[0];
  return email === undefined ? null : { personId: reach.personId, handleId: email, channel: "email" };
}

/**
 * Where a person's row goes: in production, their way; anywhere else, their way only when it is a roster test phone,
 * else the test console (build prompt 9.4; default 1).
 */
export async function resolve(
  personId: string,
  way: Reached | null,
  context: RecipientContext,
): Promise<Resolution> {
  if (way === null) return { to: "console", personId, why: "notReachable" };
  if (isProduction(context.environment)) return { to: "row", reached: way };
  if (way.channel !== "email" && (await context.roster.isTestPhone(way.handleId))) {
    return { to: "row", reached: way };
  }
  return { to: "console", personId, why: "notTestPhone" };
}

/** Where a person told is reached (the owner, whoever the owner named), read and resolved. */
export async function resolvePerson(
  personId: string,
  reader: PagingReader,
  context: RecipientContext,
): Promise<Resolution> {
  const reach = await reader.reachOf(personId);
  return resolve(personId, reach === null ? null : personWay(reach), context);
}

/**
 * Who one page reaches: every member live at `at`, then whoever the owner named when the page names them and they are not
 * a member already (default 3), each resolved. Empty when no member is live (pageTeam's noRecipients).
 */
export async function pageRecipients(
  input: { readonly at: string; readonly namedPersonId: string | null },
  reader: PagingReader,
  context: RecipientContext,
): Promise<{ readonly members: readonly TeamMember[]; readonly resolved: readonly Resolution[] }> {
  const members = membersAt(await reader.members(), input.at);
  const resolved: Resolution[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.personId)) continue;
    seen.add(member.personId);
    resolved.push(await resolve(member.personId, await memberWay(member, reader), context));
  }
  if (input.namedPersonId !== null && !seen.has(input.namedPersonId)) {
    resolved.push(await resolvePerson(input.namedPersonId, reader, context));
  }
  return { members, resolved };
}
