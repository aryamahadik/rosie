// The allowed formats' shapes (T-261; C-128), written by hand: the generated contract types are git-ignored (ADR-005)
// and the Worker must not depend on them (as runtime/src/dispatch/types.ts does). The tests hold them to the contracts:
//   - K-03 v1 (contracts/message-plan/message-plan.v1.schema.json): $defs format, channel, situation and calendarFile,
//     and composeInput.allowedFormats (at least one). K-03 v1.1 leaves every one of them as v1 has it.
//   - K-06 v1 (contracts/inbound-event/inbound-event.v1.schema.json): $defs service and kind, for the text a reply answers.
//   - K-11 v1 (contracts/port-linq/port-linq.v1.schema.json): capabilityCheck.request, .response and .errors.
//   - K-04 v1 (contracts/db-schema/core/core.v1.tables.json): phones.chat_open and phones.poll_voted_at.
// No shape here holds a word of a message: counts, flags and labels only, so nothing a row says can reach this module.

/** A format the composer may pick (K-03 v1 `format`; arch 07 lines 373 to 393). */
export type Format = "text" | "poll" | "linkCard" | "calendarFile" | "tapback";

/** The channel a row goes on (K-03 v1 `channel`): imessage, rcs or sms through Linq, or email. */
export type Channel = "imessage" | "rcs" | "sms" | "email";

/** The service of a Linq chat, as Linq reports it (K-11 v1 `service`; K-04 phones.chat_way; DL-012: never an SMS provider). */
export type LinqService = "imessage" | "rcs" | "sms";

/** The service an inbound event reports (K-06 v1 `service`): Linq's, or email. */
export type InboundService = LinqService | "email";

/** What an inbound event is (K-06 v1 `kind`). */
export type InboundKind =
  "text" | "photo" | "reaction" | "pollVote" | "voteRemoved" | "edit" | "delivered" | "sent" | "failed";

/** Code's tone tag (K-03 v1 `situation`; arch 07 line 357). */
export type Situation = "gentle" | "problem" | "moneyOrConsent" | "routine";

/** The calendar file a row's booking carries (K-03 v1 `calendarFile`; arch 07 line 383). */
export type CalendarFile = "none" | "new" | "move" | "cancel";

/**
 * Code's own formats, tested on Nov 5 (MC 8 'iPhone tests'), which the composer does not pick: typing dots (arch 07
 * line 385) and a threaded reply (line 389; the plan's threadReplyTo).
 */
export type CodeFormat = "typingDots" | "threadedReply";

/** Where the channel came from (arch 07 line 365). */
export type ChannelFrom =
  /** An email row: its own row, text alone (arch 07 line 371). */
  | "email"
  /** No chat with Rosie's number: Rosie never opens one (arch 07 line 369; RULES 4.1b), so text alone. */
  | "noChat"
  /** The service of the text this row replies to (arch 07 line 365, HANDOFF 6). */
  | "answeredText"
  /** Linq's capability check, asked for this row. */
  | "capabilityCheck"
  /** Linq's capability check, from an answer kept 10 minutes or a check already out. */
  | "capabilityCache"
  /** The capability check failed or could not tell: text alone (arch 07 line 365, DD). */
  | "checkFailed";

/** Who a row goes to: a phone in Linq's chats (K-04 phones), or an email address. */
export type Recipient = PhoneRecipient | EmailRecipient;

export interface PhoneRecipient {
  readonly kind: "phone";
  /** The recipient's handle (K-04 handles.id): one per phone number (arch 01 line 55). */
  readonly handleId: string;
  /** The number in E.164 form (K-04 phones.number): the capability check's key, never logged. */
  readonly phone: string;
  /** Whether the chat exists: K-04 phones.chat_open, set by the mobile's first text, cleared by STOP (RULES 4.1b). */
  readonly chatOpen: boolean;
  /** Whether this phone has voted in a poll: K-04 phones.poll_voted_at is set (arch 07 line 379). */
  readonly votedInPoll: boolean;
}

export interface EmailRecipient {
  readonly kind: "email";
  /** The recipient's handle (K-04 handles.id): one per email address (arch 01 line 55). */
  readonly handleId: string;
}

/** The text a turn answers, as the actor stored it (K-06 v1; T-244): who sent it, the service it came by, its kind. */
export interface AnsweredText {
  /** The handle that sent it: a row replies to it only when this is the row's own recipient (arch 07 line 397). */
  readonly fromHandleId: string;
  /** The service its provider reported (K-06 v1 `service`; K-04 messages.service), or null when none was reported. */
  readonly service: InboundService | null;
  /** What it is (K-06 v1 `kind`). Only a text or a photo has a message of its own a tapback can go on (K-06 messageId). */
  readonly kind: InboundKind;
}

/** What the formats table reads of the row's step and turn (arch 07 lines 365, 377 to 393): counts and flags only. */
export interface StepFacts {
  /** How many options the open question offers (K-03 composeInput.options; K-01 elements.buttons): a poll takes 2 to 5. */
  readonly optionCount: number;
  /** The page types the step allows (K-01 step.pageTypes; K-03 composeInput.pageTypes). */
  readonly pageTypes: readonly string[];
  /** The link slots the message may carry (K-03 composeInput.allowedLinks, after limit 7). */
  readonly allowedLinks: readonly string[];
  /** The calendar file the row's booking carries: a confirmation (new), a move or a call-off (cancel), or none. */
  readonly calendarFile: CalendarFile;
  /** How many questions are still open with this reader (K-03 composeInput.openQuestions). */
  readonly openQuestionCount: number;
  /** Every part of the turn maps to no_op (K-02), as a "thanks!" does (arch 07 line 391). */
  readonly turnAllNoOp: boolean;
  /** Code's tone tag for the row (K-03 situation; C-090). */
  readonly situation: Situation;
}

/** One outbox row, as the formats table reads it. */
export interface FormatsRow {
  readonly to: Recipient;
  /** The text the row's turn answers, or null when it answers none (a clock firing, a sweep). */
  readonly answers: AnsweredText | null;
  readonly step: StepFacts;
}

/** What this phone allows right now for one row (arch 07 line 365; C-128). */
export interface AllowedFormats {
  /** The channel the formats were read for (K-03 `channel`), or null when nothing told it: text alone. */
  readonly channel: Channel | null;
  readonly channelFrom: ChannelFrom;
  /**
   * K-03 composeInput.allowedFormats: text, then each other format this phone allows now, in K-03's order. Never bold,
   * read receipts (untested: MC 8) or anything on arch 07 line 393's Never row: none of them is a K-03 format.
   */
  readonly formats: readonly [Format, ...Format[]];
  /** Code's own tested formats this phone allows now; never read receipts or bold (MC 8). */
  readonly codeFormats: readonly CodeFormat[];
  /**
   * true once this phone has voted in a poll: a poll's options then go only in the poll (S13-16). Until then a poll
   * plan's words also carry the options in msgtext.js's text form, since phones before iOS 26 show no poll and Linq
   * cannot tell which phone it is (arch 07 line 379, DD).
   */
  readonly choicesOnlyInPoll: boolean;
}

/** K-11 v1 capabilityCheck.response: what a number supports now, which the caller keeps 10 minutes. */
export interface CapabilityChecked {
  readonly result: "checked";
  readonly phone: string;
  readonly imessage: boolean;
  readonly service: LinqService | null;
  readonly checkedAt: string;
  readonly cacheSeconds: number;
}

/** K-11 v1 capabilityCheck.errors: the check failed, so the row goes as text alone (arch 07 line 365, DD). */
export interface CapabilityFailed {
  readonly result: "failed";
  readonly phone: string;
  readonly code: string | null;
  readonly reason: string;
}

export type CapabilityAnswer = CapabilityChecked | CapabilityFailed;

/** The port's call (K-11 v1 capabilityCheck), as the Linq adapter (C-209) and the Linq double (C-211) answer it. */
export interface CapabilityCheckPort {
  capabilityCheck(request: { readonly phone: string }): CapabilityAnswer | PromiseLike<CapabilityAnswer>;
}

/** A lookup's answer: what the number takes now, and whether it came without asking Linq; or failed (text alone). */
export type Capability =
  | {
      readonly result: "checked";
      readonly imessage: boolean;
      readonly service: LinqService | null;
      /** true when no new check was asked: an answer kept 10 minutes, or a check already out for the number. */
      readonly cached: boolean;
    }
  | { readonly result: "failed"; readonly cached: boolean };

/** What the formats ask the capability check through: the 10-minute cache (./capability.ts), or a test's own. */
export interface CapabilityLookup {
  lookup(phone: string): Promise<Capability>;
}
