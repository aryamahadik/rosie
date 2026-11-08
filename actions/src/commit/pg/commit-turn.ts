// The commit's K-05 port on PostgreSQL (C-087, T-306): T-305's one commit per turn (../commit.ts) hands its one K-05
// commitTurn request to the database engineer's data-access call (db/repo/commit-turn.ts, T-195), which writes it in one
// transaction on the primary, all or nothing, once per turn id (K-05 v1.1 item 1; arch 01 line 39; arch 10 line 508), and
// compares every row the turn read at its version, so of two turns on one booking version only one commits (limit 4's
// compare-and-set: arch 06 line 305; arch 10 line 506).
//
// The call runs where K-05 says it runs ("Scope: per write"): its own transaction on a client of the runtime side, whose
// connections run as rosie_job, starting with no business scope and setting each write's own business before that write
// (T-191's roles; 0012: only rosie_job may run it). So it never runs inside the Tool API call's business-scoped
// transaction, and the call's repo is not used: a turn may write two businesses' rows in one commit (arch 03 line 159).
//
// What comes back is K-05's answer as it is: committed (a repeated turn id answers the first commit with `repeated` true and
// writes nothing), or a refusal that wrote nothing (versionChanged, reservationLost, turnParked, wrongState, constraint,
// transient), which gateAndCommit maps: a version or reservation conflict reloads once, the rest are K-09's own errors. A
// request the call cannot carry out throws, as CommitTurnDatabaseError carrying a SQLSTATE and names only (never
// PostgresError.detail, which can hold a row's values: STATE's notes for later cards, 3) or a TypeError naming a field,
// and gateAndCommit fails closed: nothing is written. Nothing here logs.

import { commitTurn, type CommitOptions } from "../../../../db/repo/commit-turn";
import type { Sql } from "../../../../db/repo/scope";
import { LIMITS } from "../../gate/limits";
import { notBuiltPorts } from "../commit";
import type { CommitDeps, CommitPorts } from "../types";

export interface PgCommitOptions {
  /**
   * The commit's moment, read once per call: a test's fake clock (K-05 `given.now`). Default: the database's now() inside
   * the commit's own transaction, against which limit 5's held_until is read and at which every time the commit writes is
   * stamped (db/repo/commit-turn.ts default 10).
   */
  readonly now?: () => Date;
}

/**
 * K-05 v1.1 commitTurn as the commit's port (types.ts CommitPorts.commitTurn), on `runtime`: the primary handle of a
 * client whose connections run as rosie_job, uncached (arch 10 lines 504, 538). Each call is one transaction of its own.
 */
export function pgCommitTurn<Repo = unknown>(
  runtime: Sql,
  options: PgCommitOptions = {},
): CommitPorts<Repo>["commitTurn"] {
  const { now } = options;
  return (request) => {
    const given: CommitOptions = now === undefined ? {} : { now: now() };
    return commitTurn(runtime, request, given);
  };
}

/**
 * What the Worker runs once it holds a runtime client: limits 1 to 6 as registered (../../gate/limits.ts) and the K-05 port
 * on PostgreSQL. The other ports (what a passed part writes, the shared-core calls, what is open on the handle) stay not
 * built until their tasks land, so until then every turn answers notBuilt and writes nothing (fail closed).
 */
export function pgCommitDeps<Repo = unknown>(runtime: Sql, options: PgCommitOptions = {}): CommitDeps<Repo> {
  return {
    limits: LIMITS,
    ports: { ...notBuiltPorts<Repo>(), commitTurn: pgCommitTurn<Repo>(runtime, options) },
  };
}
