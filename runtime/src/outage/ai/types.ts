// The AI-down path's shapes (T-271; C-174; arch 11 'AI provider down or slow', architecture.txt line 564; arch 06 'A model
// call fails', line 293), written by hand from the frozen contracts, because the generated types are git-ignored (ADR-005)
// and the Worker must not depend on them:
//
//   - K-09 v1 `sendFixedLine` (contracts/tool-api): the outage line, a fixed line word for word, "once to each text whose
//     turn has not committed, never to a stopped number" (its request's description; arch 11 line 564; S12-12). The actor
//     sends it alone (caller kind job), as the safety read's timeout rule sends the same line (runtime/src/safety). Its
//     request and answer are the safety read's own shapes (../../safety/types), reused.
//   - K-01 v1's fixed line `outage` (contracts/bundle fixed-lines.json): "Rosie is down for a few minutes. If anyone is in
//     danger, call 911." The core writes its words into the row; the runtime names it by id only.
//
// Every outside call is a port (`OutageDeps`), set once per Worker isolate and joined at D-017: the shared core's
// sendFixedLine (C-104, served by T-220), the clock the 30 s retries wait on, the handle's stopped flag and the outbox
// dispatcher's wake. Never logged or put in a span: a text's words, a number. The ids and codes here are labels.

import type { SafetyCore } from "../../safety/types";

/** The clock the retries wait on (the fake one in tests, the Workers clock otherwise): epoch milliseconds, and a wait. */
export interface OutageClock {
  now(): number;
  /** Resolves after `ms` milliseconds. */
  after(ms: number): Promise<void>;
}

/** What the dispatcher is told once a try's outage lines are written: the handle and the rows (K-04 ids). */
export interface OutageWake {
  readonly handleId: string;
  readonly outboxRowIds: readonly string[];
}

/** Everything the AI-down path reaches outside the actor, set once per Worker isolate (`setOutageDeps`); joined at D-017. */
export interface OutageDeps {
  /** The clock the turn's retries wait on: one retry every 30 s while the models are down (arch 11 line 564). */
  readonly clock: OutageClock;
  /**
   * K-09 v1 `sendFixedLine`, the shared core's (C-104; the same port the safety read sends its outage line through). It
   * writes the line's outbox row, send class quick_reply, which limit 8 drops for a stopped phone at send (T-259), and
   * answers `phoneStopped` for a stopped number with nothing written.
   */
  readonly lines: Pick<SafetyCore, "sendFixedLine">;
  /**
   * The handle's stopped flag, by the actor's name (the same read as the safety read's `SafetyDeps.isStopped`): true sends
   * no outage line. Left out, the core's `phoneStopped` and limit 8 at send are the stopped checks.
   */
  isStopped?(actorName: string): boolean | Promise<boolean>;
  /**
   * Wakes the outbox dispatcher for the rows a try's lines wrote, so they go at once. Left out, the dispatcher's minute
   * sweep sends them. A wake that fails changes nothing for the lines.
   */
  wake?(request: OutageWake): Promise<void>;
}

/** One text of a turn waiting on the models, as the outage line reads it. */
export interface WaitingText {
  readonly eventId: string;
  /** The text's own trace id (CQ-06): the line's caller names it. */
  readonly traceId: string;
  /**
   * True when the safety read's timeout rule gave this text the outage line already (K-02 v1 `safetyResult` with
   * `timedOut` and no danger word: arch 02 line 111, "otherwise the outage line"), so it never gets a second one.
   */
  readonly lined: boolean;
}

/**
 * A turn the AI gateway reported the models down for before any commit (the decide reads or the one re-read): who waits,
 * for the outage line. Built by the turn (runtime/src/turn), labels and ids only.
 */
export interface WaitingTurn {
  /** The handle's actor name (`actorNameOf`): the stopped flag is read by it. */
  readonly actorName: string;
  /** K-04 handles.id of the turn's handle: the line's recipient. */
  readonly handleId: string;
  /** The business and person the turn's calls run under (K-09 caller), or null. */
  readonly businessId: string | null;
  readonly personId: string | null;
  /**
   * The turn's texts that may get the outage line, in arrival order: each text the person wrote (the kinds the safety read
   * reads: a text, a caption, a vote, an edit), keyword texts included. A reaction or a vote taken back gets none.
   */
  readonly texts: readonly WaitingText[];
  /**
   * True when one of the turn's own texts is a stop word (the guard's split): the phone asked to stop in this very turn, so
   * no outage line goes to it, though its stop waits for the commit (RULES 7.2: a stop works at once).
   */
  readonly stopAsked: boolean;
}

/** One outage line the core took: the text it answers, the row it wrote, and whether it had been sent before. */
export interface OutageLineSent {
  readonly eventId: string;
  readonly outboxRowId: string | null;
  readonly repeated: boolean;
}

/**
 * Why the AI-down path handed the turn back to the lease:
 * - `committed`: the turn committed (first or repeated), so nothing waits on the models;
 * - `notDown`: the run ended for another reason (the lease reruns the turn at its lapse, as before);
 * - `unwired`: the models were down, but the AI-down path is not wired (D-017), so no line went and no retry ran;
 * - `replaced`: the run is no longer the turn's (a restart replaced it, or its lapse started a rerun);
 * - `leaseEnds`: the next retry would come at or after the lease's lapse, which reruns the turn then, 30 s on.
 */
export type OutageEnd = "committed" | "notDown" | "unwired" | "replaced" | "leaseEnds";

/** What one run of a turn did through the AI-down path. */
export interface OutageReport<T> {
  /** The last try's outcome. */
  readonly outcome: T;
  /** How many times the turn ran in this run of the lease: 1 when the models were not down. */
  readonly tries: number;
  /** When each try started, on the outage clock (empty when unwired). */
  readonly triedAt: readonly number[];
  /** Each outage line the core took in this run, in the order sent. */
  readonly lines: readonly OutageLineSent[];
  readonly end: OutageEnd;
}
