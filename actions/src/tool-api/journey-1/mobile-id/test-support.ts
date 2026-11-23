// Doubles and inputs for the mobile-id folder's tests (T-1533). Never imported by the Worker. None of them is the code
// under test: the K-05 reads (items 79 and 26, as db/repo answers them) are fakes, the stop home's reads are T-317's and
// T-307's doubles over the frozen seeds (homes/stop/test-support), S1-09's reading comes from T-635a's own settler over
// T-434's Places double (listing/test-support), and S1-10 is bundle v3's compiled step (T-1526). Every value comes from
// the contracts' fixtures, fixture set v1 and the master's sample cast; phone numbers only 555-01xx, written whole (rule
// 9). The secure link's host and base path are staging's (rosfield.com and /test: DL-014, DL-023).

import type { CompanyRead } from "../../../../../db/repo/kinds-reads";
import type { SetupTurnStateOutcome } from "../../../../../db/repo/setup/turn-state";
import type { FactValue, ReadTurnStateRequest } from "../../../../../db/repo/turn-state";
import { flowGraphOf, type GraphStep } from "../../../commit/walk";
import { flowAV3, type WalkTestRepo } from "../../../commit/walk/test-support";
import type { RandomFill } from "../../../domain/proof-codes";
import { READ_AT } from "../kinds/test-support";
import type { ListingK05Reads } from "../listing/reads";
import { SAM_HANDLE, SAM_PERSON, samCompany } from "../listing/test-support";
import type { AccountOnFile } from "./reads";
import type { LinkStage, SecureLinkDeps } from "./writer";

/** Sam's number (K-04 seed-person-roles.json handle-sam; seed-phone-chat-open.json's phones row). */
export const SAM_NUMBER = "+15555550100";

/** Another number of the seeds (handle-alex's), a mobile on file that is not the chat's. */
export const OTHER_NUMBER = "+15555550101";

/** Staging's link host and base path (DL-014, DL-023), as the Worker's LINK_HOST and BASE_PATH. */
export const LINK_HOST = "rosfield.com";
export const BASE_PATH = "/test";

/** The writer's clock in the tests: the turn's now (commit-s1-02.json), with a part of a second it drops. */
export const LINK_NOW = new Date("2026-10-19T14:05:06.789Z");

/** The link's issue and lapse at LINK_NOW: to the second, and 7 days later. */
export const ISSUED_AT = "2026-10-19T14:05:06Z";
export const EXPIRES_AT = "2026-10-26T14:05:06Z";

/** The time of the turn's last text (commit-s1-02.json's one text): the mobile's proof. */
export const LAST_TEXT_AT = "2026-10-19T14:05:00Z";

/** S1-10 as bundle v3 compiles it (T-1526): a plain step that gives id_checked and mobile and tells the owner. */
export function s1_10Step(): GraphStep {
  const step = flowGraphOf(flowAV3(), "A").step("S1-10");
  if (step === null) throw new Error("bundle v3 holds S1-10");
  return step;
}

/** A fill that writes the bytes 0 to 15 in turn (a made-up draw whose code a test can state). */
export const COUNTING_FILL: RandomFill = (array) => {
  for (let index = 0; index < array.length; index += 1) array[index] = index;
};

/** The code COUNTING_FILL gives: the 16 bytes 0 to 15 as hex. */
export const COUNTING_CODE = "000102030405060708090a0b0c0d0e0f";

/** A stage that writes each link down, as the face's HeldLinks takes it. */
export interface RecordingStage extends LinkStage {
  readonly staged: { readonly turnId: string; readonly outboxRowId: string; readonly link: string }[];
}

export function recordingStage(): RecordingStage {
  const staged: { turnId: string; outboxRowId: string; link: string }[] = [];
  return {
    staged,
    stage(turnId, outboxRowId, link) {
      staged.push({ turnId, outboxRowId, link });
    },
  };
}

/** The secure link's port over `stage` at staging's place, the test clock and `fill` (default: the Web Crypto one). */
export function linkDeps(stage: LinkStage, fill?: RandomFill): SecureLinkDeps {
  return {
    host: LINK_HOST,
    basePath: BASE_PATH,
    stage,
    now: () => LINK_NOW,
    ...(fill === undefined ? {} : { fill }),
  };
}

/** One read the double was asked for, with the repo it was handed where it takes one. */
export type MobileIdAsked =
  | { readonly read: "readPickedKinds"; readonly businessId: string | null; readonly personId: string }
  | { readonly read: "readTurnState"; readonly repo: unknown; readonly request: ReadTurnStateRequest };

/** What the double answers. */
export interface MobileIdGiven {
  /** Item 79's companies (default: Sam's company of Lee's Barbershop). */
  readonly companies?: readonly CompanyRead[];
  /** The turn's handle's kind (default phone). */
  readonly handleKind?: "phone" | "email";
  /** The handle's people (default: Sam alone). */
  readonly people?: readonly string[];
  /** The handle's phones row's number (default Sam's; null: none on file). */
  readonly phoneNumber?: string | null;
  /** The caller's accounts row (default: none on file). */
  readonly account?: AccountOnFile | null;
  /** readTurnState's answer in place of the double's own, for every ask. */
  readonly turnState?: SetupTurnStateOutcome;
}

export interface FakeMobileId {
  readonly k05: ListingK05Reads<WalkTestRepo>;
  /** Every read, in order. */
  readonly asked: MobileIdAsked[];
}

/** readTurnState's answer: the handle with no fact; the accounts row's three facts, or notFound naming it. */
function turnStateOf(request: ReadTurnStateRequest, given: MobileIdGiven): SetupTurnStateOutcome {
  const facts: FactValue[] = [];
  const account = given.account ?? null;
  for (const fact of request.facts) {
    if (fact.table !== "accounts" || account === null) {
      return { error: "notFound", table: fact.table, rowId: fact.rowId };
    }
    const values: Record<string, unknown> = {
      mobile: account.mobile,
      mobile_proven_at: account.mobileProvenAt,
      version: account.version,
    };
    facts.push({ ...fact, value: values[fact.column] ?? null, version: account.version });
  }
  const number = given.phoneNumber === undefined ? SAM_NUMBER : given.phoneNumber;
  return {
    result: "turnState",
    handleId: request.handleId,
    handle:
      given.handleKind === "email"
        ? { kind: "email", address: "sam@example.com" }
        : { kind: "phone", address: SAM_NUMBER },
    businessId: request.businessId,
    readAt: READ_AT,
    persons: (given.people ?? [SAM_PERSON]).map((personId) => ({ personId, language: "en", version: 1 })),
    roles: [],
    phone:
      number === null
        ? null
        : {
            number,
            stopped: false,
            stopAt: null,
            chatOpen: true,
            chatWay: "imessage",
            linqContactAddedAt: "2026-10-19T14:00:00Z",
            pollVotedAt: null,
            optoutLineDeliveredAt: "2026-10-19T14:00:00Z",
            version: 2,
          },
    openQuestions: [],
    bookings: [],
    pauses: [],
    consents: [],
    facts,
  };
}

/** The two K-05 reads as db/repo answers them, each written down and answered as a copy. */
export function fakeMobileIdK05(given: MobileIdGiven = {}): FakeMobileId {
  const asked: MobileIdAsked[] = [];
  return {
    asked,
    k05: {
      readPickedKinds(request) {
        asked.push({ read: "readPickedKinds", businessId: request.businessId, personId: request.personId });
        return Promise.resolve({
          result: "pickedKinds",
          businessId: request.businessId,
          personId: request.personId,
          readAt: READ_AT,
          picks: [],
          companies: structuredClone([...(given.companies ?? [samCompany()])]),
        });
      },
      readTurnState(repo, request) {
        asked.push({ read: "readTurnState", repo, request: structuredClone(request) });
        return Promise.resolve(structuredClone(given.turnState ?? turnStateOf(request, given)));
      },
    },
  };
}

export { SAM_HANDLE, SAM_PERSON };
