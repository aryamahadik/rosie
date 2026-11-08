// What decide is given (K-02 v1 `$defs/context`, contracts/model/model.v1.schema.json): the parts of a context the
// builder reads, written by hand. The generated types are git-ignored (ADR-005) and the Worker must not depend on them;
// the tests hold these shapes to K-02's own schema through the model-contract fixture loader (T-004).

import type { BundleId } from "../../../runtime/src/trace";
import type { FlowLetter, TurnCard } from "../cache";

/** A time: the instant in UTC with the IANA zone it is read in (the shared `time` format; CQ-09; S13-03). */
export interface ContextTime {
  readonly utc: string;
  readonly zone: string;
}

/** An amount in whole cents with its currency (the shared `money` format; CQ-09). */
export interface ContextMoney {
  readonly cents: number;
  readonly currency: string;
}

/** What a choice or an open question acts on, labelled by business, date and time (K-02 `target`; arch 03 line 159). */
export interface Target {
  readonly businessId: string;
  readonly businessName: string;
  readonly bookingId: string | null;
  readonly visitAt: ContextTime | null;
}

/** A field an answer carries, with its type (K-01 `answerField`). */
export interface AnswerField {
  readonly name: string;
  readonly type: string;
}

/** What a choice is (K-02 `choiceKind`; arch 01 line 67; arch 03 lines 163 to 167, 189). */
export type ChoiceKind = "option" | "hub" | "anytime" | "door" | "searchEntry" | "whichBooking";

/** One entry of the frontier, the closed list of choices code builds for the turn (K-02 `choice`; arch 01 line 69). */
export interface Choice {
  readonly choiceId: string;
  readonly kind: ChoiceKind;
  readonly label: string;
  readonly definition: string;
  readonly step: string;
  /** What choose names as its question; null for a door, an any-time row and an entry step, which enter takes. */
  readonly question: string | null;
  readonly branch: string | null;
  readonly anytimeRow: string | null;
  readonly door: string | null;
  readonly hub: string | null;
  readonly target: Target;
  readonly fields: readonly AnswerField[];
  readonly stakes: "high" | "low";
  readonly stakesFrom: readonly unknown[];
}

/** An open question sent to this handle (K-02 `openQuestion`; arch 03 line 159; S13-12). */
export interface OpenQuestion {
  readonly openQuestionId: string;
  readonly step: string;
  readonly target: Target;
  readonly sentAt: ContextTime;
  readonly pollId: string | null;
  readonly askCount: number;
}

/** A fact's value (K-02 `factValue`): text, integer, boolean, money or a time; null when its home holds none. */
export type FactValue = string | number | boolean | ContextMoney | ContextTime | null;

/** One fact the open questions' and hubs' steps need, from its one home (K-02 `fact`; arch 02 line 117; S13-30). */
export interface Fact {
  readonly name: string;
  readonly value: FactValue;
  readonly home: string;
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
  readonly forSteps: readonly string[];
}

/** One text of the turn, after the edge scrub (K-02 `text`; arch 02 line 109). */
export interface TurnText {
  readonly eventId: string;
  readonly kind: "text" | "pollVote" | "tapback";
  readonly words: string;
  readonly sentAt: ContextTime;
  readonly attachments: readonly { readonly attachmentId: string; readonly mediaType: string }[];
  readonly poll: { readonly pollId: string; readonly optionId: string } | null;
  readonly tapback: { readonly reaction: string; readonly onMessageId: string } | null;
}

/** One person behind the handle, with their roles and stored language (K-02 `person`). */
export interface Person {
  readonly personId: string;
  readonly name: string;
  readonly roles: readonly { readonly role: string; readonly businessId: string }[];
  readonly language: string | null;
}

/** One of the last messages with this business, for tone only (K-02 `recentMessage`; arch 03 line 181). */
export interface RecentMessage {
  readonly from: "person" | "rosie";
  readonly sentAt: ContextTime;
  readonly words: string;
}

/** What decide is given for one turn (K-02 v1 `context`), as the frontier builder (C-075) hands it on. */
export interface DecideContext {
  readonly turnId: string;
  readonly bundleId: BundleId;
  readonly flow: FlowLetter;
  readonly texts: readonly TurnText[];
  readonly writer: { readonly handle: string; readonly people: readonly Person[] };
  readonly businessLanguage: string;
  readonly openQuestions: readonly OpenQuestion[];
  readonly choices: readonly Choice[];
  readonly cards: readonly TurnCard[];
  readonly facts: readonly Fact[];
  readonly alwaysOn: { readonly flow: FlowLetter; readonly prefixSha256: string };
  readonly recentMessages: readonly RecentMessage[];
  readonly meaningSearch: { readonly added: readonly string[]; readonly index: string } | null;
}
