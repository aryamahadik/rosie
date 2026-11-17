// Journeys 1 and 2's Tool API calls (T-630; C-074; DL-867): the calls K-09 v1 holds for the sign-up journeys (README
// "Journeys 1 and 2: the setup calls": matchKinds, lookupListing, saveSetupStep and readSetup), each answered by the folder
// of the call task that builds it, so each of those tasks (T-633 to T-664) touches only its own folder and they run side
// by side (build prompt 3.5 (c)). This file holds the registry both journeys use and journey 1's folders (T-633 to
// T-656); ../journey-2 holds journey 2's.
//
// The four are K-09 v1 calls, so the base answers them through its own handlers (tool-api.ts Handlers), never through
// its lane door, which refuses a v1 call's name (T-1022; DL-728). The registry makes those four handlers from the folders'
// entries (setupHandlers), and withSetupCalls puts them in a base's handlers, leaving every other call's handler exactly
// as it was given:
//   - matchKinds, lookupListing and readSetup: one entry each, whose handler is the call's;
//   - saveSetupStep: one entry per step of K-09 v1's request variants (`step.step`), so its handler runs the entry of the
//     step the request saves (the base has held the request to `$defs/saveSetupStep.request` before it runs).
// Registration is refused (SetupRegistrationError) for an entry that names a call outside the four, so no entry can answer
// a call of the turn face or the shared core; a step that is not one of saveSetupStep's variants; a call or a step that
// is registered already; and a folder its lane lists twice. A call or a step with no entry answers notBuilt.
//
// Until its task builds it, each folder's handler rejects with NotBuiltError before it reads anything, so the base answers
// notBuilt and rolls the call's transaction back: nothing is read or written. A folder whose steps have no journey 1 or 2
// call of their own registers no entry (plan, control, summary, start; journey 2's join-links).
//
// The walking skeleton's path is left as it is (DL-867 item 2). S1-01's thread and S1-02's question are written by the
// turn face's gateAndCommit (T-315, T-1141: turn-face.ts callHandlers), with the frontier's buildFrontier and the turn's
// composeInput and finalizeMessage, and none of those is a setup call; at main e1c4800 neither the turn face nor the
// frontier registers any of the four (each is notBuiltHandlers' stub there), so no entry here stands in front of a call
// the skeleton serves. In a turn a step's write is the effect of the choice decide picked, inside gateAndCommit (K-09 v1
// `saveSetupStep.request`), and S2-05's ready text rides as the core action saveSetupStepInTurn, which the commit runs:
// neither reaches this registry.

import type { CallName, RequestOf } from "../calls";
import { NotBuiltError } from "../errors";
import { JOURNEY_2_LANE } from "../journey-2";
import type { Handler, Handlers } from "../tool-api";
import * as afterLive from "./after-live";
import * as agreements from "./agreements";
import * as calendar from "./calendar";
import * as companies from "./companies";
import * as control from "./control";
import * as feeConsent from "./fee-consent";
import * as goLive from "./go-live";
import * as goLivePage from "./go-live-page";
import * as kinds from "./kinds";
import * as licenses from "./licenses";
import * as listing from "./listing";
import * as mobileId from "./mobile-id";
import * as moneyCard from "./money-card";
import * as places from "./places";
import * as plan from "./plan";
import * as plugIns from "./plug-ins";
import * as profile from "./profile";
import * as rules from "./rules";
import * as services from "./services";
import * as spaces from "./spaces";
import * as start from "./start";
import * as stripeConnect from "./stripe-connect";
import * as summary from "./summary";
import * as teamSize from "./team-size";
import * as timetable from "./timetable";

/** K-09 v1's journey 1 and 2 calls (README "Journeys 1 and 2: the setup calls"), in the order of v1's `$defs/callName`. */
export const SETUP_CALLS = [
  "matchKinds",
  "lookupListing",
  "saveSetupStep",
  "readSetup",
] as const satisfies readonly CallName[];

/** One of K-09 v1's journey 1 and 2 calls. */
export type SetupCall = (typeof SETUP_CALLS)[number];

/** A step K-09 v1's saveSetupStep saves: one of its request's variants, by `step.step`. */
export type SetupStepId = RequestOf<"saveSetupStep">["step"]["step"];

/** Every step saveSetupStep saves, in the order of K-09 v1's request variants (a test holds this list to the schema). */
export const SETUP_STEPS = [
  "S1-02",
  "S1-03",
  "S1-11",
  "S1-04",
  "S1-09",
  "S1-10",
  "S1-72",
  "S1-23",
  "S1-61",
  "S1-12",
  "S1-43",
  "S1-13",
  "S1-81",
  "S1-83",
  "S1-21",
  "S1-84",
  "S1-24",
  "S1-78",
  "S1-25",
  "S1-27",
  "S1-29",
  "S1-32",
  "S1-35",
  "S2-02",
  "S2-05",
  "S2-06",
  "S2-11",
  "S2-29",
  "S2-15",
  "S2-27",
  "S2-31",
  "S2-24",
] as const satisfies readonly SetupStepId[];

/** One entry of the registry: a setup call (for saveSetupStep, one of its steps) and the handler its folder gives it. */
export type SetupEntry<Repo> =
  | { readonly call: "matchKinds"; readonly handler: Handler<"matchKinds", Repo> }
  | { readonly call: "lookupListing"; readonly handler: Handler<"lookupListing", Repo> }
  | {
      readonly call: "saveSetupStep";
      readonly step: SetupStepId;
      readonly handler: Handler<"saveSetupStep", Repo>;
    }
  | { readonly call: "readSetup"; readonly handler: Handler<"readSetup", Repo> };

/** One call task's folder: its name, as the task's May touch names it, and the entries it answers. */
export interface SetupFolder<Repo> {
  readonly folder: string;
  /** None for a folder whose steps have no journey 1 or 2 call of their own. */
  readonly entries: readonly SetupEntry<Repo>[];
}

/** A journey's folders: the lane's name (its folder's: journey-1) and its call tasks' folders. */
export interface SetupLane<Repo> {
  readonly lane: string;
  readonly folders: readonly SetupFolder<Repo>[];
}

/** Why an entry, or a folder, is refused at registration (SetupRegistrationError). */
export type SetupRefused = "call" | "step" | "registered" | "folder";

/**
 * An entry or a folder refused at registration: setupHandlers throws it, so no handler is made from those lanes. It names
 * the lane, the folder, the entry (its call, and its step for saveSetupStep) and why, with what the check found.
 */
export class SetupRegistrationError extends Error {
  override name = "SetupRegistrationError";
  readonly lane: string;
  readonly folder: string;
  /** The entry's call, with its step for saveSetupStep ("saveSetupStep S1-02"); "(folder)" for a folder refused. */
  readonly entry: string;
  readonly why: SetupRefused;

  constructor(lane: string, folder: string, entry: string, why: SetupRefused, found: string) {
    super(`${lane}/${folder} cannot register ${entry} (${why}): ${found}`);
    this.lane = lane;
    this.folder = folder;
    this.entry = entry;
    this.why = why;
  }
}

/** Journey 1's folders, in the order of their tasks (T-633 to T-656). */
export const JOURNEY_1_LANE: SetupLane<unknown> = {
  lane: "journey-1",
  folders: [
    kinds.FOLDER,
    plugIns.FOLDER,
    companies.FOLDER,
    plan.FOLDER,
    listing.FOLDER,
    mobileId.FOLDER,
    control.FOLDER,
    agreements.FOLDER,
    licenses.FOLDER,
    services.FOLDER,
    places.FOLDER,
    moneyCard.FOLDER,
    spaces.FOLDER,
    timetable.FOLDER,
    rules.FOLDER,
    profile.FOLDER,
    calendar.FOLDER,
    teamSize.FOLDER,
    feeConsent.FOLDER,
    stripeConnect.FOLDER,
    goLivePage.FOLDER,
    goLive.FOLDER,
    afterLive.FOLDER,
    summary.FOLDER,
    start.FOLDER,
  ],
};

/** Journeys 1 and 2's lanes: the registry's default. */
export const JOURNEY_1_2_LANES: readonly SetupLane<unknown>[] = [JOURNEY_1_LANE, JOURNEY_2_LANE];

const SETUP_CALL_SET: ReadonlySet<string> = new Set(SETUP_CALLS);
const SETUP_STEP_SET: ReadonlySet<string> = new Set(SETUP_STEPS);

/** The entries the lanes register, by call (and saveSetupStep's by step). */
interface Registered<Repo> {
  matchKinds?: Handler<"matchKinds", Repo>;
  lookupListing?: Handler<"lookupListing", Repo>;
  readSetup?: Handler<"readSetup", Repo>;
  readonly steps: Map<string, Handler<"saveSetupStep", Repo>>;
}

/** An entry's name in a refusal: its call, with its step for saveSetupStep. */
function entryName(entry: { readonly call: string; readonly step?: unknown }): string {
  return entry.call === "saveSetupStep" ? `saveSetupStep ${String(entry.step)}` : entry.call;
}

/** Registers each lane's entries, each once (see the top of this file); a refused one throws SetupRegistrationError. */
function register<Repo>(lanes: readonly SetupLane<Repo>[]): Registered<Repo> {
  const registered: Registered<Repo> = { steps: new Map() };
  const where = new Map<string, string>();
  const listed = new Set<string>();
  for (const { lane, folders } of lanes) {
    for (const { folder, entries } of folders) {
      if (listed.has(`${lane}/${folder}`)) {
        throw new SetupRegistrationError(lane, folder, "(folder)", "folder", "its lane lists it already");
      }
      listed.add(`${lane}/${folder}`);
      for (const entry of entries) {
        const name = entryName(entry);
        const refused = (why: SetupRefused, found: string): SetupRegistrationError =>
          new SetupRegistrationError(lane, folder, name, why, found);
        if (!SETUP_CALL_SET.has(entry.call)) {
          throw refused(
            "call",
            "not a journey 1 or 2 call of K-09 v1, which the base's other handlers answer",
          );
        }
        if (entry.call === "saveSetupStep" && !SETUP_STEP_SET.has(entry.step)) {
          throw refused("step", "not a step K-09 v1's saveSetupStep saves");
        }
        const first = where.get(name);
        if (first !== undefined) throw refused("registered", `${first} registered it already`);
        where.set(name, `${lane}/${folder}`);
        switch (entry.call) {
          case "matchKinds":
            registered.matchKinds = entry.handler;
            break;
          case "lookupListing":
            registered.lookupListing = entry.handler;
            break;
          case "readSetup":
            registered.readSetup = entry.handler;
            break;
          case "saveSetupStep":
            registered.steps.set(entry.step, entry.handler);
            break;
        }
      }
    }
  }
  return registered;
}

/** A setup call with no entry: it answers notBuilt, before it reads anything. */
function notBuilt(call: SetupCall): () => Promise<never> {
  return () => Promise.reject(new NotBuiltError(call));
}

/**
 * The four setup calls' handlers, made from the lanes' entries (default: journeys 1 and 2). saveSetupStep's runs the entry
 * of the step its request saves. A refused entry or folder throws SetupRegistrationError, so no handler is made.
 */
export function setupHandlers<Repo>(
  lanes: readonly SetupLane<Repo>[] = JOURNEY_1_2_LANES,
): Pick<Handlers<Repo>, SetupCall> {
  const registered = register(lanes);
  const { steps } = registered;
  return {
    matchKinds: registered.matchKinds ?? notBuilt("matchKinds"),
    lookupListing: registered.lookupListing ?? notBuilt("lookupListing"),
    saveSetupStep: (request, context) => {
      const handler = steps.get(request.step.step);
      return handler === undefined
        ? Promise.reject(new NotBuiltError("saveSetupStep"))
        : handler(request, context);
    },
    readSetup: registered.readSetup ?? notBuilt("readSetup"),
  };
}

/**
 * A base's handlers with the four setup calls answered by the registry (default lanes: journeys 1 and 2) and every other
 * call's handler exactly as given (the turn face's and the shared core's among them).
 */
export function withSetupCalls<Repo>(
  handlers: Handlers<Repo>,
  lanes: readonly SetupLane<Repo>[] = JOURNEY_1_2_LANES,
): Handlers<Repo> {
  return { ...handlers, ...setupHandlers(lanes) };
}
