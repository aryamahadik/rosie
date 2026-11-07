// The prompt layout (T-364, C-122): where the cached prefixes sit in every model call, so repeat calls read them from
// Anthropic's prompt cache (arch 03 line 181: "the 50 rules as a cached prefix"; arch 07 line 399: "a cached system
// prompt"; arch 10 line 536: "Prompt caching covers the rules and static card text"). rules.ts holds Anthropic's rules.
//
// Every call is laid out in one fixed order:
//
//   system  1. The static segment: the bundle's prompt for the call (K-01 manifest.prompts), then, for decide, the
//              re-read and the planner, the flow's always-on rules (routing.alwaysOn.prefixText, about 20,000 tokens).
//              It is built from the bundle's own texts alone, so it is the same bytes for every turn on one bundle id.
//                                                                                          <- cache breakpoint
//           2. The cards segment, when a decide, re-read or planner turn shows cards: the full step cards of the turn's
//              open questions and hubs (question, Means, Never, safe default), as the bundle holds them, once each,
//              sorted by step id. Static card text: the same bytes whenever a turn shows the same cards.
//                                                                                          <- cache breakpoint
//   user    3. The per-turn part: choices, facts, who, role and language, recent messages, the turn's texts, and any
//              stage's own instruction. Its stage writes it (C-114 for decide and the planner, C-118 for the composer,
//              C-113 for the safety read). It is after the last breakpoint, so it is never cached and never moves a
//              cached byte.
//
// What the cached segments never hold: a time, an id of a turn, event, person, trace or request, or any other value
// of one turn. Not even the bundle id: the bytes are a function of the bundle's texts, so a new bundle whose rules,
// prompts or cards changed gets new prefixes, and a new bundle id over the same texts keeps them, and so its warm cache.
//
// Which call gets what (K-08 v1's model-call purposes):
//   safetyRead                          the safety read prompt; the raw text after it
//   decideFirst, decideCheck, reread    the decide prompt and the rules; the cards; then the turn. Both of decide's
//                                       calls a read (CQ-25: stage 1 the parts, stage 2 one call per part) use this
//                                       layout; each stage's own words ride in the per-turn part.
//   planner                             the planner prompt and the rules; the cards; then the turn
//   compose, rewrite                    the composer's system prompt; then the outbox row's input
//
// A model, a stage's schema and its effort each key their own cache entries (rules.ts), so the same static bytes are
// written once per model and schema and then read by every later call of that kind within the lifetime.

import { bundleIdProblems, type BundleId } from "../../../runtime/src/trace";
import {
  FLOW_LETTERS,
  PROMPT_KINDS,
  bundleIdText,
  canonical,
  sameBundleId,
  sha256Hex,
  type CacheBundle,
  type CacheFlow,
  type FlowLetter,
  type PromptKind,
  type StepCard,
} from "./bundle";
import { CacheLayoutError } from "./errors";

/** The model-call purposes of K-08 v1, each laid out as above. */
export const CACHE_PURPOSES = [
  "safetyRead",
  "decideFirst",
  "decideCheck",
  "reread",
  "planner",
  "compose",
  "rewrite",
] as const;
export type CachePurpose = (typeof CACHE_PURPOSES)[number];

/** The purposes that read a K-02 context: the rules and the turn's cards are in their prefix. */
export const CONTEXT_PURPOSES = ["decideFirst", "decideCheck", "reread", "planner"] as const;
export type ContextPurpose = (typeof CONTEXT_PURPOSES)[number];
/** The purposes whose prefix is their prompt alone. */
export type PlainPurpose = Exclude<CachePurpose, ContextPurpose>;

/** The bundle prompt each purpose is given. */
export const PROMPT_OF: Readonly<Record<CachePurpose, PromptKind>> = {
  safetyRead: "safetyRead",
  decideFirst: "decide",
  decideCheck: "decide",
  reread: "decide",
  planner: "planner",
  compose: "composer",
  rewrite: "composer",
};

/** The wrappers the static and cards segments are written in (Anthropic's advice: XML tags around each input). */
export const RULES_OPEN = "\n\n<always_on_rules>\n";
export const RULES_CLOSE = "\n</always_on_rules>";
export const CARDS_OPEN = "\n\n<step_cards>\n";
export const CARDS_CLOSE = "\n</step_cards>";

/** K-01 v1 `stepId`. */
const STEP_ID = /^[SAB](1[0-3]|[1-9])-x?[0-9]{2,3}$/u;
const HAS_TEXT = /\S/u;

/** One card of a turn, as K-02 v1's context gives it (`stepCard`): the step and its card. */
export interface TurnCard {
  readonly step: string;
  readonly card: StepCard;
}

/** What the layout reads of a K-02 v1 context: its bundle, flow, cards and the cached prefix it names by hash. */
export interface TurnContext {
  readonly bundleId: BundleId;
  readonly flow: FlowLetter;
  readonly cards: readonly TurnCard[];
  readonly alwaysOn: { readonly flow: FlowLetter; readonly prefixSha256: string };
}

/** A decide, re-read or planner call: its flow (for the rules), the turn's cards and the per-turn part. */
export interface ContextLayout {
  readonly purpose: ContextPurpose;
  readonly flow: FlowLetter;
  readonly cards: readonly TurnCard[];
  readonly turn: string;
}

/** A safety read, composer or rewrite call: its per-turn part (the raw text, or the outbox row's input). */
export interface PlainLayout {
  readonly purpose: PlainPurpose;
  readonly turn: string;
}

export type LayoutRequest = ContextLayout | PlainLayout;

/** One cached segment of the system prompt; each ends at a cache breakpoint. */
export interface PromptSegment {
  readonly kind: "static" | "cards";
  readonly text: string;
}

/** One call, laid out: its cached segments in order, then the per-turn part. */
export interface CachedPrompt {
  readonly bundleId: BundleId;
  readonly purpose: CachePurpose;
  /** The system prompt: the static segment, then the cards segment when there is one. */
  readonly segments: readonly PromptSegment[];
  /** The user message: the per-turn part, after the last breakpoint. */
  readonly turn: string;
}

/** The layout of one bundle's calls. */
export interface PromptCache {
  readonly bundleId: BundleId;
  /** Lays out one call. */
  layout(request: LayoutRequest): CachedPrompt;
  /**
   * Lays out a decide, re-read or planner call from its K-02 context, after checking the context is of this bundle:
   * its bundle id, its flow and the rules' hash it names (context.alwaysOn).
   */
  forContext(context: TurnContext, purpose: ContextPurpose, turn: string): CachedPrompt;
}

function renderCard(step: string, card: StepCard): string {
  const lines = [`<card step="${step}">`, `Question: ${card.question}`];
  if (card.means.length > 0) {
    lines.push("Means:");
    for (const meaning of card.means) {
      lines.push(meaning.text === undefined ? `- ${meaning.branch}` : `- ${meaning.branch}: ${meaning.text}`);
    }
  }
  lines.push(...card.never);
  if (card.safeDefault !== undefined) lines.push(`Safe default: ${card.safeDefault}`);
  lines.push("</card>");
  return lines.join("\n");
}

const byStep = ([a]: [string, StepCard], [b]: [string, StepCard]): number => (a < b ? -1 : a > b ? 1 : 0);

/** Checks the bundle's texts are the ones it was published with, then builds its layout. */
export function createPromptCache(bundle: CacheBundle): PromptCache {
  const { manifest } = bundle;
  const bundleId = manifest.bundleId;
  const problems = bundleIdProblems(bundleId);
  if (problems.length > 0) throw new CacheLayoutError(`the bundle id is not K-01's: ${problems.join("; ")}`);
  const name = `bundle ${bundleIdText(bundleId)}`;

  for (const kind of PROMPT_KINDS) {
    const prompt = manifest.prompts[kind];
    if (sha256Hex(prompt.text) !== prompt.sha256) {
      throw new CacheLayoutError(`${name}: the ${kind} prompt's text does not match its sha256`);
    }
  }
  const flows = new Map<FlowLetter, CacheFlow>();
  for (const letter of FLOW_LETTERS) {
    const flow = bundle.flows[letter];
    if (flow === undefined) continue;
    if (flow.flow !== letter) throw new CacheLayoutError(`${name}: flows.${letter} is flow ${flow.flow}`);
    const rules = flow.routing.alwaysOn;
    if (sha256Hex(rules.prefixText) !== rules.prefixSha256) {
      throw new CacheLayoutError(`${name}: flow ${letter}'s always-on rules do not match their prefixSha256`);
    }
    flows.set(letter, flow);
  }

  const flowOf = (letter: FlowLetter): CacheFlow => {
    const flow = flows.get(letter);
    if (flow === undefined) throw new CacheLayoutError(`${name} holds no flow ${letter}`);
    return flow;
  };

  const promptText = (purpose: CachePurpose): string => {
    const kind = PROMPT_OF[purpose];
    const text = manifest.prompts[kind].text;
    if (!HAS_TEXT.test(text)) throw new CacheLayoutError(`${name}: the ${kind} prompt is empty`);
    return text;
  };

  // The static segments, built once: the same string object for every call of a purpose and flow.
  const withRules = new Map<string, string>();
  const staticSegment = (purpose: CachePurpose, flow: FlowLetter | null): string => {
    if (flow === null) return promptText(purpose);
    const key = `${PROMPT_OF[purpose]}/${flow}`;
    let text = withRules.get(key);
    if (text === undefined) {
      text = `${promptText(purpose)}${RULES_OPEN}${flowOf(flow).routing.alwaysOn.prefixText}${RULES_CLOSE}`;
      withRules.set(key, text);
    }
    return text;
  };

  // The turn's cards as the bundle holds them, once each, sorted by step id. A card the bundle holds must be the
  // context's copy exactly; one it does not hold is taken from the context only when the bundle is partial.
  const cardsSegment = (letter: FlowLetter, cards: readonly TurnCard[]): string | null => {
    const flow = flowOf(letter);
    const chosen = new Map<string, StepCard>();
    for (const { step, card } of cards) {
      if (!STEP_ID.test(step)) throw new CacheLayoutError(`${JSON.stringify(step)} is not a step id`);
      const held = flow.steps[step];
      let use: StepCard;
      if (held !== undefined) {
        if (held.card === undefined) throw new CacheLayoutError(`${name}: step ${step} has no card`);
        if (canonical(held.card) !== canonical(card)) {
          throw new CacheLayoutError(`${name}: the turn's card for ${step} is not the bundle's`);
        }
        use = held.card;
      } else if (manifest.partial === true) {
        use = card;
      } else {
        throw new CacheLayoutError(`${name} holds no step ${step} in flow ${letter}`);
      }
      const earlier = chosen.get(step);
      if (earlier !== undefined && canonical(earlier) !== canonical(use)) {
        throw new CacheLayoutError(`the turn gives two different cards for ${step}`);
      }
      chosen.set(step, use);
    }
    if (chosen.size === 0) return null;
    const rendered = [...chosen.entries()].sort(byStep).map(([step, card]) => renderCard(step, card));
    return `${CARDS_OPEN}${rendered.join("\n")}${CARDS_CLOSE}`;
  };

  const layout = (request: LayoutRequest): CachedPrompt => {
    if (!HAS_TEXT.test(request.turn)) throw new CacheLayoutError("the per-turn part is empty");
    const segments: PromptSegment[] = [];
    if (isContextLayout(request)) {
      segments.push({ kind: "static", text: staticSegment(request.purpose, request.flow) });
      const cards = cardsSegment(request.flow, request.cards);
      if (cards !== null) segments.push({ kind: "cards", text: cards });
    } else {
      segments.push({ kind: "static", text: staticSegment(request.purpose, null) });
    }
    return Object.freeze({
      bundleId,
      purpose: request.purpose,
      segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
      turn: request.turn,
    });
  };

  return Object.freeze({
    bundleId,
    layout,
    forContext(context: TurnContext, purpose: ContextPurpose, turn: string): CachedPrompt {
      if (!sameBundleId(context.bundleId, bundleId)) {
        throw new CacheLayoutError(
          `the turn is on bundle ${bundleIdText(context.bundleId)}, not on ${name}: a turn is laid out by its own bundle`,
        );
      }
      if (context.alwaysOn.flow !== context.flow) {
        throw new CacheLayoutError(
          `the context names flow ${context.alwaysOn.flow}'s rules on a flow ${context.flow} turn`,
        );
      }
      if (context.alwaysOn.prefixSha256 !== flowOf(context.flow).routing.alwaysOn.prefixSha256) {
        throw new CacheLayoutError(`the context's cached prefix is not ${name}'s flow ${context.flow} rules`);
      }
      return layout({ purpose, flow: context.flow, cards: context.cards, turn });
    },
  });
}

/** The purposes that read a K-02 context, as a type guard. */
export function isContextPurpose(purpose: CachePurpose): purpose is ContextPurpose {
  return (CONTEXT_PURPOSES as readonly string[]).includes(purpose);
}

function isContextLayout(request: LayoutRequest): request is ContextLayout {
  return isContextPurpose(request.purpose);
}
