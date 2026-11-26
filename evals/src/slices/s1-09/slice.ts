// The S1-09 eval slice (T-1555 Gives 7; DL-1213, DL-1214; skill run-evals). S1-09 asks the owner for the business's
// details and "are you an owner?" in one text, and its three options each list one field, `business`, of type id. On the
// user's iPhone the runbook's answer was asked again: decide-2's agreed value was not a run of its own words, so limit 6
// refused it (ops/reviews/phone-test-nov23/diagnosis.json). This slice holds a real model's two reads to what decide-3
// and the backstop must give on that turn, in the three forms the card names:
//
//   s1-09-runbook-curly     "Lee’s Barbershop in Springfield, I’m the owner"   (an iPhone's curly apostrophes, DL-1213)
//   s1-09-runbook-straight  "Lee's Barbershop in Springfield, I'm the owner"   (the runbook as written)
//   s1-09-claim-first       "I’m the owner of Lee’s Barbershop in Springfield" (the claim before the details)
//
// An item is right when all of these hold (the card's Gives 7): decide answers decided, and both reads agree; one part,
// which goes; it chooses S1-09's open question's option "An owner; the listing matches" (c-01, the card's order); its
// `business` field's words are the business's name and town exactly as typed ("Lee’s Barbershop in Springfield", or the
// straight form for the straight text), in both reads; its value equals its words; and limit 6's real id rule passes it
// (actions/src/values/reparse.ts lines 343 to 345). Reported beside it, not counted: the settler's first try for the words
// (actions/src/tool-api/journey-1/listing/lookup.ts: the double's listing is found by {Lee's Barbershop, Springfield}),
// and whether each model's own value, before the backstop sets it, already equalled its words.
//
// The turn is laid on bundle v3 as staging runs it (bundles/v3/bundle: its manifest's id, models and routing policy, flow
// A's always-on rules and S1-09's card) with decide-3 in decide-2's place: bundle cut v3.1 as T-1556 will cut it. The
// context is the one staging's frontier builds after "Plumbing" (DL-1213): S1-09's one open question, asked once; its three
// options in the card's order with their Means lines, each listing business:id, low stakes (Haiku twice, as staging read
// it); the unclear-owner-text door and the danger row, as K-02's context-s1-02.json has them; Rosie's S1-09 line as the
// one recent message. Names are the master's sample cast and the double's documented listing (Sam Lee, Lee's
// Barbershop, Springfield), never a real business (rule 9).
//
// Pure, but for readBundleV3 (one read of the repository's files): nothing here calls a model. run.mjs makes the live
// calls; slice.test.ts holds the slice to the bundle and its scoring to known answers, with no call.

import { readFileSync } from "node:fs";
import path from "node:path";

import { reparse } from "../../../../actions/src/values/reparse";
import {
  foldMarks,
  triesOf,
  type NameAndTown,
} from "../../../../actions/src/tool-api/journey-1/listing/lookup";
import type { CacheBundle, CacheFlow, StepCard } from "../../../../ai/src/cache";
import type { Choice, DecideContext, Target } from "../../../../ai/src/context";
import { DECIDE_3_PROMPT } from "../../../../ai/src/decide";
import type { DecidePart, DecideTurnAnswer } from "../../../../ai/src/decide";
import type { GatewayBundle } from "../../../../ai/src/gateway";
import type { RoutingBundle, RoutingPolicy } from "../../../../ai/src/routing";

/** The slice's name, as the report names it. */
export const SLICE = "s1-09-decide";

/** One item: its id, the form the card names, the text the owner types, and the business's name and town in it. */
export interface SliceItem {
  readonly id: string;
  readonly form: "runbook, curly apostrophes" | "runbook, straight apostrophes" | "claim first";
  readonly text: string;
  readonly details: string;
}

export const S1_09_ITEMS: readonly SliceItem[] = Object.freeze([
  {
    id: "s1-09-runbook-curly",
    form: "runbook, curly apostrophes",
    text: "Lee’s Barbershop in Springfield, I’m the owner",
    details: "Lee’s Barbershop in Springfield",
  },
  {
    id: "s1-09-runbook-straight",
    form: "runbook, straight apostrophes",
    text: "Lee's Barbershop in Springfield, I'm the owner",
    details: "Lee's Barbershop in Springfield",
  },
  {
    id: "s1-09-claim-first",
    form: "claim first",
    text: "I’m the owner of Lee’s Barbershop in Springfield",
    details: "Lee’s Barbershop in Springfield",
  },
]);

/** S1-09's open question in the slice's context, and the option every item must choose (the card's order: c-01). */
export const OPEN_QUESTION = "oq-s1-09";
export const OWNER_OPTION = "c-01";
export const OWNER_BRANCH = "An owner; the listing matches";

/** The settler's first try the double's listing answers (K-15 search-by-name.json; K-09 README default 202). */
export const LISTING_TRY: NameAndTown = Object.freeze({ name: "Lee's Barbershop", town: "Springfield" });

/** The parts of bundle v3 the slice reads: its manifest's id, prompts, models and policy, and flow A. */
export interface BundleV3 {
  readonly manifest: {
    readonly bundleId: CacheBundle["manifest"]["bundleId"];
    readonly prompts: CacheBundle["manifest"]["prompts"];
    readonly models: GatewayBundle["models"];
    readonly policy: RoutingPolicy;
  };
  readonly flowA: CacheFlow & {
    readonly steps: Readonly<
      Record<
        string,
        {
          readonly card?: StepCard;
          readonly branches?: readonly {
            readonly label: string;
            readonly answerFields: readonly { name: string; type: string }[];
          }[];
          readonly say?: readonly { readonly from: string; readonly plainText: string }[];
        }
      >
    >;
  };
}

/** Bundle v3 as the repository holds it (bundles/v3/bundle), read once from `root`. */
export function readBundleV3(root: string): BundleV3 {
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(path.join(root, "bundles/v3/bundle", file), "utf8")) as unknown;
  return {
    manifest: read("manifest.json") as BundleV3["manifest"],
    flowA: read("flow/A.json") as BundleV3["flowA"],
  };
}

/** Bundle cut v3.1 as the layout reads it: bundle v3 with decide-3 in decide-2's place (T-1556). */
export function cacheBundleV31(v3: BundleV3): CacheBundle {
  return {
    manifest: {
      bundleId: v3.manifest.bundleId,
      prompts: { ...v3.manifest.prompts, decide: DECIDE_3_PROMPT },
    },
    flows: { A: v3.flowA },
  };
}

/** Bundle v3's id, models and routing policy, as the router reads them. */
export function routingBundleV3(v3: BundleV3): RoutingBundle {
  return { bundleId: v3.manifest.bundleId, models: v3.manifest.models, policy: v3.manifest.policy };
}

/** The stand-in business head the staging turn runs under (db/seeds/skeleton.ts; K-09 README default 130). */
const TARGET: Target = {
  businessId: "biz-lees-barbershop",
  businessName: "Lee's Barbershop",
  bookingId: null,
  visitAt: null,
};

const ZONE = "America/New_York";
const ASKED_AT = "2026-11-23T19:09:06Z";
const SENT_AT = "2026-11-23T19:10:00Z";

/** S1-09's step in bundle v3's flow A, with its card, its three branches and its first line. */
function s1_09Of(v3: BundleV3): {
  card: StepCard;
  branches: readonly { label: string; answerFields: readonly { name: string; type: string }[] }[];
  asked: string;
} {
  const step = v3.flowA.steps["S1-09"];
  const card = step?.card;
  const branches = step?.branches;
  const asked = step?.say?.[0]?.plainText;
  if (card === undefined || branches === undefined || asked === undefined)
    throw new Error("bundle v3's flow A holds S1-09 with its card, branches and first line");
  return { card, branches, asked };
}

/** A choice with no question, field or stakes reason, as context-s1-02.json gives the door and the danger row. */
function rowChoice(
  spec: Pick<Choice, "choiceId" | "kind" | "label" | "definition" | "step" | "anytimeRow" | "door">,
): Choice {
  return {
    ...spec,
    question: null,
    branch: null,
    hub: null,
    target: TARGET,
    fields: [],
    stakes: "low",
    stakesFrom: [],
  };
}

/** The K-02 context of one item's turn on bundle v3 (see the head of this file). */
export function s1_09Context(v3: BundleV3, item: SliceItem): DecideContext {
  const { card, branches, asked } = s1_09Of(v3);
  const options: Choice[] = branches.map((branch, k) => {
    const definition = card.means.find((meaning) => meaning.branch === branch.label)?.text;
    if (definition === undefined) throw new Error(`S1-09's card defines ${branch.label}`);
    return {
      choiceId: `c-0${String(k + 1)}`,
      kind: "option",
      label: branch.label,
      definition,
      step: "S1-09",
      question: OPEN_QUESTION,
      branch: branch.label,
      anytimeRow: null,
      door: null,
      hub: null,
      target: TARGET,
      fields: branch.answerFields.map((field) => ({ name: field.name, type: field.type })),
      stakes: "low",
      stakesFrom: [],
    };
  });
  return {
    turnId: `turn-${item.id}`,
    bundleId: v3.manifest.bundleId,
    flow: "A",
    texts: [
      {
        eventId: `evt-${item.id}`,
        kind: "text",
        words: item.text,
        sentAt: { utc: SENT_AT, zone: ZONE },
        attachments: [],
        poll: null,
        tapback: null,
      },
    ],
    writer: {
      handle: "+15555550100",
      people: [
        {
          personId: "person-sam",
          name: "Sam Lee",
          roles: [{ role: "owner", businessId: TARGET.businessId }],
          language: "en",
        },
      ],
    },
    businessLanguage: "en",
    openQuestions: [
      {
        openQuestionId: OPEN_QUESTION,
        step: "S1-09",
        target: TARGET,
        sentAt: { utc: ASKED_AT, zone: ZONE },
        pollId: null,
        askCount: 1,
      },
    ],
    choices: [
      ...options,
      rowChoice({
        choiceId: "c-04",
        kind: "door",
        label: "An unclear owner text or HELP",
        definition: "Nothing changes on a text Rosie can't act on for sure.",
        step: "S11-21",
        anytimeRow: null,
        door: "unclearOwnerOrHelp",
      }),
      rowChoice({
        choiceId: "c-05",
        kind: "anytime",
        label: "Danger or crisis",
        definition: "Every message and every call is checked before any answer, every time, by meaning.",
        step: "A3-22",
        anytimeRow: "danger-or-crisis",
        door: null,
      }),
    ],
    cards: [{ step: "S1-09", card }],
    facts: [],
    alwaysOn: { flow: "A", prefixSha256: v3.flowA.routing.alwaysOn.prefixSha256 },
    recentMessages: [{ from: "rosie", sentAt: { utc: ASKED_AT, zone: ZONE }, words: asked }],
    meaningSearch: null,
  };
}

/** What one item came to: each check, the settler's first try, the turn's cost and calls, and right or wrong. */
export interface ItemScore {
  readonly id: string;
  readonly status: DecideTurnAnswer["status"];
  readonly agreed: boolean;
  readonly onePartGoes: boolean;
  readonly ownerOption: boolean;
  readonly wordsAsTyped: boolean;
  readonly bothReadsWords: boolean;
  readonly valueIsWords: boolean;
  readonly limit6Passes: boolean;
  readonly right: boolean;
  /** The business field's words both reads agreed on (the owner's own typed test words), or null. */
  readonly words: string | null;
  readonly choice: string | null;
  readonly settlerFirstTry: NameAndTown | null;
  readonly settlerFindsListing: boolean;
  readonly costMicroUsd: number;
  readonly calls: number;
}

const businessOf = (part: DecidePart | undefined): { value: unknown; words: string } | null => {
  if (part?.verb !== "choose") return null;
  const field = part.fields.find((each) => each.name === "business");
  return field === undefined ? null : { value: field.value, words: field.words };
};

/** The turn's cost in whole micro-dollars and its number of model calls, from the gateway's K-08 model calls. */
export function costOf(answer: DecideTurnAnswer): { costMicroUsd: number; calls: number } {
  return {
    costMicroUsd: answer.modelCalls.reduce((sum, call) => sum + call.cost_micro_usd, 0),
    calls: answer.modelCalls.length,
  };
}

/** One item's answer scored by the checks at the head of this file. */
export function scoreItem(item: SliceItem, answer: DecideTurnAnswer): ItemScore {
  const cost = costOf(answer);
  const base = { id: item.id, status: answer.status, ...cost };
  if (answer.status !== "decided")
    return {
      ...base,
      agreed: false,
      onePartGoes: false,
      ownerOption: false,
      wordsAsTyped: false,
      bothReadsWords: false,
      valueIsWords: false,
      limit6Passes: false,
      right: false,
      words: null,
      choice: null,
      settlerFirstTry: null,
      settlerFindsListing: false,
    };
  const [only] = answer.result.parts;
  const part = only?.part;
  const onePartGoes = answer.result.parts.length === 1 && only?.outcome === "go";
  const ownerOption =
    part?.verb === "choose" && part.question === OPEN_QUESTION && part.choice === OWNER_OPTION;
  const business = businessOf(part);
  const words = business?.words ?? null;
  const wordsAsTyped = words === item.details;
  const bothReadsWords = answer.result.reads.every(
    (read) => businessOf(read.output.parts[0])?.words === item.details,
  );
  const valueIsWords = business !== null && business.value === business.words;
  const limit6Passes =
    business !== null &&
    reparse("id", business.value as Parameters<typeof reparse>[1], business.words, {
      sentAt: SENT_AT,
      zones: [ZONE],
    }).ok;
  const [firstTry] = words === null ? [] : triesOf(foldMarks(words));
  const agreed = answer.agreement.agreed && answer.result.agreed;
  return {
    ...base,
    agreed,
    onePartGoes,
    ownerOption,
    wordsAsTyped,
    bothReadsWords,
    valueIsWords,
    limit6Passes,
    right:
      agreed && onePartGoes && ownerOption && wordsAsTyped && bothReadsWords && valueIsWords && limit6Passes,
    words,
    choice: part !== undefined && (part.verb === "choose" || part.verb === "enter") ? part.choice : null,
    settlerFirstTry: firstTry ?? null,
    settlerFindsListing: firstTry?.name === LISTING_TRY.name && firstTry.town === LISTING_TRY.town,
  };
}
