// Doubles and inputs for the listing folder's tests (T-635a). Never imported by the Worker. None of them is the code under
// test: the K-15 port is T-434's Places double (adapters/src/places/double, its three made-up listings, Lee's Barbershop
// LLC at 88 Elm St, Springfield among them), the K-05 reads (items 79 and 26, as db/repo answers them) are fakes, the stop
// home's reads are T-317's and T-307's doubles over the frozen seeds (homes/stop/test-support), the paging reader is
// T-319's in-memory world (domain/paging/test-support), and the turn is commit-s1-02.json's second turn on bundle v1
// (commit/walk/test-support turnTwoOnV1: Sam, handle-sam, Lee's Barbershop) with S1-09's answer in its one part. S1-09's
// step is bundle v2's compiled one (T-1477); S1-76, which no bundle holds yet, is K-01 v1's shape with the fields the walk
// reads. Every value comes from the contracts' fixtures, fixture set v1 and the master's sample cast; the real-looking
// name and town are made up and are no real business (rule 9); phone numbers only 555-01xx, written whole.

import type {
  CompanyRead,
  ReadPickedKindsOutcome,
  ReadPickedKindsRequest,
} from "../../../../../db/repo/kinds-reads";
import type { SetupTurnStateOutcome } from "../../../../../db/repo/setup/turn-state";
import type { FactValue, ReadTurnStateRequest } from "../../../../../db/repo/turn-state";
import type { CommitTurnContext, GateAndCommitRequest, PassedPart } from "../../../commit";
import {
  flowGraphOf,
  textSourceOf,
  type GraphStep,
  type StepSettlerCall,
  type StepWriterCall,
} from "../../../commit/walk";
import { decidedOf, flowAV2, turnTwoOnV1, type WalkTestRepo } from "../../../commit/walk/test-support";
import type { Choice } from "../../../gate/framework";
import { READ_AT } from "../kinds/test-support";
import { HELPS_RUN_IT, NO_MATCH, OWNER_MATCHES, S1_76 } from "./settle";
import type { ListingK05Reads } from "./reads";

/** Sam's business, person and handle (K-04 seed-business-head.json, seed-person-roles.json): the turn's own. */
export const SAM_BUSINESS = "biz-lees-barbershop";
export const SAM_PERSON = "person-sam";
export const SAM_HANDLE = "handle-sam";

/** Sam's own company of Lee's Barbershop (K-23 seed-company-two-kinds.json): the company the turn runs under. */
export const SAM_COMPANY = "company-lees-barbershop";

/** The ruling's own words (S1-09 design card 7), as typed with a straight apostrophe and with an iPhone's curly one. */
export const RULING_WORDS = "Lee's Barbershop in Springfield, I'm the owner";
export const RULING_WORDS_CURLY = "Lee’s Barbershop in Springfield, I’m the owner";

/** The name S1-09's writer writes for the ruling's words: try (1)'s name, as typed (default 202). */
export const DEMO_NAME = "Lee's Barbershop";

/** A real-looking name and town, made up: the double answers noMatch for every try. */
export const MADE_UP_WORDS = "Maple Corner Cuts, Riverton";
export const MADE_UP_NAME = "Maple Corner Cuts";

/** The Means line of each of S1-09's branches (MASTER-FLOW-A lines 118 to 120), as the frontier defines the option. */
const DEFINITIONS: Readonly<Record<string, string>> = {
  [OWNER_MATCHES]: "they say they own it, in any words, and the listing matches what they sent.",
  [HELPS_RUN_IT]: "a manager, family member or assistant.",
  [NO_MATCH]: "the listing shows another name or address, or the business is already on Rosie.",
};

/** Each branch's option choice id, in the card's order (open-questions.ts cardChoices). */
const CHOICE_IDS: Readonly<Record<string, string>> = {
  [OWNER_MATCHES]: "c-01",
  [HELPS_RUN_IT]: "c-02",
  [NO_MATCH]: "c-03",
};

/** S1-09 as bundle v2 compiles it (T-1477): a split of three message branches whose message carries two buttons. */
export function s1_09Step(): GraphStep {
  const step = flowGraphOf(flowAV2(), "A").step("S1-09");
  if (step === null) throw new Error("bundle v2 holds S1-09");
  return step;
}

/** S1-76 in K-01 v1's shape as the walk reads it (MASTER-FLOW-A lines 158 to 166): a plain step that tells the owner. */
export function s1_76Step(): GraphStep {
  return {
    id: S1_76,
    who: "san",
    to: "owner",
    via: "msg",
    gated: false,
    split: false,
    branches: [],
    gives: [],
    tells: ["owner"],
    buttons: 0,
    buttonLabels: [],
    next: "S1-10",
    card: null,
  };
}

/** S1-09's answer as the commit hands it to the walk: the request, the passed part and its option, the turn context. */
export interface S1_09Turn {
  readonly request: GateAndCommitRequest;
  readonly part: PassedPart;
  readonly choice: Choice;
  readonly context: CommitTurnContext<WalkTestRepo>;
}

/**
 * Sam's answer to S1-09 on commit-s1-02.json's second turn: its text and the part's quote `text`, its one part choosing
 * the option of `branch`, with the `business` field's value and words `details` (left out when null, as decide leaves out
 * a field the turn gives no words for: default 200).
 */
export function s1_09Turn(branch: string, details: string | null, text: string = details ?? "1"): S1_09Turn {
  const turn = turnTwoOnV1("c-01");
  const { request } = turn.exchange;
  const decided = decidedOf(request);
  const [entry] = decided.decide.parts;
  if (entry.part.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
  entry.part.quote = text;
  entry.part.question = "oq-s1-09-sam";
  entry.part.choice = CHOICE_IDS[branch] ?? "c-01";
  entry.part.fields = details === null ? [] : [{ name: "business", value: details, words: details }];
  const [first] = decided.context.texts;
  first.words = text;
  const choice: Choice = {
    ...turn.choice,
    question: "oq-s1-09-sam",
    branch,
    label: branch,
    definition: DEFINITIONS[branch] ?? branch,
    choiceId: entry.part.choice,
    step: "S1-09",
    fields: [{ name: "business", type: "id" }],
  };
  return { request, part: { index: 0, part: entry.part, choice }, choice, context: turn.context };
}

/** The walk's ask of S1-09's settler for the turn (settle.ts StepSettlerCall), on its turn context. */
export function settlerCall(turn: S1_09Turn, step: GraphStep = s1_09Step()): StepSettlerCall<WalkTestRepo> {
  return {
    repo: turn.context.repo,
    businessId: turn.context.businessId,
    step,
    part: turn.part,
    choice: turn.choice,
    turn: turn.context,
  };
}

/**
 * The walk's call of a writer at `step` for the turn, the settled branch handed as the branch chosen (default 191), on the
 * same turn context as the settler's, its row ids default 131's under `turnKey`.
 */
export function writerCall(
  turn: S1_09Turn,
  step: GraphStep,
  branch: string,
  turnKey = "sam",
): StepWriterCall<WalkTestRepo> {
  const counts = new Map<string, number>();
  return {
    repo: turn.context.repo,
    step,
    part: turn.part,
    choice: { ...turn.choice, branch },
    writer: {
      turn: turn.context,
      why: { step: "S1-09", choice: branch },
      zone: "America/New_York",
      writerLane: "owner",
      rowId: (kind) => {
        const n = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, n);
        return `${kind}-${step.id.toLowerCase()}-${turnKey}-${String(n)}`;
      },
      text: () => textSourceOf(turn.request),
    },
  };
}

/** Sam's company of Lee's Barbershop as item 79 answers it (K-23 seed-company-two-kinds.json). */
export function samCompany(): CompanyRead {
  return {
    id: SAM_COMPANY,
    ownerPersonId: SAM_PERSON,
    name: "Lee's Barbershop LLC",
    businessId: SAM_BUSINESS,
    version: 1,
  };
}

/** One read the listing double was asked for, with the repo it was handed where it takes one. */
export type ListingAsked =
  | { readonly read: "readPickedKinds"; readonly request: ReadPickedKindsRequest }
  | { readonly read: "readTurnState"; readonly repo: unknown; readonly request: ReadTurnStateRequest };

/** What the listing double answers. */
export interface ListingGiven {
  /** Item 79's companies (default: Sam's company of Lee's Barbershop). */
  readonly companies?: readonly CompanyRead[];
  /** The business head's version (default 3). */
  readonly headVersion?: number;
  /** Whether the business's business_setup row is on file (default: none, so the writer inserts it). */
  readonly setupOnFile?: boolean;
  readonly picked?: ReadPickedKindsOutcome;
  readonly turnState?: SetupTurnStateOutcome;
}

export interface FakeListing {
  readonly k05: ListingK05Reads<WalkTestRepo>;
  /** Every read, in order. */
  readonly asked: ListingAsked[];
}

/** readTurnState's answer to the facts asked: the head's version, the setup row's when on file, else notFound. */
function turnStateOf(request: ReadTurnStateRequest, given: ListingGiven): SetupTurnStateOutcome {
  const facts: FactValue[] = [];
  for (const fact of request.facts) {
    if (fact.table === "businesses") {
      const version = given.headVersion ?? 3;
      facts.push({ ...fact, value: version, version });
    } else if (fact.table === "business_setup" && given.setupOnFile === true) {
      facts.push({ ...fact, value: 1, version: 1 });
    } else {
      return { error: "notFound", table: fact.table, rowId: fact.rowId };
    }
  }
  return {
    result: "turnState",
    handleId: request.handleId,
    handle: { kind: "phone", address: "+15555550100" },
    businessId: request.businessId,
    readAt: READ_AT,
    persons: [],
    roles: [],
    phone: null,
    openQuestions: [],
    bookings: [],
    pauses: [],
    consents: [],
    facts,
  };
}

/** The two reads as db/repo answers them, each written down and answered as a copy. */
export function fakeListingK05(given: ListingGiven = {}): FakeListing {
  const asked: ListingAsked[] = [];
  return {
    asked,
    k05: {
      readPickedKinds(request) {
        asked.push({ read: "readPickedKinds", request: structuredClone(request) });
        const answer: ReadPickedKindsOutcome = given.picked ?? {
          result: "pickedKinds",
          businessId: request.businessId,
          personId: request.personId,
          readAt: READ_AT,
          picks: [],
          companies: [...(given.companies ?? [samCompany()])],
        };
        return Promise.resolve(structuredClone(answer));
      },
      readTurnState(repo, request) {
        asked.push({ read: "readTurnState", repo, request: structuredClone(request) });
        return Promise.resolve(structuredClone(given.turnState ?? turnStateOf(request, given)));
      },
    },
  };
}
