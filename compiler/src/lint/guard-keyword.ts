// A button whose whole text is a guard keyword (T-159; C-070; K-01 v1 lint rule `guard-keyword-button`; arch 12 line
// 592; QUESTIONS Q-14's default).
//
// Code alone acts on a text that is only START, HELP or one of msgtext.js's 16 opt-out words (arch 02 line 115), and a
// chat app may send a button's words as the reply (msgtext.js line 94). So a button whose whole text is one of those words
// acts as that word when tapped: S1-37's "Start" reads as START (arch 12 line 592), and a button "Stop" would stop the
// texts. The rule fails each such button, an error on its step (Q-14's default: the lint fails the step, and a reworded
// button goes to Jay in the J-18 overlay batch, T-164).
//
// A button's whole text is a guard keyword when, trimmed and in any case, it is START, HELP or one of the opt-out words:
// msgtext.js line 95's reading (String(label).trim().toUpperCase(), which it applies to the opt-out words alone) and K-01's
// own check on a compiled step (bundle.v1.schema.json keywordText and keywordButton; the refused fixture
// refuse-guard-keyword-button.json, S1-37 as the master writes it). The words are T-134's one keyword list
// (compiler/src/msgtext/keywords.ts buildKeywords(), which the bundle carries as lists.keywords), never a copy. Words that
// only hold a keyword ("Start now", "Stop texts") and words that are none ("Yes", "No") pass.
//
// What is read, on each step the runner hands the rules (ctx.pageOrder, branch steps included):
//   - each message of the step's `say`, and of each variant's `say` and `addSay` (SPEC-master 4, 5f), from any sender,
//     numbered as lib.js numbers a variant's lines (its say, then its addSay);
//   - a message as the master writes it, [from, to, text, elements], as a trade may write it, [from, to, elements] with no
//     text (load/trade.ts TradeMessage), or as the bundle writes it, { from, to, text, elements } (K-01 message), so a
//     compiled step such as a K-01 fixture is read as it stands;
//   - of its elements, the buttons (msgtext.js line 9, `ui.buttons`: taps numbered 1, 2, 3), each a label or a
//     [key, label] pair (msgtext.js bKey and bLab, lines 33-35). Each word of a pair is read, as K-01's keywordButton
//     reads it; a key is one letter or digit (msgtext.js line 91), so only a label can match in the sources.
//   Not read, as neither msgtext.js line 95 nor K-01's check reads them: a card's one action (`ui.card.button`,
//   msgtext.js line 5, shown with its link), and times, list rows and stars, whose reply is a letter or a number
//   (msgtext.js lines 7, 8 and 13).
// A step a trade switched off (an `off` op on it, or on a branch it sits under: overlay/apply.ts AppliedStep.off and
// AppliedBranch.off) is not read: its words are never sent, so nothing can be tapped. The master has none.
//
// One hit per button: its field `message N button M` (`vary '<key>' message N button M` in a variant), its text the words
// as written. T-160 writes K-01's lintFailure from it (lint-report.json: "S1-37's button 'Start' is the guard keyword
// START (Q-14)."); keywordReader() gives the keyword back for the words.
import { buildKeywords } from "../msgtext";
import { isRecord, LintError, type LintContext, type LintHit, type LintRule, type LintStep } from "./runner";

/** The rule's id: K-01 lintRule `guard-keyword-button` (arch 12 line 592: "when a button's whole text is a guard keyword"). */
export const GUARD_KEYWORD_RULE = "guard-keyword-button";

/** The guard's keywords as the rule reads them: K-01 v1 keywords (T-134's buildKeywords(); the bundle's lists.keywords). */
export interface GuardWords {
  readonly start: string;
  readonly help: string;
  readonly optOut: readonly string[];
}

/** Words as the rule compares them: trimmed, in upper case (msgtext.js line 95). */
function keyOf(words: string): string {
  return words.trim().toUpperCase();
}

/**
 * Reads words against the guard's keywords (T-134's list by default): the keyword they are, trimmed and in any case, as
 * the list writes it (START, HELP, STOP ...), or null when they are none or hold more than one. Throws LintError when a
 * word of the list is blank or the list has no opt-out word: the rule cannot judge a button without the guard's words.
 */
export function keywordReader(keywords: GuardWords = buildKeywords()): (words: string) => string | null {
  const all = [keywords.start, keywords.help, ...keywords.optOut];
  if (keywords.optOut.length === 0 || all.some((word) => keyOf(word) === ""))
    throw new LintError(
      "the guard's keyword list has a blank word or no opt-out word: buttons cannot be judged without it",
    );
  const byKey = new Map<string, string>();
  for (const word of all) if (!byKey.has(keyOf(word))) byKey.set(keyOf(word), word);
  return (words) => byKey.get(keyOf(words)) ?? null;
}

/** One button whose whole text is a guard keyword. */
export interface KeywordButton {
  /** Where on the step: `message 2 button 1`, `vary 'pf:sensitive' message 1 button 2`. */
  readonly field: string;
  /** The button's words as written. */
  readonly words: string;
  /** The keyword they are, as the list writes it. */
  readonly keyword: string;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** A message's chat elements: the master's [from, to, text, elements], a trade's [from, to, elements], K-01's object. */
function elementsOf(message: unknown): Record<string, unknown> | null {
  if (Array.isArray(message)) {
    const items = message as unknown[];
    const last = items.length === 4 ? items[3] : items.length === 3 ? items[2] : undefined;
    return isRecord(last) ? last : null;
  }
  return isRecord(message) && isRecord(message.elements) ? message.elements : null;
}

/** The words a button holds: its label, or each word of a [key, label] pair (msgtext.js bKey and bLab, lines 34-35). */
function buttonWords(button: unknown): string[] {
  if (typeof button === "string") return [button];
  return list(button).filter((word): word is string => typeof word === "string");
}

/** The message lists of a step or a variant (a variant adds messages with addSay). */
interface Messages {
  readonly say?: unknown;
  readonly addSay?: unknown;
}

/**
 * The buttons of one step whose whole text is a guard keyword, read with `keywordOf` (keywordReader()): its own messages
 * first, then each variant's in the variants' order, each message's buttons in order.
 */
export function keywordButtons(step: LintStep, keywordOf: (words: string) => string | null): KeywordButton[] {
  const out: KeywordButton[] = [];
  const read = (messages: Messages, pre: string): void => {
    list(messages.say)
      .concat(list(messages.addSay))
      .forEach((message, k) => {
        list(elementsOf(message)?.buttons).forEach((button, j) => {
          for (const words of buttonWords(button)) {
            const keyword = keywordOf(words);
            if (keyword === null) continue;
            out.push({ field: `${pre}message ${String(k + 1)} button ${String(j + 1)}`, words, keyword });
            break;
          }
        });
      });
  };
  read(step, "");
  const vary = isRecord(step.vary) ? step.vary : {};
  for (const [key, patch] of Object.entries(vary)) if (isRecord(patch)) read(patch, `vary '${key}' `);
  return out;
}

/** Switched off by a trade's `off` op, which leaves its reason on the step or the branch (overlay/apply.ts). */
function isOff(part: object): boolean {
  return "off" in part && part.off !== undefined;
}

/** The steps a trade switched off: each step an `off` op names, each under a branch one names, and every step under them. */
function switchedOff(steps: readonly LintStep[]): Set<LintStep> {
  const off = new Set<LintStep>();
  const visit = (group: readonly LintStep[], under: boolean): void => {
    for (const step of group) {
      const dead = under || isOff(step);
      if (dead) off.add(step);
      for (const branch of step.branches ?? []) visit(branch.steps ?? [], dead || isOff(branch));
    }
  };
  visit(steps, false);
  return off;
}

/** What to do about a button whose words are `keyword`, in plain words. */
function fixFor(keyword: string): string {
  return `a tap may send its words, which the guard reads as ${keyword} (arch 02 line 115; msgtext.js line 94): reword the button by what it does, so that its whole text is no guard keyword; Jay approves the new words in the J-18 overlay batch (Q-14)`;
}

/**
 * The rule, reading the guard's keywords from `keywords` (T-134's buildKeywords() by default, read on each run, as the
 * bundle carries it in lists.keywords).
 */
export function guardKeywordRule(keywords?: GuardWords): LintRule {
  return {
    id: GUARD_KEYWORD_RULE,
    name: "button is a guard keyword",
    source:
      "arch 12 line 592 ('when a button's whole text is a guard keyword, such as S1-37's \"Start\"'); arch 02 line 115; QUESTIONS Q-14's default; K-01 v1 keywordText and keywordButton; msgtext.js lines 94-95; T-134's keyword list",
    run(ctx: LintContext): LintHit[] {
      const keywordOf = keywordReader(keywords ?? buildKeywords());
      const off = switchedOff(ctx.steps);
      const hits: LintHit[] = [];
      for (const step of ctx.pageOrder) {
        if (off.has(step)) continue;
        for (const button of keywordButtons(step, keywordOf))
          hits.push({
            rule: GUARD_KEYWORD_RULE,
            level: "error",
            step: step.id,
            field: button.field,
            text: button.words,
            fix: fixFor(button.keyword),
          });
      }
      return hits;
    },
  };
}

/** The rule on T-134's keyword list. */
export const guardKeyword: LintRule = guardKeywordRule();
