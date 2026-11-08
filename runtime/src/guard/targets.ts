// The guard's targets (T-250; C-051). Arch 02 step 3 (architecture.txt line 115): "It then lists the handle's roles, open
// questions and bookings. ... No target: the doors." The read is K-05 v1.2 `handleTargets` (item 27; QUESTIONS.md NQ-RT-2's
// default: "a handle's targets", primary and uncached, on the runtime side across businesses), served by T-220 and joined
// at D-017 (T-556) through `setGuardDeps`; a fake answers in tests.
//
// What the guard hands on is K-09 v1 `guardTargets`, the frontier's input (`buildFrontier.request.targets`):
//   - roles: each person's live roles at each business, in K-05's order (persons by id, each one's roles by business, then
//     role); the roles choose the doors (an owner's command, S11-12; a team change, S11-42), as K-05's targets-sam-owner
//     shows, and are not themselves targets;
//   - openQuestionIds: every live open question sent to the handle, every business's (arch 03 line 159; S13-12);
//   - bookingIds: the bookings its people booked or are served by, in every stage (the stage picks the hub: arch 03 line
//     163);
//   - noTarget: true when there is no open question and no booking, so the doors are offered (arch 03 line 165).
// The targets are the open questions and the bookings, each one: two open questions and one booking are three targets.
// Several targets fitting is decide's to settle (S13-27 rule 29), and a tie's lettered "which?" the action layer's (S13-12).
//
// An answer that is not K-05's (another handle's, a role K-04 does not name, an id that is not text) is refused as
// `badAnswer`, and the guard hands nothing to decide on it. Never logged: a text's words; nothing here reads any.

import {
  ROLES,
  type GuardErrorCode,
  type GuardRole,
  type GuardTargets,
  type HandleTargetsPort,
  type Role,
} from "./types";

/** What the guard needs from outside, set once per Worker isolate (`setGuardDeps`); joins at D-017 (T-556). */
export interface GuardDeps {
  /** K-05 v1.2 `handleTargets`. */
  targets: HandleTargetsPort;
}

let deps: GuardDeps | null = null;

/** Sets what the guard needs for this Worker isolate; returns the function that puts the earlier one back. */
export function setGuardDeps(next: GuardDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

/** How many of each list K-05 answered (the guard span's `got`). */
export interface TargetCounts {
  roles: number;
  openQuestions: number;
  bookings: number;
}

/** The checked read: K-09's targets with K-05's counts, or why there are none. */
export type TargetsRead =
  | { result: "targets"; targets: GuardTargets; counts: TargetCounts }
  | { result: "failed"; errorCode: Exclude<GuardErrorCode, "noKeywords"> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** An opaque K-05 id: a non-empty string, compared whole and never parsed (CQ-09). */
const isId = (value: unknown): value is string => typeof value === "string" && value !== "";

const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value);

/** The ids of a K-05 list of rows (each row's `id`), or null when it is not a list of rows that each carry one. */
function idsOf(value: unknown): string[] | null {
  if (!isList(value)) return null;
  const ids: string[] = [];
  for (const row of value) {
    const id = isRecord(row) ? row.id : undefined;
    if (!isId(id)) return null;
    ids.push(id);
  }
  return ids;
}

/** The roles of K-05's `persons`, each with its person, in K-05's order; null when it is not K-05's shape. */
function rolesOf(value: unknown): GuardRole[] | null {
  if (!isList(value)) return null;
  const roles: GuardRole[] = [];
  for (const person of value) {
    if (!isRecord(person) || !isId(person.personId) || !isList(person.roles)) return null;
    for (const role of person.roles) {
      if (!isRecord(role) || !isId(role.businessId) || !isRole(role.role)) return null;
      roles.push({ businessId: role.businessId, personId: person.personId, role: role.role });
    }
  }
  return roles;
}

/**
 * K-05 v1.2 `handleTargets`'s answer for `handleId`, checked and made K-09's `guardTargets`: the answer must be K-05's
 * response for that same handle, or one of its errors.
 */
export function targetsOf(answer: unknown, handleId: string): TargetsRead {
  if (!isRecord(answer)) return { result: "failed", errorCode: "badAnswer" };
  if (answer.error === "notFound") return { result: "failed", errorCode: "notFound" };
  if (answer.error === "transient") return { result: "failed", errorCode: "transient" };
  if (answer.result !== "targets" || answer.handleId !== handleId) {
    return { result: "failed", errorCode: "badAnswer" };
  }
  const roles = rolesOf(answer.persons);
  const openQuestionIds = idsOf(answer.openQuestions);
  const bookingIds = idsOf(answer.bookings);
  if (roles === null || openQuestionIds === null || bookingIds === null) {
    return { result: "failed", errorCode: "badAnswer" };
  }
  return {
    result: "targets",
    targets: {
      roles,
      openQuestionIds,
      bookingIds,
      noTarget: openQuestionIds.length === 0 && bookingIds.length === 0,
    },
    counts: { roles: roles.length, openQuestions: openQuestionIds.length, bookings: bookingIds.length },
  };
}

/**
 * Reads the handle's targets through K-05 v1.2 `handleTargets` (the port set by `setGuardDeps`), checked. Never throws: a
 * port that is not set, fails or answers anything but K-05's response for this handle gives `failed` with its code.
 */
export async function readTargets(handleId: string): Promise<TargetsRead> {
  const set = deps;
  if (set === null) return { result: "failed", errorCode: "unwired" };
  let answer: unknown;
  try {
    answer = await set.targets.handleTargets({ handleId });
  } catch {
    return { result: "failed", errorCode: "noAnswer" };
  }
  return targetsOf(answer, handleId);
}
