// Limit 3, Exact yes (C-083, T-301; arch 06 line 303; arch 01 line 89 "Exact yes: the decider's own answer, bound to the
// exact text and versions of the read-back it answers"). It passes on "the decider's own reply in their one-to-one
// thread, poll vote, yes on the secure page, or their own AI's confirm (RULES 3.6, 6.1), bound to the read-back's exact
// text and versions"; on failure, "a fresh read-back, once; then the step's safe default, and the owner is told (S13-25
// rules 16-18)": K-09 v1 limit3Outcome freshReadBack (ask), then safeDefault (refuse).
//
// For one gated part, in this order:
//   1. What needs a yes: a choose of an option of an open question sent to this handle. A part that moves money (its
//      choice's stakes name a charge, money taken, a refund or a walk the frontier builder could not follow: K-02 v1
//      stakesReason; default 3) needs a read-back that binds it, so a money part without one fails: no charge without a
//      clear yes tied to that booking. Any other part (pass_on, hand_off, a door, an any-time row, a hub case or a
//      which-booking pick that moves no money) is notChecked.
//   2. Whose yes: in a turn, the texts carrying the part's quote, on the turn's handle, from the person the turn acts for.
//      A secure page's yes or an own AI's confirm counts only with the binding its page server or bound token carries
//      (K-21; K-20 and T-328; Q-09: the tie is required); none is built yet, so both are refused. A job, the console, a
//      clock's firing or the actor on return gives nobody's yes.
//   3. A tapback is never a yes (arch 03 line 187; A7-17), and a poll vote counts only on the question's own poll.
//   4. Their own: from the person the question was sent to, in their own thread (its handle), and one T-308's identity
//      and access service names among those who decide (default 2). A yes relayed by anyone else is refused.
//   5. For a read-back (K-04 open_questions.readback): tied to the part's business and booking when it moves money; given
//      after the read-back went out, so a yes sent before a fresher read-back is bound to an older text or version; a
//      page's or AI's binding names the read-back's exact words' sha256 and its versions; and the answer is one of the
//      read-back's own (default 1).
//
// A failure on a question asked once gives the fresh read-back. The fresh read-back is the same question asked again
// (K-04 ask_count one more), so a failure on a question asked twice gives the step's safe default and the owner told,
// never a third read-back. What an outcome writes (the read-back, the safe default, the notice) is the commit's (K-09 v1
// limitNOutcome; T-305 default 8): decideExactYes says what, and the limit hands the gate its K-09 outcome.
//
// Nothing here logs. What it returns names labels, ids and steps, never a person's words: the read-back's words are
// Rosie's own, read only to hash and compare, and a safe default is the step card's (K-02 v1 stepCard.safeDefault).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. An exact typed answer to a read-back is one of its own answers: the option's number or letter as the typed
//      options give it, or its words as sent (with or without that mark), case, spacing and end punctuation aside; a
//      poll vote must carry its option's words as sent. Any other words decide read as an answer ("sure i guess",
//      K-09 commit-limit-3-no-exact-yes.json; A7-31 "Anything else: ask once"; S2-22 "a clear yes") take the fresh
//      read-back. Every option of a read-back takes it, a no as well: its safe default changes nothing anyway.
//   2. Who decides, through T-308: someone with a live owner, admin or staff role at the business answers for the
//      business, and a part moving money needs T-308's refund decider (a refund) or fee decider (any other money
//      reason); with no money, their own role at the business suffices (who may decide team and settings is limit 1's).
//      Anyone else answers as a customer: for a booking (the one the part acts on), T-308 must name them among the
//      visit's deciders. A choice at another business than the call's has no decider here. A read-back needs a known
//      person asked; T-308's NOTHING_ON_FILE stays in force until the age-band reader lands (CQ-71).
//   3. Money: a stakes reason of charge, money or refund (K-02 v1 stakesReason), and unknown too: a choice the frontier
//      builder could not walk may reach a charge, so it takes the safer route (K-02 README "Stakes").
//   4. The ask count is the larger of the row's and the context's.
//   5. A quote several texts carry: every one of them must pass.
//   6. A plain question (no read-back) needs only the person's own reply, never a tapback, a vote only on its own poll;
//      its words and send time are decide's (arch 03 line 187), unless the part moves money.
//   7. Who is told after the safe default: the owner, or Rosie's team when the question was the owner's own (arch 02
//      step 9; S13-29 rule 57).

import type { IdentityAccess, Role } from "../../domain/identity-access";
import type { Choice, Context, GatePart, GateTurn, LimitOutcomes } from "../framework";
import type { AskedQuestion, BoundYes, QuestionReader, RowRef, SentOption, YesBindings } from "./facts";

/** Limit 3's outcomes when it fails (K-09 v1 limit3Outcome). */
export type Limit3Outcome = LimitOutcomes[3];

type Text = Context["texts"][number];
type ContextQuestion = Context["openQuestions"][number];

/** A fresh read-back, once (K-09 v1: ask). */
export function freshReadBackOutcome(): Limit3Outcome {
  return { limit: 3, outcome: "ask", action: "freshReadBack" };
}

/** Then the step's safe default, and the owner is told (K-09 v1: refuse). */
export function safeDefaultOutcome(): Limit3Outcome {
  return { limit: 3, outcome: "refuse", action: "safeDefault" };
}

/** A question asked this many times takes the safe default on a failure: the ask, then the fresh read-back. */
export const ASKS_BEFORE_SAFE_DEFAULT = 2;

/** The stakes reasons that move money, or may (K-02 v1 stakesReason; default 3). */
export const MONEY_REASONS: readonly string[] = ["charge", "money", "refund", "unknown"];

/** The roles that answer for the business (K-04 v1 person_roles; default 2). */
export const BUSINESS_ROLES: readonly Role[] = ["owner", "admin", "staff"];

/** Why a part has no exact yes: a label, never words. */
export type NotExactWhy =
  /** The call gives nobody's yes: a job, the console, a clock's firing, the actor on return, or no person named. */
  | "noPerson"
  /** No text of the turn carries the part's quote. */
  | "noText"
  /** A reaction: never a yes (arch 03 line 187; A7-17). */
  | "tapback"
  /** A vote on a poll other than the question's own. */
  | "notOwnPoll"
  /** An own AI's confirm with nothing binding its token to the person (Q-09). */
  | "unboundAgent"
  /** A page call with no yes its page server kept. */
  | "noPageYes"
  /** The question is not live on the handle the yes came from. */
  | "questionNotLive"
  /** Not the person the question was sent to: a relayed yes. */
  | "notTheirOwn"
  /** T-308 does not name them among those who decide. */
  | "notDecider"
  /** A part moving money with no read-back binding it. */
  | "noReadBack"
  /** The read-back is about another business or booking than the money part. */
  | "notThatBooking"
  /** Nothing of the read-back has gone out yet. */
  | "readBackNotSent"
  /** Bound to an older read-back's words or versions. */
  | "staleReadBack"
  /** Not one of the read-back's own answers. */
  | "notExact";

/** The fresh read-back the commit sends: the same question asked again. */
export interface FreshReadBack {
  readonly kind: "freshReadBack";
  readonly openQuestionId: string | null;
  readonly step: string;
  /** The fresh read-back's ask count: one more than the question's, so a second failure takes the safe default. */
  readonly askCount: number;
}

/** Who is told what happened after the safe default (S13-25 rule 18). */
export interface OwnerNotice {
  /** The owner, or Rosie's team when the question was the owner's own (default 7). */
  readonly to: "owner" | "rosieTeam";
  readonly businessId: string;
  readonly step: string;
  readonly openQuestionId: string | null;
  readonly why: NotExactWhy;
}

/** The step's safe default, and the notice. */
export interface SafeDefault {
  readonly kind: "safeDefault";
  readonly openQuestionId: string | null;
  readonly step: string;
  /** The step card's safe default, word for word; null: change nothing, charge nobody, move nobody (S13-25 rule 17). */
  readonly safeDefault: string | null;
  readonly told: OwnerNotice;
}

export type ExactYesDecision =
  | { readonly result: "pass" }
  | { readonly result: "notChecked" }
  | {
      readonly result: "fail";
      readonly why: NotExactWhy;
      readonly outcome: Limit3Outcome;
      readonly next: FreshReadBack | SafeDefault;
    };

/** What the rule reads, made only when it needs them. */
export interface ExactYesPorts {
  readonly questions: () => QuestionReader;
  readonly identity: () => IdentityAccess;
  readonly bindings: YesBindings;
}

const PASS: ExactYesDecision = { result: "pass" };
const NOT_CHECKED: ExactYesDecision = { result: "notChecked" };

// ---- words and versions ---------------------------------------------------------------------------------------------

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** A leading mark: a number ("1 Add it", "1) Add it", "1. Add it") or a letter with a mark of its own ("A) Sat"). */
const MARKED = /^(?:(\d+)[.):]?|([a-z])[.):])\s+(.+)$/u;

/** Words as a person may type them: case, spacing and end punctuation aside (default 1). */
export function plainWords(words: string): string {
  return words
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\s.!]+$/u, "")
    .trim();
}

/** An option's words without a leading mark of its own, plain. */
function bareWords(label: string): string {
  const plain = plainWords(label);
  const marked = MARKED.exec(plain);
  return marked?.[3] ?? plain;
}

/** The option of the read-back that the choice is: the one with its id, else the one with its words; -1 when none. */
export function optionIndex(options: readonly SentOption[], choice: Choice): number {
  const byId = options.findIndex((option) => option.id === choice.choiceId);
  if (byId >= 0) return byId;
  const words = bareWords(choice.branch ?? choice.label);
  return options.findIndex((option) => bareWords(option.label) === words);
}

/**
 * Whether typed words are one of the read-back's own answers for its option at `index` (default 1): its number or
 * letter, or its words as sent, alone or after that mark.
 */
export function isExactAnswer(said: string, options: readonly SentOption[], index: number): boolean {
  const option = options[index];
  if (option === undefined) return false;
  const marks = [String(index + 1)];
  const letter = LETTERS[index];
  if (letter !== undefined) marks.push(letter);
  const plain = plainWords(said);
  if (marks.includes(plain)) return true;
  const full = plainWords(option.label);
  const words = bareWords(option.label);
  if (words === "") return false;
  if (plain === full || plain === words) return true;
  const marked = MARKED.exec(plain);
  if (marked === null) return false;
  const mark = marked[1] ?? marked[2];
  return mark !== undefined && marks.includes(mark) && (marked[3] === words || marked[3] === full);
}

/** Whether a vote carries its option's words as sent. */
function isOptionsVote(vote: Text, options: readonly SentOption[], index: number): boolean {
  const option = options[index];
  if (option === undefined) return false;
  const voted = plainWords(vote.words);
  return voted === plainWords(option.label) || voted === bareWords(option.label);
}

/** The sha256 of a read-back's exact words, lowercase hex (as K-29's consent rows bind to one). */
export async function sha256Hex(words: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(words));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const rowKey = (row: RowRef): string => JSON.stringify([row.table, row.rowId, row.version]);
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The same rows at the same versions, in any order. */
export function sameVersions(a: readonly RowRef[], b: readonly RowRef[]): boolean {
  const left = a.map(rowKey).sort(byKey);
  const right = b.map(rowKey).sort(byKey);
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Whether a text was sent no earlier than the read-back went out (both UTC); an unreadable time is never. */
function sentSince(text: Text, sentAt: string): boolean {
  const said = Date.parse(text.sentAt.utc);
  const went = Date.parse(sentAt);
  return Number.isFinite(said) && Number.isFinite(went) && said >= went;
}

/** Whether the choice moves money (default 3). */
export function movesMoney(choice: Choice): boolean {
  return choice.stakesFrom.some((reason) => MONEY_REASONS.includes(reason.why));
}

// ---- whose yes ------------------------------------------------------------------------------------------------------

type Yes =
  | {
      readonly via: "texts";
      readonly handleId: string;
      readonly giver: string | null;
      readonly texts: readonly Text[];
    }
  | { readonly via: "bound"; readonly handleId: string; readonly giver: string; readonly bound: BoundYes }
  | { readonly via: "none"; readonly why: NotExactWhy };

/** The yes a part was given, by who calls (step 2). */
async function yesOf(quote: string, turn: GateTurn, questionId: string, bindings: YesBindings): Promise<Yes> {
  const { caller } = turn.request;
  switch (caller.kind) {
    case "turn": {
      const handleId = turn.request.turn?.handleId;
      if (handleId === undefined) return { via: "none", why: "noPerson" };
      const texts = turn.context.texts.filter((text) => text.words.includes(quote));
      if (texts.length === 0) return { via: "none", why: "noText" };
      return { via: "texts", handleId, giver: caller.personId, texts };
    }
    case "page":
    case "agent": {
      const bound = await bindings.boundYes(turn.request, questionId);
      if (bound === null) return { via: "none", why: caller.kind === "agent" ? "unboundAgent" : "noPageYes" };
      if (caller.personId !== null && caller.personId !== bound.personId) {
        return { via: "none", why: "notTheirOwn" };
      }
      return { via: "bound", handleId: bound.handleId, giver: bound.personId, bound };
    }
    default:
      return { via: "none", why: "noPerson" };
  }
}

/** Whether T-308 names `personId` among those who decide what the part answers (default 2). */
async function decides(
  identity: IdentityAccess,
  personId: string,
  choice: Choice,
  question: AskedQuestion,
): Promise<boolean> {
  // T-308 answers for the call's business alone: a choice at another business has no decider here.
  if (choice.target.businessId !== identity.businessId) return false;
  const roles = await identity.rolesOf(personId);
  const reasons = choice.stakesFrom.map((reason) => reason.why);
  if (roles.some((role) => BUSINESS_ROLES.includes(role))) {
    if (reasons.includes("refund")) return identity.decides({ kind: "refund" }, personId);
    if (movesMoney(choice)) return identity.decides({ kind: "fee" }, personId);
    return true;
  }
  // The booking the part acts on decides who decides; the read-back's own, when the choice names none.
  const bookingId = choice.target.bookingId ?? question.bookingId;
  return bookingId === null ? true : identity.decides({ kind: "visit", bookingId }, personId);
}

// ---- the outcome ----------------------------------------------------------------------------------------------------

interface Failing {
  readonly turn: GateTurn;
  readonly choice: Choice;
  readonly ports: ExactYesPorts;
  /** The question as the context lists it (decide's frontier), if any. */
  readonly asked: ContextQuestion | undefined;
}

/** The step card's safe default, word for word, or null when the card has none (K-02 v1 stepCard). */
function safeDefaultOf(context: Context, step: string): string | null {
  return context.cards.find((card) => card.step === step)?.card.safeDefault ?? null;
}

/** A failure: the fresh read-back on a question asked once, else the safe default and the notice. */
async function failure(
  why: NotExactWhy,
  failing: Failing,
  question: AskedQuestion | null,
  person: string | null,
): Promise<ExactYesDecision> {
  const { turn, choice, ports, asked } = failing;
  const askCount = Math.max(question?.askCount ?? 0, asked?.askCount ?? 0);
  const openQuestionId = question?.openQuestionId ?? asked?.openQuestionId ?? null;
  const step = question?.step ?? asked?.step ?? choice.step;
  if (askCount < ASKS_BEFORE_SAFE_DEFAULT) {
    return {
      result: "fail",
      why,
      outcome: freshReadBackOutcome(),
      next: { kind: "freshReadBack", openQuestionId, step, askCount: askCount + 1 },
    };
  }
  const asker = question?.personId ?? person;
  const ownersOwn = asker !== null && (await ports.identity().rolesOf(asker)).includes("owner");
  return {
    result: "fail",
    why,
    outcome: safeDefaultOutcome(),
    next: {
      kind: "safeDefault",
      openQuestionId,
      step,
      safeDefault: safeDefaultOf(turn.context, step),
      told: { to: ownersOwn ? "rosieTeam" : "owner", businessId: turn.businessId, step, openQuestionId, why },
    },
  };
}

// ---- the rule -------------------------------------------------------------------------------------------------------

/** Limit 3 on one agreed part: pass, notChecked, or the failure with what the commit runs next. */
export async function decideExactYes(
  part: GatePart,
  turn: GateTurn,
  ports: ExactYesPorts,
): Promise<ExactYesDecision> {
  const { part: said, choice } = part;
  if (said.verb === "pass_on" || said.verb === "hand_off") return NOT_CHECKED;
  if (choice === null) throw new TypeError("limit 3 got a choose or enter part without its offered choice");
  const money = movesMoney(choice);
  const questionId = said.verb === "choose" && choice.kind === "option" ? choice.question : null;
  const asked =
    questionId === null
      ? undefined
      : turn.context.openQuestions.find((question) => question.openQuestionId === questionId);
  const failing: Failing = { turn, choice, ports, asked };

  // 1. What needs a yes.
  if (questionId === null) {
    return money ? failure("noReadBack", failing, null, turn.request.caller.personId) : NOT_CHECKED;
  }

  // 2. Whose yes, and the question it answers on the handle it came from.
  const yes = await yesOf(said.quote, turn, questionId, ports.bindings);
  const handleId = yes.via === "none" ? turn.request.turn?.handleId : yes.handleId;
  const found = handleId === undefined ? null : await ports.questions().liveQuestion(handleId, questionId);
  const question = found !== null && found.handleId === handleId ? found : null;
  if (yes.via === "none") return failure(yes.why, failing, question, turn.request.caller.personId);
  const giver = yes.giver;
  if (question === null) return failure("questionNotLive", failing, null, giver);
  const fail = (why: NotExactWhy): Promise<ExactYesDecision> => failure(why, failing, question, giver);

  // 3. A tapback is never a yes; a vote counts only on the question's own poll.
  if (yes.via === "texts") {
    if (yes.texts.some((text) => text.kind === "tapback")) return fail("tapback");
    const offPoll = (text: Text): boolean =>
      text.kind === "pollVote" && (question.pollId === null || text.poll?.pollId !== question.pollId);
    if (yes.texts.some(offPoll)) return fail("notOwnPoll");
  }

  // 4. Their own, and theirs to decide. A read-back always goes to a known person; a plain question may name nobody yet.
  if (giver === null) return fail("noPerson");
  const notTheirs = question.personId === null ? question.readback !== null : question.personId !== giver;
  if (notTheirs) return fail("notTheirOwn");
  if (!(await decides(ports.identity(), giver, choice, question))) return fail("notDecider");

  // A plain question: the person's own reply is enough, unless the part moves money.
  if (question.readback === null) return money ? fail("noReadBack") : PASS;

  // 5. Bound to the read-back's exact text and versions.
  if (money) {
    const otherBusiness = question.businessId !== null && question.businessId !== choice.target.businessId;
    const otherBooking = choice.target.bookingId !== null && question.bookingId !== choice.target.bookingId;
    if (otherBusiness || otherBooking) return fail("notThatBooking");
  }
  const index = optionIndex(question.options, choice);
  if (index < 0) return fail("notExact");
  if (yes.via === "bound") {
    const exactWords = (await sha256Hex(question.readback)) === yes.bound.readBackSha256;
    if (!exactWords || !sameVersions(yes.bound.versionsRead, question.versionsRead))
      return fail("staleReadBack");
    return PASS;
  }
  const sentAt = question.sentAt;
  if (sentAt === null) return fail("readBackNotSent");
  if (!yes.texts.every((text) => sentSince(text, sentAt))) return fail("staleReadBack");
  const exact = yes.texts.every((text) =>
    text.kind === "pollVote"
      ? isOptionsVote(text, question.options, index)
      : isExactAnswer(said.quote, question.options, index),
  );
  return exact ? PASS : fail("notExact");
}
