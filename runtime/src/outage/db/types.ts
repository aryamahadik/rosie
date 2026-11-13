// The PostgreSQL-down path's shapes (T-270; C-175; S12-11, S12-12; arch 11 'PostgreSQL down', architecture.txt line 566),
// written by hand from the frozen contracts, because the generated types are git-ignored (ADR-005) and the Worker must not
// depend on them:
//
//   - K-09 v1 `recordStopOrStart` (contracts/tool-api), as the handle actor writes a STOP or a START on return: caller kind
//     actorOnReturn, no turn, the text's event id as its request id, and `sentByActor` the reply it sent straight through
//     Linq while PostgreSQL was down (start-recorded.json; j3-stop-on-return-tells-businesses.json; README default 6);
//   - K-09 v1 `sendFixedLine`, the outage line's record: the request T-271's `outageLineRequest` builds for the text (its
//     request id `safety:<event id>`, the safety read's own for the same text), with `sentByActor`, written on return by the
//     safety read's replay (runtime/src/safety `replayOnReturn`) under the safety read's own queue key for that text;
//   - K-34 v1 `safety_timers`, as the actor copies a live timer (../../actor/copies, T-269).
//
// Every outside call is a port (`DbOutageDeps`), set once per Worker isolate and joined at D-017. Never logged or put in a
// span: a text's words, a number, an address (sealed or not), a key. The ids, kinds and codes here are labels.

import type { SafetyTimerCopy } from "../../actor/copies/types";
import type { SealingKeyStore } from "../../gateway/seal";
import type { CoreError, DirectLineSender, HandleDirectory, SentByActor } from "../../safety/types";

/** K-09 v1 `recordStopOrStart.request`, as the actor writes a STOP or a START on return (start-recorded.json's shape). */
export interface StopOrStartOnReturn {
  readonly caller: {
    readonly kind: "actorOnReturn";
    readonly turnId: null;
    /** The text's event id: the key a repeat is known by. */
    readonly requestId: string;
    /** Null: a STOP or a START covers every business (RULES 7.2, 7.5; MC C1). */
    readonly businessId: null;
    readonly personId: string | null;
    readonly traceId: string;
  };
  readonly kind: "stop" | "start";
  /** The number it came from, never another (RULES 7.2, 7.5). Never logged. */
  readonly phoneNumber: string;
  readonly inboundEventId: string;
  /** The person's own words (K-29 consents.exact_words). Never logged. */
  readonly words: string;
  /** CANCEL or CANCELAR also flags the visit (RULES 7.4). */
  readonly alsoCancelVisit: boolean;
  readonly workPhoneBusinessIds: null;
  /** The reply the actor sent straight through Linq while PostgreSQL was down. */
  readonly sentByActor: SentByActor;
}

/** K-09 v1 `recordStopOrStart.response`, as far as the actor reads it: the phone's stopped flag and its row's version. */
export interface StopOrStartRecorded {
  readonly stopped: boolean;
  readonly phoneVersion: number;
  readonly repeated: boolean;
  readonly [field: string]: unknown;
}

/** The shared core's K-09 v1 `recordStopOrStart` (C-104, through the Tool API), as the actor reaches it on return. */
export interface StopOrStartCore {
  recordStopOrStart(request: StopOrStartOnReturn): Promise<StopOrStartRecorded | CoreError>;
}

/**
 * A running safety timer due while PostgreSQL is down, fired from the actor's copy (arch 11 line 566: "a running safety
 * timer fires from the actor's copy of its due time, address and emergency contact"): the copy as it is, the address still
 * sealed under its person's key, and one request id per timer row version, so a repeat is one alert.
 */
export interface TimerFireRequest {
  /** The pro's handle actor: this actor. */
  readonly actorName: string;
  /** `timer:<timer id>:<version>`. */
  readonly requestId: string;
  readonly timer: SafetyTimerCopy;
}

/**
 * The alerts after a missed check, sent from the copy while PostgreSQL is down (B8-86: the pro, then the emergency contact
 * who said yes, then the owner; K-34 README: the contact is told the job's address, and only it). Joined at D-017 (the CTO
 * with the security reviewer: QUESTIONS.md CQ-101 (c)); the address is opened only there, never by the actor. A throw: not
 * fired, tried again 5 s on.
 */
export interface TimerFirePort {
  fireFromCopy(request: TimerFireRequest): Promise<void>;
}

/** Everything the PostgreSQL-down path reaches outside the actor, set once per Worker isolate (`setDbOutageDeps`). */
export interface DbOutageDeps {
  /**
   * Whether PostgreSQL answers now (a read of the primary through K-05, such as `readActiveBundle`). False or a throw:
   * down. Asked only when something waits on it: a text waiting 20 s, a STOP or a START, a safety timer due, and every
   * 30 s while down.
   */
  probe(): Promise<boolean>;
  /** The handle's sealing key store (the gateway's): to read a STOP or a START, and to seal what waits for the return. */
  readonly keys: SealingKeyStore;
  /** Straight through Linq (the safety read's sender, NQ-RT-9): the outage line and the stop and start replies. */
  readonly direct: DirectLineSender;
  /** The handle's K-04 ids, for the outage line's record (the safety read's directory); a copy is kept when it answers. */
  readonly directory: HandleDirectory;
  /** K-09 v1 recordStopOrStart, for the STOP and START records written on return. */
  readonly core: StopOrStartCore;
  /** The alerts of a safety timer due while PostgreSQL is down, from the actor's copy. */
  readonly timers: TimerFirePort;
}

/** What a text is to the down path: a STOP, a START, any other text, or not known (no keyword list, or not opened). */
export type TextKind = "stop" | "start" | "other" | "unknown";

/**
 * A STOP or a START: `handling` (the actor took it: the stopped flag copied, its reply and record under way), `handled`
 * (replied, its record queued for the return; it never joins a turn), or `left` (its turn records it, after the return).
 */
export type KeywordState = "handling" | "handled" | "left";

/** The outage line: `sent` by this path, `went` by the safety read's timeout rule, or `stopped` (never: a stopped number). */
export type LineState = "sent" | "went" | "stopped";

/** One text the down path follows, as a reader sees it: labels and times only. */
export interface OutageTextView {
  readonly eventId: string;
  readonly kind: TextKind | null;
  readonly keyword: KeywordState | null;
  readonly line: LineState | null;
  /** When it is looked at next, on the actor's clock. */
  readonly dueAt: number;
}

/** One safety timer row version due while the path watched it: fired from the copy, or left to the core's clock row. */
export interface OutageTimerView {
  readonly timerId: string;
  readonly version: number;
  readonly fired: "copy" | "core" | null;
}

/** The down path's state, as labels and times only. */
export interface OutageView {
  /** Since when PostgreSQL is known down, and when it is asked again; null while it is not known down. */
  readonly down: { readonly since: number; readonly nextProbe: number } | null;
  readonly texts: readonly OutageTextView[];
  readonly timers: readonly OutageTimerView[];
}
