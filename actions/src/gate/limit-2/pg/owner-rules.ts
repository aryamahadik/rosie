// Limit 2's owner rules on PostgreSQL (T-1429; C-082; DL-911): OwnerRules.rulesOf (../facts.ts) bound to K-05 v1.18's
// readTermsSources (item 76; T-1427, T-1428: db/repo/catalog-reads.ts), whose `rules` are the business's K-26 v1 rules
// rows in force at `at` (default 159: the rows whose [effective_from, effective_to) holds it, of every flow and kind of
// work), which meets the port's "at least every row in effect at at". Each row is taken as RuleRow field by field
// (README item 76, "The mapping": "each row as RuleRow without its version"), its kind and value unchecked, as the
// evaluator checks them against the registry (a kind it does not hold is refused, never ignored). The read answers no
// rule's words and no one who set it.
//
// The read is db/repo's standalone readTermsSources on the Tool API's client, rosie_app (T-1428's handoff): a read-only
// transaction at repeatable read of its own on the primary, uncached, under the business limit 2 asks for, which is the
// gate's call's own (owner-rules.ts reads turn.businessId only, after refusing a proposal at another business). It runs
// beside the call's own transaction, on a connection of its own from the same client, so the repo createLimit2 hands the
// rules factory is not read.
//
// Fails closed, as the gate's limits do: a K-05 error answer (notFound, transient) is thrown as OwnerRulesReadError
// carrying that answer, and so is an answer for another business than the one asked or holding a row of another
// business (otherBusiness); whatever db/repo throws (a request it refuses, a stored value its answer cannot carry) leaves
// as it was thrown. The gate's call then rolls back and nothing passes on a rule nobody could read. Nothing here logs.
//
// What it still lacks to run at the gate (not this card's): the wiring hands it in (createLimit2({ rules }) where the turn
// face builds its limit registry: actions/src/tool-api/turn-face/commit.ts uses the shipped `limit2`, given no rules), and
// the walk (C-100, C-132, C-133) says what a part proposes: until then WALK_NOT_BUILT refuses every part that may carry an
// owner rule before any rule is read.

import {
  readTermsSources,
  type OwnerRuleRead,
  type ReadTermsSourcesOutcome,
  type ReadTermsSourcesRequest,
} from "../../../../../db/repo/catalog-reads";
import type { Sql } from "../../../../../db/repo/scope";
import type { NotFoundError, TransientError } from "../../../../../db/repo/targets";
import type { RuleRow } from "../../../rules/evaluator";
import type { OwnerRules } from "../facts";

/** K-05 v1.18 readTermsSources as the binding calls it: its response or one of its errors, or a throw as db/repo's. */
export type TermsSourcesRead = (request: ReadTermsSourcesRequest) => Promise<ReadTermsSourcesOutcome>;

/** Why the owner rules read failed the gate's call closed. */
export type OwnerRulesReadFault = "notFound" | "transient" | "otherBusiness";

/**
 * The owner rules read failed the gate's call closed (the top of this file). `answer` is K-05's error answer as the read
 * gave it, passed on; null for otherBusiness. The message names the read and the code, never a value or an id.
 */
export class OwnerRulesReadError extends Error {
  override name = "OwnerRulesReadError";
  /** The K-05 read that failed (a label). */
  readonly read = "readTermsSources";
  readonly code: OwnerRulesReadFault;
  readonly answer: NotFoundError | TransientError | null;

  constructor(code: OwnerRulesReadFault, answer: NotFoundError | TransientError | null) {
    super(
      code === "otherBusiness"
        ? "readTermsSources met another business than the one asked: the call fails closed"
        : `readTermsSources answered ${code}: the call fails closed`,
    );
    this.code = code;
    this.answer = answer;
  }
}

/** Whether a read's outcome is one of K-05's error answers: an object with its own "error" code. */
function isErrorAnswer(outcome: object): outcome is NotFoundError | TransientError {
  return "error" in outcome;
}

/** A K-26 rules row as limit 2's evaluator reads it (RuleRow), field by field, without its version. */
function ruleOf(row: OwnerRuleRead): RuleRow {
  return {
    id: row.id,
    businessId: row.businessId,
    ruleKind: row.ruleKind,
    valueType: row.valueType,
    flow: row.flow,
    kindId: row.kindId,
    valueOn: row.valueOn,
    valueCents: row.valueCents,
    valueCurrency: row.valueCurrency,
    valueSpanMinutes: row.valueSpanMinutes,
    valueCount: row.valueCount,
    valueDates: row.valueDates === null ? null : { from: row.valueDates.from, until: row.valueDates.until },
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

/**
 * OwnerRules over `read`: the business's rules in force at `at`, each as RuleRow; K-05's error answers and any row of
 * another business than the one asked are thrown (OwnerRulesReadError), never read as none.
 */
export function ownerRulesOf(read: TermsSourcesRead): OwnerRules {
  return {
    async rulesOf(businessId, at) {
      const outcome = await read({ businessId, at });
      if (isErrorAnswer(outcome)) throw new OwnerRulesReadError(outcome.error, outcome);
      if (outcome.businessId !== businessId || outcome.rules.some((row) => row.businessId !== businessId)) {
        throw new OwnerRulesReadError("otherBusiness", null);
      }
      return outcome.rules.map(ruleOf);
    },
  };
}

/**
 * Limit 2's OwnerRules on PostgreSQL: readTermsSources on `toolApi`, a client whose connections run as rosie_app, on the
 * primary, uncached. The wiring hands it to createLimit2 as `rules: () => pgOwnerRules(toolApi)`.
 */
export function pgOwnerRules(toolApi: Sql): OwnerRules {
  return ownerRulesOf((request) => readTermsSources(toolApi, request));
}
