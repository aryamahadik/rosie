// The paging telling port as the commit binds it (T-1443; DL-930; T-319's handoff 2): T-319's paging service (domain/paging
// telling.ts, through handlers.ts pagingTellingOf) in place of T-318's NOT_TOLD_YET, built on each call's own repo (a
// RepoTelling: domain/safety ports.ts), so the reads behind it are the binding's for that call. It is a SafetyTelling
// itself, so every place that names NOT_TOLD_YET takes it as it is; the commit core puts it on each turn's repo
// (tellingOn), and told anywhere without a call's repo it answers notBuilt, as NOT_TOLD_YET does. The runtime binds it
// with its PagingReader, the roster and ENVIRONMENT, from the wiring's config (T-1444); until then every binding names
// NOT_TOLD_YET, and a record that must tell someone answers notBuilt as before.
//
// It fails closed on each of its inputs (QUESTIONS.md Q-18 and M3-M3b.5; build prompt 9.4; the user's rule, DL-839):
//   - ENVIRONMENT: an alert or a page reaches a real person only when it is exactly "production" (domain/paging
//     recipients.ts default 1); anything else, a letter's case or a space off included, and none at all, is staging;
//   - the roster: staging's roster test phones, by handle id, never by a number: a TestRoster, or the roster's handle ids.
//     None, or an empty list, is no test phone, so on staging every alert and page waits in the test console and no row
//     is written to anyone; a row to an email address is never a test phone's (recipients.ts resolve);
//   - the reads: the paging service's PagingReader on the call's repo (the runtime's: T-1444). None: every read answers
//     notBuilt, so a record that must tell someone answers notBuilt, as NOT_TOLD_YET does, and nothing is written.
// It only reads, through those ports, and hands back what the record's commit writes (telling.ts: the hand-off, its
// alert, the team's page and its rows, each under the record's business). Nothing here logs.
//
// Defaults used (for ops/QUESTIONS.md), numbered after core.ts's:
//  11. A roster given as handle ids is matched id for id: a handle id with another letter case or a space, or a phone
//      number in a handle id's place, matches no handle (fail closed).

import {
  NO_TEST_PHONES,
  pagingTellingOf,
  type PagingDeps,
  type PagingIds,
  type PagingReader,
  type PagingTelling,
  type TestRoster,
} from "../../domain/paging";
import type { RepoTelling } from "../../domain/safety";
import { NotBuiltError } from "../../tool-api";

/** The paging telling port: told on a call's repo, T-319's PagingTelling, which also names its rows (T-1374). */
export interface PagingTellingPort<Repo> extends RepoTelling<Repo> {
  on(repo: Repo): PagingTelling;
}

/** What the paging telling port is built from; each part fails closed when it is left out (the top of this file). */
export interface PagingTellingOptions<Repo> {
  /** The Worker's ENVIRONMENT as the wiring reads it: only exactly "production" pages real people. None: staging. */
  readonly environment?: string | null;
  /** Staging's roster test phones, by handle id: a TestRoster, or the roster's handle ids. None: no test phone at all. */
  readonly roster?: TestRoster | readonly string[] | null;
  /** The paging reads on the call's repo (PagingReader, the runtime's: T-1444). None: every read answers notBuilt. */
  readonly reader?: ((repo: Repo) => PagingReader) | null;
  /** The ids of the rows it writes. Default: the Worker's keyed ids (KEYED_PAGING_IDS). */
  readonly ids?: PagingIds;
}

/** Staging's roster from its handle ids, each matched id for id (default 11). */
export function rosterOfHandles(handleIds: readonly string[]): TestRoster {
  const listed = new Set(handleIds);
  return { isTestPhone: (handleId) => Promise.resolve(listed.has(handleId)) };
}

function isHandleList(roster: TestRoster | readonly string[]): roster is readonly string[] {
  return Array.isArray(roster);
}

/**
 * The paging service's deps for these options, each fail-closed default spelled out: ENVIRONMENT as given, else none
 * (staging); the roster as given, else no test phone; the reads and the ids only when given. The same deps serve the paging
 * core actions (CoreDeps.paging) and the Tool API base's paging handlers (TurnFaceCalls.paging).
 */
export function pagingDepsOf<Repo>(options: PagingTellingOptions<Repo> = {}): PagingDeps<Repo> {
  const { roster, reader, ids } = options;
  return {
    environment: options.environment ?? "",
    roster:
      roster === undefined || roster === null
        ? NO_TEST_PHONES
        : isHandleList(roster)
          ? rosterOfHandles(roster)
          : roster,
    ...(reader === undefined || reader === null ? {} : { reader }),
    ...(ids === undefined ? {} : { ids }),
  };
}

/**
 * The paging telling port (T-1443): T-319's, built on each call's repo over the reads, the roster and ENVIRONMENT given,
 * each failing closed when left out (the top of this file). Every place that names NOT_TOLD_YET takes it as it is
 * (CoreSafetyDeps.telling, TurnCommitBinding.telling, PgTurnCallsOptions.telling, PgKeywordDoorOptions.telling and the
 * safety service's own SafetyDeps.telling): the commit core puts it on each turn's repo (tellingOn), and told before it is
 * put on one, it answers notBuilt as NOT_TOLD_YET does (handOff), writing nothing.
 */
export function pagingTellingPort<Repo>(options: PagingTellingOptions<Repo> = {}): PagingTellingPort<Repo> {
  const deps = pagingDepsOf(options);
  return {
    tell: () => Promise.reject(new NotBuiltError("handOff")),
    on: (repo) => pagingTellingOf(deps, repo),
  };
}
