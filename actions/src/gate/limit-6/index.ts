// Limit 6, Values (C-086, T-304; arch 06 line 309): each value re-parses from its source words, or from the read-back the
// owner said yes to for a photo; dates resolve from the text's send time in the visit's zone. It replaces T-298's
// fail-closed stub in this slot of the gate's registry (../limits.ts). The rule is re-parse.ts, the reader it re-parses
// with is actions/src/values, and what it reads is facts.ts. A value that fails its words is a fail naming its fields,
// which the gate answers as valueFailsWords until decide's one re-read ran (framework/gate.ts).
//
// `limit6` reads the business's zone through the call's database transaction (the Tool API's scoped repo, K-04 v1's
// business head), and no visit place or photo reading yet (so a flow B visit with no zone of its own resolves in the
// business's zone, and no value passes as a photo's, until T-439/T-440 and C-120 land). createLimit6 takes other ports,
// as the tests do.

import type { GatePart, GateTurn, Limit, LimitVerdict } from "../framework";
import {
  NO_PHOTO_READINGS,
  NO_PLACE_KNOWN,
  businessZonesOf,
  databaseOf,
  type BusinessZones,
  type PhotoReadings,
  type VisitPlaces,
} from "./facts";
import { decideValues, type ValuesDecision } from "./re-parse";

export interface Limit6Deps {
  /** The business head's zone on the call's repo. Default: the data-access call on the call's transaction. */
  readonly businessZones?: (repo: unknown) => BusinessZones;
  /** Where a visit happens (CQ-08; S13-03). Default: NO_PLACE_KNOWN. */
  readonly places?: VisitPlaces;
  /** What a value read from a photo was read back as (C-120). Default: NO_PHOTO_READINGS. */
  readonly photos?: PhotoReadings;
}

/** Limit 6 in the gate's registry, with the full decision the commit's outcome writer reads. */
export interface ValuesLimit extends Limit<6> {
  /** The part's decision: pass, notChecked, or the failure naming each field and why. */
  decide(part: GatePart, turn: GateTurn): Promise<ValuesDecision>;
}

/** The limit's K-09 verdict for the gate from its decision. */
export function verdictOf(decision: ValuesDecision): LimitVerdict<6> {
  switch (decision.result) {
    case "pass":
      return { result: "pass" };
    case "notChecked":
      return { result: "notChecked" };
    case "fail":
      return { result: "fail", outcome: { ...decision.outcome }, fields: [...decision.fields] };
  }
}

/** Made once, when first asked for. */
function once<T>(make: () => T): () => T {
  let made: { readonly value: T } | null = null;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

export function createLimit6(deps: Limit6Deps = {}): ValuesLimit {
  const zonesOf = deps.businessZones ?? ((repo: unknown) => businessZonesOf(databaseOf(repo)));
  const places = deps.places ?? NO_PLACE_KNOWN;
  const photos = deps.photos ?? NO_PHOTO_READINGS;
  const decide = (part: GatePart, turn: GateTurn): Promise<ValuesDecision> =>
    decideValues(part, turn, { businessZones: once(() => zonesOf(turn.repo)), places, photos });
  return {
    limit: 6,
    decide,
    async check(part, turn) {
      return verdictOf(await decide(part, turn));
    },
  };
}

/** Limit 6 as the gate runs it (../limits.ts). */
export const limit6: ValuesLimit = createLimit6();

export {
  NO_PHOTO_READINGS,
  NO_PLACE_KNOWN,
  businessZonesOf,
  databaseOf,
  type BusinessZones,
  type FieldRef,
  type PhotoReadBack,
  type PhotoReadings,
  type ValueSource,
  type VisitPlace,
  type VisitPlaces,
  type VisitRef,
} from "./facts";
export {
  ASKS_BEFORE_NOTHING_CHANGES,
  askCountOf,
  decideValues,
  flowOf,
  nothingChangedOutcome,
  oneQuestionOutcome,
  visitZonesOf,
  type FieldFault,
  type Limit6Outcome,
  type ValueFault,
  type ValuesDecision,
  type ValuesPorts,
  type VisitZones,
  type ZoneFrom,
} from "./re-parse";
