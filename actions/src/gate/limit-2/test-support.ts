// Doubles and scenarios for limit 2's tests (T-300). Never imported by the Worker. The doubles stand in for limit 2's
// ports (the walk that says what a part proposes, and the read of K-26's rules) and for limits 1 and 3 to 6, never for
// limit 2 or the evaluator. Values come only from the contracts' fixtures: K-09 v1's gate exchanges (Alex's "2, tonight at
// 9pm" to A7-17; Sam's S1-02 answer), K-26 v1's rules rows (the tap list Sam kept, the note-only rule, the refused unknown
// kind), and rows made in their form with made-up values where no fixture holds the rule (actions/src/rules/evaluator
// test-support; rule 9).

import type { Proposal, RuleRow } from "../../rules/evaluator";
import { NOW, TONIGHT_9PM, proposalOf } from "../../rules/evaluator/test-support";
import type { GatePart, GateTurn, Limit, LimitRegistry } from "../framework";
import { scriptedLimits, type LimitCall, type PartScript, type Script } from "../framework/test-support";
import {
  createLimit2,
  type OwnerRules,
  type OwnerRulesLimit,
  type PartProposal,
  type Proposals,
} from "./index";

/** One read of the business's rules, as the double writes it down. */
export interface RulesAsk {
  readonly businessId: string;
  readonly at: string;
}

/** The rules read over fixed rows: each ask written down, the repo it was made on too. */
export function rulesFrom(
  rows: readonly RuleRow[],
  asked: RulesAsk[] = [],
  repos: unknown[] = [],
): (repo: unknown) => OwnerRules {
  return (repo) => {
    repos.push(repo);
    return {
      rulesOf(businessId, at) {
        asked.push({ businessId, at });
        return Promise.resolve(rows.map((row) => ({ ...row })));
      },
    };
  };
}

/** The walk as a double: each part it is asked about written down, answered by `answer`. */
export function walkOf(
  answer: (part: GatePart, turn: GateTurn) => PartProposal,
  asked: number[] = [],
): Proposals {
  return {
    proposalOf(part, turn) {
      asked.push(part.index);
      return Promise.resolve(answer(part, turn));
    },
  };
}

/** A walk that gives every part the same proposal. */
export function proposing(proposal: Proposal, asked: number[] = []): Proposals {
  return walkOf(() => ({ kind: "proposal", proposal }), asked);
}

export interface World {
  /** The business's K-26 rules rows; default none. */
  readonly rows?: readonly RuleRow[];
  /** The walk; default WALK_NOT_BUILT (the shipped one). */
  readonly walk?: Proposals;
  /** Where the rules reads are written down. */
  readonly rulesAsked?: RulesAsk[];
  /** Where the repos the rules read was made on are written down. */
  readonly repos?: unknown[];
}

/** Limit 2 itself over doubles of its ports. */
export function limitIn(world: World = {}): OwnerRulesLimit {
  return createLimit2({
    rules: rulesFrom(world.rows ?? [], world.rulesAsked ?? [], world.repos ?? []),
    ...(world.walk === undefined ? {} : { proposals: world.walk }),
  });
}

/**
 * The walk after Alex's "2 Another time" with "tonight at 9pm" (K-09 commit-limit-2-owner-rule.json): his Nov 14 visit
 * at Lee's Barbershop moves to Fri Oct 23, 9:00pm in the barbershop's zone; a move sets no price and makes no new booking.
 */
export const TONIGHT_AT_9: Proposal = proposalOf({ rulesAt: NOW, madeAt: NOW, visitAt: { ...TONIGHT_9PM } });

/** Limits 1 and 3 to 6 as the gate framework's scripted doubles, with `limit` in slot 2 (each call written down). */
export function registryWith(limit: Limit<2>, script: Script = {}, calls: LimitCall[] = []): LimitRegistry {
  const [one, , three, four, five, six] = scriptedLimits(script, calls);
  const two: Limit<2> = {
    limit: 2,
    check(part, turn) {
      calls.push({ limit: 2, part: part.index });
      return limit.check(part, turn);
    },
  };
  return [one, two, three, four, five, six];
}

/** A K-09 gate fixture's script without limit 2's verdict: the real limit 2 gives its own. */
export function withoutLimit2(script: Script): Script {
  const out: Record<number, PartScript> = {};
  for (const [part, verdicts] of Object.entries(script)) {
    if (verdicts === undefined) continue;
    const rest: PartScript = { ...verdicts };
    Reflect.deleteProperty(rest, 2);
    out[Number(part)] = rest;
  }
  return out;
}

/** A repo that writes down every touch, as a call's transaction would see a read or a write. */
export function watchedRepo(touched: string[]): object {
  return new Proxy(
    {},
    {
      get(_target, key) {
        touched.push(String(key));
        return undefined;
      },
      set(_target, key) {
        touched.push(String(key));
        return false;
      },
    },
  );
}
