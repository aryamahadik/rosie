// What the turn face's tests expect of K-09 v1's build-frontier-s1-02.json (T-315; DL-319 ruling 2; DL-322 ruling 8: its
// unit proof reads this fixture as main has it, since T-1142's turn 1 fixture has not merged). Never imported by the
// Worker. No database here: the PostgreSQL side's own helpers are pg/test-support.ts.
//
// main's frontier gives the fixture's frontier only as far as its sources are built (frontier/assemble/registry.ts):
// the open questions' slot is built, so S1-02's three options and card come; the door S11-21 and the danger any-time row
// come from slots whose tasks have not landed, so each is named below with its task, never stood in for. The last 6
// messages are empty while no frozen call reads them (K-05 v1.2 open gap 20; DL-319 ruling 3).

import { s102Exchange, type FrontierExchange } from "../../frontier/assemble/test-support";

/** A choice of build-frontier-s1-02.json that main's frontier cannot give yet. */
export interface WaitingChoice {
  readonly choiceId: string;
  readonly kind: "door" | "anytime";
  readonly step: string;
  /** The frontier slot that gives it (frontier/assemble/registry.ts SLOT_NAMES), empty on main. */
  readonly slot: "hubsAndDoors" | "anyTime";
  /** The task that fills that slot (ops/plan/03-tasks.md), for which this choice waits. */
  readonly task: "T-293" | "T-294";
}

/** The fixture's choices main's frontier cannot give yet (T-315's round 1 report; DL-319): each waits for its task. */
export const WAITING: readonly WaitingChoice[] = [
  // The door "An unclear owner text or HELP": T-293, hubs by stage and door entries.
  { choiceId: "c-04", kind: "door", step: "S11-21", slot: "hubsAndDoors", task: "T-293" },
  // The any-time row "Danger or crisis": T-294, the any-time table's 21 rows.
  { choiceId: "c-05", kind: "anytime", step: "A3-22", slot: "anyTime", task: "T-294" },
];

/** The slots whose sources main has not built: the waiting choices', and the branch gates' (T-292), none for S1-02. */
export const SLOTS_NOT_BUILT = ["branchGates", "hubsAndDoors", "anyTime"] as const;

/**
 * build-frontier-s1-02.json's answer as far as main's frontier gives it: the fixture's own outcome, without the waiting
 * choices (the others keep their ids, which come in frontier order) and with no recent messages.
 */
export function asFarAsMain(exchange: FrontierExchange = s102Exchange()): Record<string, unknown> {
  const waiting = new Set(WAITING.map((each) => each.choiceId));
  const { context } = exchange.outcome;
  return {
    ...exchange.outcome,
    context: {
      ...context,
      choices: context.choices.filter((choice) => !waiting.has(String(choice.choiceId))),
      recentMessages: [],
    },
  };
}
