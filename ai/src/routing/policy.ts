// The routing policy a bundle ships (K-01 v1 `manifest.policy`; T-363). The policy is data: which model reads first and
// which checks on low stakes and on high stakes, and which model makes the turn's one re-read. Q-26's switch (Haiku or
// Sonnet first on high stakes, J-21) is a different `high.first` in a bundle's manifest, never a change to this code.
//
// The router takes a policy only as K-01 v1 writes it: exactly low, high and reread; each pair exactly first and second;
// every model one of the bundle's two roles, haiku or sonnet. Anything else is refused whole, every problem named,
// before a turn is routed: a policy naming another model can never route a call to it.

import { RoutingPolicyError } from "./errors";
import { MODEL_ROLES, STAKES, type ModelRole, type ReadPair, type RoutingPolicy, type Stakes } from "./types";

const POLICY_FIELDS: readonly string[] = [...STAKES, "reread"];
const PAIR_FIELDS = ["first", "second"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A model role of K-01 v1: haiku or sonnet, exactly. */
export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (MODEL_ROLES as readonly string[]).includes(value);
}

/** A value as a problem line shows it: a policy is configuration, so its values may be named. */
const shown = (value: unknown): string => (value === undefined ? "missing" : JSON.stringify(value));

/** Every way `value` is not a K-01 v1 routing policy, one line each; empty when it is one. */
export function policyProblems(value: unknown): string[] {
  if (!isRecord(value)) return [`policy is ${shown(value)}, not an object`];
  const problems: string[] = [];
  for (const field of Object.keys(value)) {
    if (!POLICY_FIELDS.includes(field)) problems.push(`policy.${field} is not a field of K-01 v1's policy`);
  }
  for (const stakes of STAKES) {
    const pair = value[stakes];
    if (!isRecord(pair)) {
      problems.push(`policy.${stakes} is ${shown(pair)}, not a read pair`);
      continue;
    }
    for (const field of Object.keys(pair)) {
      if (!(PAIR_FIELDS as readonly string[]).includes(field))
        problems.push(`policy.${stakes}.${field} is not a field of a read pair`);
    }
    for (const field of PAIR_FIELDS) {
      if (!isModelRole(pair[field]))
        problems.push(`policy.${stakes}.${field} is ${shown(pair[field])}, not haiku or sonnet`);
    }
  }
  if (!isModelRole(value.reread))
    problems.push(`policy.reread is ${shown(value.reread)}, not haiku or sonnet`);
  return problems;
}

/**
 * The bundle's routing policy, checked and copied: a frozen copy, so a manifest changed after set-up changes no route.
 * Throws RoutingPolicyError, naming every problem, for a policy that is not K-01 v1's.
 */
export function readPolicy(value: unknown): RoutingPolicy {
  const problems = policyProblems(value);
  if (problems.length > 0 || !isRecord(value))
    throw new RoutingPolicyError(`the bundle's routing policy is not K-01 v1's: ${problems.join("; ")}`);
  const pair = (stakes: Stakes): ReadPair => {
    const given = value[stakes] as ReadPair;
    return Object.freeze({ first: given.first, second: given.second });
  };
  return Object.freeze({ low: pair("low"), high: pair("high"), reread: value.reread as ModelRole });
}
