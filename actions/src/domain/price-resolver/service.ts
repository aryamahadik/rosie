// The price resolver for one call, inside the call's business scope (C-132, T-639): it reads a service's price rules
// and ties through the catalog's read 4 (actions/src/domain/catalog reads.ts priceRulesOf, which T-1429 binds to K-05
// v1.18's readServicePriceRules on PostgreSQL) and answers resolve.ts's price for a visit, or the read-back's tie
// questions. It writes nothing: a tie is written by the catalog at the save that catches it (addPrice, changePrice,
// withdrawPrice), and answered by answerTie.
//
// Every row read must be the call's business's (otherBusiness) and the service's asked (badRead), so a leaky reader fails
// closed, as the catalog's own reads do. A read's own error (CatalogReadError, db/repo's) leaves as thrown.

import type { CatalogReads, PriceRulesRead } from "../catalog";
import {
  PriceResolverError,
  checkVisit,
  requireId,
  requireInstant,
  resolvePrice,
  tieQuestions,
  type PriceAnswer,
  type TieQuestion,
  type Visit,
} from "./resolve";

/** What one call's resolver is built with. */
export interface PriceResolverDeps {
  /** The call's business (CallContext.businessId): every row read is this business's. */
  readonly businessId: string;
  /** The catalog's read 4, handed in by name. */
  readonly reads: Pick<CatalogReads, "priceRulesOf">;
}

export interface PriceResolver {
  readonly businessId: string;
  /** The price of one visit (K-25 "How a price is found"). */
  priceFor(visit: Visit): Promise<PriceAnswer>;
  /** The unanswered ties of a service whose rules price visits at or after `at`: what the read-back asks. */
  tiesToAsk(serviceId: string, at: string): Promise<TieQuestion[]>;
}

/** The call's price resolver. */
export function createPriceResolver(deps: PriceResolverDeps): PriceResolver {
  const businessId = requireId(deps.businessId, "businessId");

  /** Read 4 under the call's business, every row held to the business and the service asked. */
  async function read(serviceId: string, at: string): Promise<PriceRulesRead> {
    const answer = await deps.reads.priceRulesOf(businessId, serviceId, at);
    for (const row of [...answer.rules, ...answer.ties]) {
      if (row.businessId !== businessId) throw new PriceResolverError("otherBusiness", ["rules"]);
      if (row.serviceId !== serviceId) throw new PriceResolverError("badRead", ["rules"]);
    }
    return answer;
  }

  return {
    businessId,
    async priceFor(visit) {
      const asked = checkVisit(visit);
      const { rules, ties } = await read(asked.serviceId, asked.startsAt);
      return resolvePrice(asked, rules, ties);
    },
    async tiesToAsk(serviceId, at) {
      const service = requireId(serviceId, "serviceId");
      const instant = requireInstant(at, "at");
      const { rules, ties } = await read(service, instant);
      return tieQuestions(rules, ties);
    },
  };
}
