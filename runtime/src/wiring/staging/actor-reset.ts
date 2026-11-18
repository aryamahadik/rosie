// Staging's reset list (T-1452; the architect's card A under DL-944; D-018, the lane to the user texting Rosie from their
// own iPhone): which handle actors the staging-only reset (../../actor/staging-reset.ts) clears, each once. Two handles are
// held for good now (DL-944): tp-01 since Nov 15 (trace db5b0ecd) and the roster phone since 00:09Z Nov 18 (b924fb36, a
// bare HELP); a danger whose line has no path stays pending on staging by design, and its after_safe hold, which has no
// core id, holds every later routine reply of the handle. The user approves the reset as a read-back before the deploy
// that makes it live (DL-944); the lead records the yes in DECISIONS.
//
// The list: each entry has an id (a label, kept in each target actor's marker once applied, so an entry applies once per
// actor) and its targets, each one of:
//   { roster: <roster id> }  a phone of staging's test-phone roster (db/seeds/lib/roster.ts, T-1302): its actor is named by
//                            the roster's own fiction-range number, the one the seeds give it (tp-01's handle is seeded
//                            at that number by db/seeds/skeleton.ts, and the test-phone page sends as it);
//   "allowList"              the real line's allow-list: every number on STAGING_LINQ_ALLOWLIST, read by name at each
//                            call, never as the hook is made, so no number is written here or in any file. It is read as
//                            T-416's guard reads it (adapters/src/linq/roster: split on "," alone, no trimming, each entry
//                            E.164; its parser is not exported) and as T-1449 reads it again (./linq-line.ts): missing,
//                            not text or blank, it names no number; holding any entry that is not E.164, it cannot be
//                            read, so it names none (fails closed: no actor is reset by a list that cannot be read).
// The first entry is tp-01 and the allow-list.
//
// The hook (stagingActorReset): only on staging (ENVIRONMENT read first, by ../picks.ts environmentOf; anywhere else null,
// with nothing more read). It answers, for an actor's name, the entries that target it, each with the target that names
// it as a label: the roster id, or the allow-list's place (`allowList:<place from 1>`), never the number. ./options.ts
// hands it to the root (RootOptions.actorReset), whose install() sets it for the isolate where the root is staging's.
//
// Nothing here logs, and nothing is put in a span or an error: never a number, an entry or a name.

import { rosterPhone } from "@rosie/db/seeds/lib/roster";

import type { ResetMatch, StagingResetHook } from "../../actor/staging-reset";
import { actorNameOf } from "../../gateway/seal";
import { environmentOf } from "../picks";

/** One target of an entry: a roster phone by its roster id, or every number on the real line's allow-list. */
export type ActorResetTarget = { readonly roster: string } | "allowList";

/** One entry of the reset list: its id (a label, kept in each target actor's marker) and its targets. */
export interface ActorResetEntry {
  readonly id: string;
  readonly targets: readonly ActorResetTarget[];
}

/** The reset list, in the order its entries were added. Each entry applies once to each actor it targets. */
export const ACTOR_RESET_LIST: readonly ActorResetEntry[] = Object.freeze([
  // DL-944 card A: tp-01, held since Nov 15 (db5b0ecd), and the roster phone, held since 00:09Z Nov 18 (b924fb36).
  Object.freeze({ id: "t1452-nov18", targets: Object.freeze([{ roster: "tp-01" }, "allowList"] as const) }),
]);

/** The Worker's env as the hook reads it: ENVIRONMENT, and STAGING_LINQ_ALLOWLIST by name at each call. */
export interface ActorResetEnv {
  readonly ENVIRONMENT: string;
  readonly STAGING_LINQ_ALLOWLIST?: unknown;
}

/** K-11's phone ($defs/phone), the form T-416's guard asks of every entry of the list. */
const E164 = /^\+[1-9][0-9]{6,14}$/u;

/**
 * STAGING_LINQ_ALLOWLIST's entries as T-416's guard reads them: none where it is missing, not text or blank; the entries,
 * split on "," alone with no trimming, where each is E.164; null where any entry is not (the list cannot be read).
 */
function allowListOf(value: unknown): readonly string[] | null {
  if (typeof value !== "string" || value.trim() === "") return [];
  const entries = value.split(",");
  return entries.every((entry) => E164.test(entry)) ? entries : null;
}

/** The labels of the targets that name the actor of this name: the roster id, or the allow-list's place. */
function targetsNaming(target: ActorResetTarget, actorName: string, env: ActorResetEnv): string[] {
  if (target === "allowList") {
    const listed = allowListOf(env.STAGING_LINQ_ALLOWLIST) ?? [];
    return listed.flatMap((number, place) =>
      actorNameOf({ kind: "phone", address: number }) === actorName ? [`allowList:${String(place + 1)}`] : [],
    );
  }
  const phone = rosterPhone(target.roster);
  if (phone === null) return [];
  return actorNameOf({ kind: "phone", address: phone.fakeNumber }) === actorName ? [phone.testPhoneId] : [];
}

/**
 * Staging's hook for the reset (RootOptions.actorReset): null anywhere but staging, with nothing read but ENVIRONMENT; on
 * staging, for an actor's name, each entry of `list` that targets it with the target that names it. STAGING_LINQ_ALLOWLIST
 * is read at each call, never here.
 */
export function stagingActorReset(
  env: ActorResetEnv,
  list: readonly ActorResetEntry[] = ACTOR_RESET_LIST,
): StagingResetHook | null {
  if (environmentOf(env) !== "staging") return null;
  return {
    matches(actorName) {
      const found: ResetMatch[] = [];
      for (const entry of list) {
        for (const target of entry.targets) {
          for (const label of targetsNaming(target, actorName, env))
            found.push({ entry: entry.id, target: label });
        }
      }
      return found;
    },
  };
}
