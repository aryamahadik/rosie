// The safety service's telling port, built (T-319; C-104; T-318's SafetyTelling in ../safety/ports.ts; arch 06 line 329;
// K-09 v1.10 defaults 174 to 176 and open gaps 146 and 147; K-05 v1.16 item 70 and open gap 78): who a safety record
// tells, through a hand-off to the owner and a page to Rosie's team, written in the record's own commit.
//
//   - Crisis words: the owner and Rosie's team at once, through the hand-off's alert and the team's page opened in the
//     same commit, one row to each member (j3-safety-arrival-crisis-rows.json). An emergency or a threat: the owner at
//     once through the alert, then after 5 minutes with no answer whoever they named and Rosie's team, paged every 5
//     minutes until acknowledged, by the hand-off's escalation clock row (hand-off.ts).
//   - The rows it writes are the alert's and the page's, in commit order (the hand-off's alert, then each member's page
//     row), each with its recipient's handle and send class safety (K-09 v1.10 defaults 174, 176), written under the
//     record's business (K-05 open gap 78), so K-05 v1.16's readOutboxRowWritten sees them under that business when a
//     repeat names them.
//   - A repeat writes nothing and names the first record's hand-off and page (`told`) and their rows (`rowIds`): the ids
//     are the first record's, made from the outcome's id, never anew, and each page row is kept only when it is written
//     (page.ts default 10). T-1374 reads each through K-05 v1.16 item 70 for its stored recipient and class.
//
// Binding it in place of NOT_TOLD_YET (the safety service's deps and the commit core's CoreSafetyDeps.telling) is the
// wiring's, outside this card's paths.
//
// Defaults used (for ops/QUESTIONS.md):
//  23. One hand-off per safety read, of its most urgent outcome that tells: crisis words, else an emergency, else a
//      threat (rules.ts TELLS, in K-02's order); a crisis-words page opened at once repeats every 5 minutes when the read
//      also holds an emergency or a threat, whose page would, and is paged once otherwise (K-09 v1 pageTeam.repeating:
//      "an emergency or a threat"; K-36 open gap "Which pages repeat").
//  24. A record with no turn (a page's or an agent's free text) tells by a clock row due at once on each reader's handle
//      (K-09 v1.10 default 178; v1.4 default 112), whose clock turn is not built: it answers notBuilt, as NOT_TOLD_YET
//      did, and nothing is written (fail closed).
//  25. The hand-off's summary is the safety read's id and its outcome's name, in plain words with no private value
//      (K-36 hand_offs.summary); the owner's own alert words are the bundle's, written into the alert's row after the
//      commit like every row's.

import { NotBuiltError } from "../../tool-api";
import type { SafetyOutcome, SafetyTelling, SafetyTold, TellPlan, TellRequest } from "../safety";
import { PagingRefusedError } from "./errors";
import { handOffKeyOf, handOffPageKey, openHandOff } from "./hand-off";
import { rowsOfPage, type PagingPorts } from "./page";
import type { HandOffKind } from "./ports";
import { tellWritesOf } from "./writes";

/** What the telling port answers: who is told and what the commit writes, and the rows it writes or names. */
export interface PagingTellPlan extends TellPlan {
  /**
   * Every outbox row the telling writes (a first record) or names (a repeat), in commit order: the hand-off's alert,
   * then the team page's rows. On a repeat each is the first record's, kept only when written.
   */
  readonly rowIds: readonly string[];
}

/** The telling port, built: T-318's SafetyTelling, whose plans also name their rows. */
export interface PagingTelling extends SafetyTelling {
  tell(request: TellRequest): Promise<PagingTellPlan>;
}

/** The hand-off a record's outcomes call for (default 23), or null when none tells. */
export function tellingKindOf(outcomes: readonly SafetyOutcome[]): Exclude<HandOffKind, "other"> | null {
  if (outcomes.includes("Crisis words")) return "crisis_words";
  if (outcomes.includes("An emergency")) return "emergency";
  if (outcomes.includes("A threat to staff or others")) return "threat";
  return null;
}

/** The outcome's name in a hand-off's summary (default 25). */
const OUTCOME_WORDS: Readonly<Record<Exclude<HandOffKind, "other">, string>> = {
  crisis_words: "crisis words",
  emergency: "an emergency",
  threat: "a threat to staff or others",
};

/** The telling port over the paging service's reads (T-318's SafetyTelling shape). Reads only. */
export function createPagingTelling(ports: PagingPorts): PagingTelling {
  return {
    async tell(request) {
      const kind = tellingKindOf(request.outcomes);
      const why = { step: "A3-22", choice: null };
      const none = (told: SafetyTold[], rowIds: string[]): PagingTellPlan => ({
        told,
        rowIds,
        writes: {
          why,
          versionsRead: [],
          state: [],
          stateEvents: [],
          asks: [],
          messages: [],
          clocks: [],
        },
      });
      if (kind === null) return none([], []);
      if (request.businessId === null) throw new PagingRefusedError("tellNeedsBusiness", [request.outcomeId]);
      // Keyed by the outcome (hand-off.ts default 14), whatever the request: a repeat names the first record's rows.
      const handOffId = await ports.ids.rowId("handOff", handOffKeyOf(request.outcomeId, request.eventId));
      const pageId = await ports.ids.rowId("page", handOffPageKey(handOffId));

      if (request.repeated) {
        // The first record's hand-off and page, as stored, with the rows they wrote.
        const handOff = await ports.reader.handOff(handOffId);
        if (handOff === null) return none([], []);
        const told: SafetyTold[] = [{ who: "owner", via: "handOff", id: handOff.id }];
        const rowIds = handOff.alertOutboxRowId === null ? [] : [handOff.alertOutboxRowId];
        const page = handOff.kind === "crisis_words" ? await ports.reader.page(pageId) : null;
        if (page !== null) {
          told.push({ who: "team", via: "teamPage", id: page.id });
          rowIds.push(...(await rowsOfPage(page, 1, ports)));
        }
        return none(told, rowIds);
      }
      if (request.turnId === null) throw new NotBuiltError("handOff");

      const opened = await openHandOff(
        {
          handOffId,
          businessId: request.businessId,
          kind,
          safetyOutcomeId: request.outcomeId,
          turnId: request.turnId,
          bookingId: request.bookingId,
          aboutPersonId: request.personId,
          summary: `A safety read (${request.outcomeId}) found ${OUTCOME_WORDS[kind]}.`,
          now: request.now,
          pageRepeats:
            request.outcomes.includes("An emergency") ||
            request.outcomes.includes("A threat to staff or others"),
        },
        ports,
      );
      const told: SafetyTold[] = [{ who: "owner", via: "handOff", id: handOffId }];
      if (opened.teamPageId !== null) told.push({ who: "team", via: "teamPage", id: opened.teamPageId });
      return {
        told,
        rowIds: opened.rows.map((row) => row.id),
        writes: { ...tellWritesOf(opened.writes), why },
      };
    },
  };
}
