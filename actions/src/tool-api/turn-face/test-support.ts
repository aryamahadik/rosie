// What the turn face's tests expect of turn 1, Sam's first text: K-09 v1.5's build-frontier-s1-01.json (T-315 round 4,
// DL-346; ADR-013 sections 1 and 6). Never imported by the Worker. No database here: the PostgreSQL side's own helpers
// are pg/test-support.ts.
//
// main's frontier gives the fixture's frontier only as far as its sources are built (frontier/assemble/registry.ts).
// Turn 1's one choice, the sign-up door to S1-01 (K-02 v1.1 default 9), comes from the hubs-and-doors slot, which T-1147
// fills: it is named below with that task (WAITING), never stood in for. The expected answer is the fixture's frontier
// less the waiting choices; when none is left, the frontier has no choice to give, K-02's context.choices holds at least
// one (model.v1.schema.json line 899), and buildFrontier fails closed with FrontierError noChoices (DL-346 rulings 1 and
// 2; CQ-167's default). When T-1147 takes c-01 off WAITING, the same tests expect the fixture's whole frontier. The last
// 6 messages are empty while no frozen call reads them (K-05 v1.2 open gap 20).
//
// The fake repo's stored state is T-1148's seed for D-017 (db/seeds/skeleton.ts SKELETON_ROWS, imported read-only), as
// K-05 v1.2 readTurnState reads it: test owner 1, Sam, his handle at tp-01's number, no role, no open question, no
// booking and no phone row (K-05 v1.2 targets-first-text.json), under Lee's Barbershop. The PostgreSQL proof seeds the
// same rows with the seed itself. Values come only from the contracts' fixtures and the master's sample cast (rule 9).

import { SKELETON_ROWS, TEST_OWNER_1 } from "../../../../db/seeds/skeleton";
import { FRONTIER_SOURCES } from "../../frontier";
import { contractFixture, type FrontierExchange, type TurnSeed } from "../../frontier/assemble/test-support";
import type { Target } from "../../frontier/assemble/types";

/** Turn 1's frontier exchange: its request, its outcome, and the stored state the fixture gives (its `given`). */
export type TurnOneExchange = FrontierExchange & {
  given: { seeds: string[]; now: string };
  request: { now: string };
};

/** K-09 v1.5's build-frontier-s1-01.json, freshly parsed (a test may change its copy). */
export function s101Exchange(): TurnOneExchange {
  return contractFixture("tool-api/fixtures/build-frontier-s1-01.json") as TurnOneExchange;
}

/** A choice of build-frontier-s1-01.json that main's frontier cannot give yet. */
export interface WaitingChoice {
  readonly choiceId: string;
  readonly kind: "door";
  readonly door: "signUp";
  readonly step: string;
  /** The frontier slot that gives it (frontier/assemble/registry.ts SLOT_NAMES), empty on main. */
  readonly slot: "hubsAndDoors";
  /** The task that fills that slot with it (ops/cards), for which this choice waits. */
  readonly task: "T-1147";
}

/**
 * The fixture's choices main's frontier cannot give yet (T-315 round 3's report; DL-346): each waits for its task. None
 * since T-1147 wired T-293's hubs-and-doors source into its slot, which offers c-01, the sign-up door to S1-01.
 */
export const WAITING: readonly WaitingChoice[] = [];

/**
 * The frontier's slots main has not built (frontier/assemble/registry.ts), in their order: the frontier logs each on
 * every call (frontier_source_missing), so it fails closed on what is not built. The one place these tests read the
 * registry.
 */
export function slotsNotBuilt(): string[] {
  return FRONTIER_SOURCES.filter((slot) => slot.source === null).map((slot) => slot.name);
}

/** How the turn face ends as far as main's frontier gives the fixture's frontier: that answer, or no choice at all. */
export type AsFarAsMain =
  { readonly ends: "answer"; readonly answer: Record<string, unknown> } | { readonly ends: "noChoices" };

/**
 * build-frontier-s1-01.json's answer as far as main's frontier gives it: the fixture's own outcome without the waiting
 * choices (turn 1's frontier holds one choice, so no choice id moves) and with no recent messages; with no choice left,
 * the fault noChoices. `about` makes each choice the same call's under another business: its target that business.
 */
export function asFarAsMain(exchange: FrontierExchange = s101Exchange(), about?: Target): AsFarAsMain {
  const waiting = new Set(WAITING.map((each) => each.choiceId));
  const { context } = exchange.outcome;
  const choices = context.choices
    .filter((choice) => !waiting.has(String(choice.choiceId)))
    .map((choice) => (about === undefined ? choice : { ...choice, target: about }));
  if (choices.length === 0) return { ends: "noChoices" };
  return {
    ends: "answer",
    answer: { ...exchange.outcome, context: { ...context, choices, recentMessages: [] } },
  };
}

/** The one row of a table of T-1148's seed with this id. */
function seedRow<Row extends { readonly id: string }>(rows: readonly Row[], id: string): Row {
  const row = rows.find((each) => each.id === id);
  if (row === undefined) throw new Error(`T-1148's seed holds no row ${id}`);
  return row;
}

/** The version of a row written once (K-04 v1: every versioned table's version starts at 1). */
const WRITTEN_ONCE = 1;

/**
 * Turn 1's stored state for the frontier's fake K-05 v1.2 readTurnState: T-1148's rows (see the top), read at the
 * fixture's `now`. The fake holds each request and answer to K-05 v1.2's frozen schema.
 */
export function firstTextSeed(exchange: TurnOneExchange = s101Exchange()): TurnSeed {
  const business = seedRow(SKELETON_ROWS.businesses, TEST_OWNER_1.businessId);
  const person = seedRow(SKELETON_ROWS.persons, TEST_OWNER_1.personId);
  const handle = seedRow(SKELETON_ROWS.handles, TEST_OWNER_1.handleId);
  return {
    handleId: handle.id,
    handle: { kind: handle.kind, address: handle.address },
    persons: [{ personId: person.id, language: person.language, version: WRITTEN_ONCE }],
    roles: [],
    phone: null,
    openQuestions: [],
    rows: {
      businesses: { [business.id]: { ...business } },
      persons: { [person.id]: { ...person, version: WRITTEN_ONCE } },
    },
    readAt: exchange.request.now,
  };
}
