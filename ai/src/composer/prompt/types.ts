// The parts of K-03 v1 (contracts/message-plan/message-plan.v1.schema.json) the composer's prompt reads, written by
// hand: the generated types are git-ignored (ADR-005) and the Worker must not depend on them. Two documents:
//
//   - `$defs/composeInput`: the composer's input, one per outbox row (arch 07 line 397);
//   - `$defs/plan`: the composer's structured output, the message plan (arch 07 line 397; arch 01 line 97).
//
// The schema is the one definition of both; the prompt's tests check every worked example against it.

/** A format the plan may pick (K-03 `format`; arch 07 lines 373 to 393). */
export type Format = "text" | "poll" | "linkCard" | "calendarFile" | "tapback";

/** Where a line sits in the message's shape (K-03 `lineRole`; arch 07 line 353). */
export type LineRole = "first" | "fact" | "action";

/** Who reads the message (K-03 `readerRole`). */
export type ReaderRole = "owner" | "staff" | "customer";

/** The channel the row goes on (K-03 `channel`; sms is Linq's SMS service, RULES 4.1b). */
export type Channel = "imessage" | "rcs" | "sms" | "email";

/** Code's tone tag, the first that fits (K-03 `situation`; arch 07 line 357). */
export type Situation = "gentle" | "problem" | "moneyOrConsent" | "routine";

/** How a person is reached (K-03 `reach`). */
export type Reach = "texts" | "callsonly" | "textsonly" | "email";

/** A link slot (K-03 `linkSlot`). */
export type LinkSlot = "link.secure" | "link.pay" | "link.chat" | "link.chatqr";

/** One line of the plan (K-03 `line`): its role and its words with slots. */
export interface PlanLine {
  readonly role: LineRole;
  readonly text: string;
}

/** The plan's one question (K-03 `question`), with the ids of the options it offers. */
export interface PlanQuestion {
  readonly text: string;
  readonly optionIds: readonly string[];
}

/** The message plan (K-03 `plan`): every property required, null for none. */
export interface MessagePlan {
  readonly formats: readonly Format[];
  readonly lines: readonly PlanLine[];
  readonly question: PlanQuestion | null;
  readonly pageType: string | null;
  readonly threadReplyTo: string | null;
}

/** A time (common formats `time`): the instant in UTC and its zone. */
export interface InputTime {
  readonly utc: string;
  readonly zone: string;
}

/** One of the reader's last messages with this business (K-03 `conversationMessage`). */
export interface ConversationMessage {
  readonly from: "reader" | "rosie";
  readonly text: string;
  readonly sentAt: InputTime;
}

/** One fact the reader may see: a slot and its value (K-03 `fact`). */
export interface Fact {
  readonly slot: string;
  readonly value: string;
}

/** Who reads the message (K-03 `audience`). */
export interface Audience {
  readonly role: ReaderRole;
  readonly name: string | null;
  readonly way: Reach;
  readonly handlingLine: string | null;
}

/** One option of the open question, with the label code inserts word for word (K-03 `option`). */
export interface Option {
  readonly id: string;
  readonly label: string;
}

/** A question still open with this reader (K-03 `openQuestion`). */
export interface OpenQuestion {
  readonly id: string;
  readonly text: string;
}

/** The text this row replies to (K-03 `inbound`). */
export interface Inbound {
  readonly text: string;
  readonly sentAt: InputTime;
}

/** The composer's input for one outbox row (K-03 `composeInput`). */
export interface ComposeInput {
  readonly row: string;
  readonly turn: string;
  readonly conversation: readonly ConversationMessage[];
  readonly masterText: { readonly step: string; readonly text: string };
  readonly facts: readonly Fact[];
  readonly audience: Audience;
  readonly language: string;
  readonly channel: Channel;
  readonly situation: Situation;
  readonly allowedFormats: readonly Format[];
  readonly allowedLinks: readonly LinkSlot[];
  readonly options: readonly Option[];
  readonly pageTypes: readonly string[];
  readonly openQuestions: readonly OpenQuestion[];
  readonly inbound: Inbound | null;
}
