// What the safety service reads and is given (T-318; C-104), each a port another task fills, so the service is tested with
// doubles and fails closed while one is not built:
//
//   - SafetyReader: K-34 v1's outcomes and holds, the two K-04 facts the record needs (the owner to tell, the zone "that
//     day" is read in) and when a text arrived (K-06 receivedAt), which a release compares (release.ts default 13). K-05
//     has no read of K-34's tables yet (its open gap 26; T-1137 and T-1138 freeze and build the commit's reads), so the
//     default reader refuses every read (notBuilt);
//   - WordsSealer: seals the read's words under one person's key (db/repo/sealing.ts seal, which the wiring binds to the
//     call's transaction and the wrapping secret). The key already exists (the gateway made it at the text's first
//     sight: K-05 item 29), so sealing stores nothing outside the commit; a sealed value differs on each run (a fresh
//     IV). With none, a record that has words to seal answers notBuilt: the words are never written in plain;
//   - SafetyLines: the outcome steps' checked lines, from the pinned bundle (K-01 v1 fixed lines and the step cards'
//     lines, as the handle actor's BundleSafety reads them). The default knows only K-01 v1's own fixed lines, so any
//     other outcome's record is refused (noSafetyLine), but harm to a child or older adult's: with no hotline from the
//     bundle its record sends 911 (record.ts default 10);
//   - StopWords: whether the plug-in's own-line words stop a booking (A3-26), which K-02 v1's result does not carry. No
//     source of a plug-in's stop words is wired yet (QUESTIONS.md), so the default answers notBuilt for every record
//     rather than let a plug-in's stop words go unread; a plug-in known to list none is wired as such, by name
//     (PLUGIN_LISTS_NO_STOP_WORDS), never by default;
//   - SafetyTelling: who is told through a hand-off or a page (K-36 v1; arch 06 line 329), T-319's paging and hand-offs.
//     With none, an outcome that must tell someone answers notBuilt;
//   - SafetyWords: K-01 v1's fixed lines word for word, from the pinned bundle (as the handle actor's BundleSafety reads
//     them): the record reads safetyAsk's, the danger question its line carries after a label of unknown tense (T-1176;
//     CQ-172). With none, a record whose line asks it answers notBuilt; one whose line asks nothing never reads it.
// So every port fails closed until it is wired (D-017; T-1138).
//
// No port is called for anything but a read or a pure answer: a repeated turn runs the service again before K-05 answers
// `repeated`, so nothing here may send, store or tell outside the one commit (CommitPorts in ../../commit/types.ts; STATE
// note 1).

import { NotBuiltError, type CallName, type ResponseOf } from "../../tool-api";
import type { FlagWrites } from "../flags";
import type { ReleaseRule, ReleasedWhy, SafetyOutcome, Tense } from "./rules";

// ---- K-34 v1 rows as the service reads them -----------------------------------------------------------------------------

/** A K-34 v1 safety_outcomes row, without its sealed words (the service never opens them). Times are UTC ending in Z. */
export interface StoredOutcome {
  readonly id: string;
  readonly eventId: string;
  readonly source: "text" | "page" | "agent";
  readonly handleId: string | null;
  readonly personId: string | null;
  readonly businessId: string | null;
  readonly bookingId: string | null;
  readonly turnId: string | null;
  readonly readAt: string;
  readonly timedOut: boolean;
  readonly labels: readonly SafetyOutcome[];
  readonly tenses: readonly Tense[];
  readonly dangerWordKinds: readonly ("selfHarm" | "other")[];
  readonly outcomes: readonly SafetyOutcome[];
  readonly liftedToUnsure: boolean;
}

/** A K-34 v1 safety_holds row. Times are UTC ending in Z. */
export interface StoredHold {
  readonly id: string;
  readonly safetyOutcomeId: string;
  readonly businessId: string | null;
  readonly handleId: string;
  readonly personId: string | null;
  readonly bookingId: string | null;
  readonly turnId: string | null;
  readonly releaseRule: ReleaseRule;
  readonly blocksBooking: boolean;
  readonly heldAt: string;
  readonly releasedAt: string | null;
  readonly releasedWhy: ReleasedWhy | null;
  readonly releasedByTurnId: string | null;
  readonly releasedByOutcomeId: string | null;
  readonly version: number;
}

/** The business's owner, as a checked line to them is addressed (K-04 person_roles owner, and the handle they write from). */
export interface OwnerContact {
  readonly personId: string;
  readonly handleId: string;
}

/**
 * The reads the service makes, on the call's own transaction under its business scope (a row of another business is not
 * seen, K-04 v1 rule 4). Each is one data-access call once K-05 has it.
 */
export interface SafetyReader {
  /** K-34 safety_outcomes by its event id (safety_outcomes_event_key): the text's record, or null. */
  outcomeOfEvent(eventId: string): Promise<StoredOutcome | null>;
  /** K-34 safety_outcomes by id. */
  outcome(outcomeId: string): Promise<StoredOutcome | null>;
  /** K-34 safety_holds by id. */
  hold(holdId: string): Promise<StoredHold | null>;
  /** K-34 safety_holds of one outcome (safety_holds_one_per_outcome), or null when it held nothing. */
  holdOfOutcome(outcomeId: string): Promise<StoredHold | null>;
  /** K-04 outbox_rows: whether a row with this id is written (a repeat's checked line), never its words. */
  outboxRowWritten(rowId: string): Promise<boolean>;
  /** K-04: the business's owner and the handle they write from, or null. */
  ownerOf(businessId: string): Promise<OwnerContact | null>;
  /** K-04 businesses.time_zone: the IANA zone "that day" is read in for a harm report (CQ-05), or null. */
  businessZone(businessId: string): Promise<string | null>;
  /**
   * When a text arrived: its K-06 v1 receivedAt (when the gateway received it), UTC ending in Z, by its event id; null when
   * unknown. The handle actor takes a handle's texts in that order (K-06 v1 default 2), so a release reads it to know that
   * a "we're safe" came after the danger text (release.ts default 13). No frozen table keeps it yet: K-04 v1 `messages`
   * keeps the sender's `sent_at`, and `turns.event_ids` the order within one turn only (handoff: a K-04 and K-05 minor
   * version, or the actor's own record, gives it a home). Until then a release that needs it fails closed.
   */
  arrivedAt(eventId: string): Promise<string | null>;
}

/** No read of K-34 yet (K-05 open gap 26): every read answers notBuilt, so the call fails closed. */
export function noSafetyReads(call: CallName): SafetyReader {
  const refuse = (): Promise<never> => Promise.reject(new NotBuiltError(call));
  return {
    outcomeOfEvent: refuse,
    outcome: refuse,
    hold: refuse,
    holdOfOutcome: refuse,
    outboxRowWritten: refuse,
    ownerOf: refuse,
    businessZone: refuse,
    arrivedAt: refuse,
  };
}

// ---- sealing --------------------------------------------------------------------------------------------------------

/** Seals text under one person's key (K-04 sealing_keys; db/repo/sealing.ts seal): the sealed bytes, never kept in plain. */
export interface WordsSealer {
  seal(plaintext: string, forPersonId: string): Promise<Uint8Array>;
}

// ---- the checked lines ----------------------------------------------------------------------------------------------

/** A line of Rosie's safety list a harm report names (K-34 v1 harm_reports.hotline; S13-10). */
export type HotlineKind = "child_abuse" | "youth_crisis" | "family_violence" | "elder_care";

/** The checked line an outcome's step sends, from the pinned bundle. */
export interface SafetyLineChoice {
  /** K-01 v1 fixedLine.id, or the step card's line id (K-09 v1 fixedLineId). */
  readonly fixedLineId: string;
  /**
   * Who it goes to: the writer, back on the handle the text came from (A3-24, A3-25, A3-49, A3-50, A3-26: san to agent),
   * or the business's owner (A3-48: san to owner; S13-10: "no safety message to the one who threatens").
   */
  readonly to: "writer" | "owner";
  /**
   * The hotline of Rosie's safety list the line gives (A3-49, A3-50), when it gives one; null otherwise. A harm outcome's
   * line with none is sent as safetyEmergency (911) instead, and files no harm report (record.ts default 10).
   */
  readonly hotline: HotlineKind | null;
}

export interface SafetyLines {
  /**
   * The checked line of an outcome's step, or null when its step sends nothing here (A3-23 with no safety steps). The
   * danger words' kinds pick Unsure's line (arch 02 line 111: 988 and 911 for self-harm words, else 911).
   */
  lineOf(outcome: SafetyOutcome, wordKinds: readonly ("selfHarm" | "other")[]): SafetyLineChoice | null;
  /** The outage line, for a read that timed out with no danger word (arch 02 line 111), or null when none. */
  outageLine(): string | null;
}

/**
 * K-01 v1's own fixed lines only (contracts/bundle: safetyEmergency, 911; safetyCrisis, 988 and 911; outage): crisis
 * words, an emergency and Unsure, each to the writer. Every other outcome's line is its step card's, which the wiring
 * reads from the pinned bundle; until then such an outcome is refused (noSafetyLine) rather than sent silently, but harm
 * to a child or older adult, which the record sends 911 for while no hotline is held (record.ts default 10).
 */
export const FIXED_SAFETY_LINES: SafetyLines = {
  lineOf(outcome, wordKinds) {
    const line = (fixedLineId: string): SafetyLineChoice => ({ fixedLineId, to: "writer", hotline: null });
    switch (outcome) {
      case "Crisis words":
        return line("safetyCrisis");
      case "An emergency":
        return line("safetyEmergency");
      case "Unsure":
        return line(wordKinds.includes("selfHarm") ? "safetyCrisis" : "safetyEmergency");
      default:
        return null;
    }
  },
  outageLine: () => "outage",
};

// ---- the fixed lines' words -----------------------------------------------------------------------------------------

/** A K-01 v1 fixed line with its words, as the pinned bundle writes them (the handle actor's CheckedLine). */
export interface FixedLineWords {
  /** K-01 v1 fixedLine.id. */
  readonly id: string;
  readonly text: string;
}

/**
 * K-01 v1's fixed lines word for word, from the pinned bundle (sharedLists.fixedLines), as the handle actor's
 * BundleSafety.fixedLine reads them: the record's line carries safetyAsk's words when the danger question goes with it
 * (record.ts dangerQuestionOf, default 18). This service holds no words of its own (rule 3), so no default gives any.
 */
export interface SafetyWords {
  /** A K-01 fixed line by id, in English; null when the bundle holds no words for it (missing, or waiting for Jay). */
  fixedLine(id: string): FixedLineWords | null;
}

// ---- the plug-in's stop words ---------------------------------------------------------------------------------------

export interface StopWords {
  /**
   * Whether the plug-in says the words this text matched stop a booking (A3-26: "Where the plug-in says those words stop a
   * booking, nothing is booked, and Sam sees the question"; arch 06 line 319). K-02 v1's result names no such words.
   */
  stopsBooking(businessId: string | null, eventId: string): Promise<boolean>;
}

/**
 * The default, while no source of the plug-in's stop words is wired (QUESTIONS.md: where they come from): every new record
 * answers notBuilt and writes nothing, so a plug-in's stop words are never passed over unread (fail closed; A3-26). The
 * handle actor then keeps its own hold and sends the checked line itself (errors.ts).
 */
export const STOP_WORDS_NOT_WIRED: StopWords = {
  stopsBooking: () => Promise.reject(new NotBuiltError("recordSafetyOutcome")),
};

/**
 * A plug-in that lists no words that stop a booking, as the barbershop's lists none (K-09 v1.1
 * j3-safety-arrival-own-line.json: "A barbershop's plug-in lists no words that stop a booking here"). Wired by name, for a
 * plug-in known to list none; never the default, since a plug-in that lists some would then book past them.
 */
export const PLUGIN_LISTS_NO_STOP_WORDS: StopWords = {
  stopsBooking: () => Promise.resolve(false),
};

// ---- who is told ----------------------------------------------------------------------------------------------------

/** K-09 v1 recordSafetyOutcome.response.told[]. */
export type SafetyTold = ResponseOf<"recordSafetyOutcome">["told"][number];

/** One outcome that must tell someone through a hand-off or a page (rules.ts TELLS; arch 06 line 329). */
export interface TellRequest {
  /** The text's event id: the record's key. */
  readonly eventId: string;
  readonly outcomeId: string;
  /** The outcomes that tell, in K-02's order: crisis words (the owner and Rosie's team at once), an emergency or a threat. */
  readonly outcomes: readonly SafetyOutcome[];
  readonly businessId: string | null;
  readonly handleId: string | null;
  readonly personId: string | null;
  readonly bookingId: string | null;
  /** The turn whose commit carries it, or null for a call made alone. */
  readonly turnId: string | null;
  /** The call's now, UTC ending in Z. */
  readonly now: string;
  /** True on a repeat: name the rows the first record wrote, and write nothing. */
  readonly repeated: boolean;
}

/** Who is told and through which row, and what the commit writes for it (hand-offs, pages and their clock rows). */
export interface TellPlan {
  readonly told: readonly SafetyTold[];
  readonly writes: FlagWrites;
}

export interface SafetyTelling {
  tell(request: TellRequest): Promise<TellPlan>;
}

/** No hand-offs or pages yet (T-319): an outcome that must tell someone answers notBuilt, so the call fails closed. */
export const NOT_TOLD_YET: SafetyTelling = {
  tell: () => Promise.reject(new NotBuiltError("handOff")),
};
