// Test sources for the home registry, for the tests only.
//
// Both flow graphs come from fixture set v1's master flows (fixtures/master: master-A.json and master-B.json), compiled
// by the merged bundle emitter (T-149, compiler/src/emit buildBundle) with its record engine (T-137: record.homes and the
// named slots) and its step cards (T-144); no trade is given, so the bundle holds the master's own two flows. Nothing
// here is invented (rule 9): the steps, homes and words are the master's own.
//
// The homes' own modules are T-587 to T-596. Two stand-ins take the place of the money and contact modules here, each
// ruling on one point and on the words of its home's own line, quoted below and checked against the compiled home step:
// they show the registry's work (the home wins, the difference is logged), never a home's rules.

import { buildBundle } from "../../../../compiler/src/emit";
import type { HomeModule, StepClaim } from "./registry";

type Obj = Record<string, unknown>;

/** The bundle id the emitter is given (a bundle id is T-150's; emit.test.ts passes the same). */
export const GIVEN_ID = { hash: "ab".repeat(32), build: 7 };
export const BUILT_AT = "2026-11-08T00:00:00Z";

/** The ten homes as T-586's card and K-01 v1 list them (`homes`: master-A.json and master-B.json record.homes). */
export const CARD_HOMES = {
  money: "S13-55",
  contact: "S13-19",
  proof: "S13-45",
  stop: "S13-32",
  clock: "S13-35",
  who: "S13-31",
  safety: "S13-10",
  change: "S13-56",
  record: "S13-57",
  two: "A9-21",
};

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object at a path of keys, or a thrown error naming the path. */
export function objAt(value: unknown, path: readonly string[]): Obj {
  let here: unknown = value;
  for (const key of path) here = isObj(here) ? here[key] : undefined;
  if (!isObj(here)) throw new Error(`no object at ${path.join(".")}`);
  return here;
}

export interface EmittedFlows {
  readonly A: Obj;
  readonly B: Obj;
}

/** Both flow graphs from the emitter's output (K-01 v1 flowGraph, the bundle's .../flow/A and .../flow/B values). */
export async function emittedFlows(): Promise<EmittedFlows> {
  const built = await buildBundle({ trades: [], bundleId: GIVEN_ID, builtAt: BUILT_AT });
  const flows: Obj = built.bundle.flows;
  return { A: objAt(flows, ["A"]), B: objAt(flows, ["B"]) };
}

/** What the stand-ins' rules read. */
export interface HomeContext {
  /** A signed schedule keeps part of the money already taken (S13-55). */
  readonly signedSchedule: boolean;
}

/** S13-55's line the money stand-in rules by, word for word (master-A.json and master-B.json S13-55 `more`). */
export const S13_55_SILENCE =
  "Rosie NEVER makes a new charge on silence. Silence: no fee, unless a signed schedule keeps part.";

/** Stands in for T-593's money module: its one point, a charge on silence, is none, or a signed schedule's share. */
export function moneyStandIn(): HomeModule<HomeContext> {
  return {
    home: "money",
    points: ["chargeOnSilence"],
    rule: (_point, context) => (context.signedSchedule ? "keepSignedShare" : "none"),
  };
}

/** S13-19's line the contact stand-in rules by, word for word (master-A.json and master-B.json S13-19 `more`). */
export const S13_19_REPLY_CLOCK =
  "A reply clock starts only once they were reached their way. No fee follows silence to a message they couldn't get.";

/** Stands in for T-588's contact module: its one point, when a reply clock starts, is once they were reached. */
export function contactStandIn(): HomeModule<HomeContext> {
  return { home: "contact", points: ["replyClock"], rule: () => "onceReached" };
}

/** A7-11's own words on the fee, in its message to the owner (master-A.json A7-11 `say`). */
export const A7_11_OWN_WORDS = "No fee until you do.";
/** The fixture's words in their place: what S13-55 forbids, a new charge on silence. */
export const A7_11_CONTRADICTING = "No answer in 24 hours: the late-cancel fee is charged to the saved card.";

/** The claim those words make, as labels: on silence, the money home's point chargeOnSilence is a charge. */
export const A7_11_CLAIMS: readonly StepClaim[] = [
  { home: "money", point: "chargeOnSilence", value: "charge" },
];

/**
 * Flow A with A7-11 as the emitter compiled it (it follows money, S13-55, and contact, S13-19), its owner message's own
 * fee words turned against S13-55. Thrown when A7-11's owner message does not hold its own words.
 */
export function contradictingA711(flowA: Obj): Obj {
  const flow = structuredClone(flowA);
  const step = objAt(flow, ["steps", "A7-11"]);
  const say: unknown = step.say;
  const messages: readonly unknown[] = Array.isArray(say) ? say : [];
  let turned = 0;
  for (const message of messages) {
    if (!isObj(message) || message.to !== "owner") continue;
    for (const key of ["text", "plainText"]) {
      const words = message[key];
      if (typeof words !== "string" || !words.includes(A7_11_OWN_WORDS)) continue;
      message[key] = words.replace(A7_11_OWN_WORDS, A7_11_CONTRADICTING);
      turned += 1;
    }
  }
  if (turned === 0) throw new Error(`A7-11's owner message does not say "${A7_11_OWN_WORDS}"`);
  return flow;
}
