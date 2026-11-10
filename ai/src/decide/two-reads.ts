// Decide, two reads (T-369, C-115; arch 02 step 5, line 119; arch 06 lines 285 to 287; arch 04 line 219; Q-26; CQ-07).
//
// One turn's K-02 v1 context is decided by two reads that must agree:
//
//   1. Route (T-363): the turn's stakes, from its choices, and the bundle's K-01 v1 policy name the model each read asks
//      first and give each read its own seed, so each lists the choices in its own order: Haiku twice on low stakes,
//      Sonnet first with Haiku checking on high (Q-26's default, as data in the manifest).
//   2. Read (T-368): the first read and the check read, side by side, each through decide's one read and the AI gateway
//      with the route's purpose, model and seed. Side by side, because arch 04's decide budget (2 to 4 s) holds one
//      read's two steps, not four; on a cold cache both calls write the cached prefix (the cache's rule: an entry is read
//      only once the response that wrote it is back).
//   3. Compare (agree.ts): part by part, on the verb, the choice and every field value, and the text's language.
//   4. Hand on K-02 v1's `decideResult`, the re-read not run: the route's stakes and read pair, both reads (each read's
//      model is the one that answered its step 1, T-368), agreed, the language or null, and each part: go when agreed,
//      else oneQuestion, so only agreed parts can reach the gate (the gate commits nothing for a oneQuestion part).
//
// A read that fails is never compared, and nothing goes to the gate on one read: a read the gateway got from neither
// model (`modelsDown`) makes the turn modelsDown, so nothing commits and T-271's path follows; a read the AI layer's
// validator refused is an unmapped read, so the turn is unmapped and its one re-read follows (arch 02 line 119; T-370).
// Each carries both reads' answers and every model call. modelsDown comes first: a re-read needs the models up.
//
// A read the gateway's fallback answered (the routed model failed twice, the other model answered) counts as that
// model's read, as K-02's `read.model` records it: the result's `routing` stays the route's pair, the read names the
// model that answered, the read's answer says `fallback`, and the comparison keeps the turn's stakes, so on high stakes
// any difference still ends in one question.
//
// Not here: the re-read (T-370); re-checking quotes and re-parsing values (the gate, C-080, and limit 6). Nothing here
// logs: each gateway attempt writes its own portCall span, and the span facts handed on are the reads' seeds and the
// context's counts, never words.

import { createRouter, type TurnRoute } from "../routing";
import { agreeReads } from "./agree";
import { createDecideReader } from "./read";
import type {
  Agreement,
  DecideContext,
  DecidePart,
  DecideResult,
  Decider,
  DeciderOptions,
  DecideReadAnswer,
  DecideTurnAnswer,
  DecideTurnOptions,
  PartAgreement,
  Read,
  ReadRole,
  ResultPart,
} from "./types";

/** The part a part that differs holds: the last read's part there (K-02 `resultPart`), the first's when only it has one. */
function lastPart(entry: PartAgreement): DecidePart {
  const part = entry.check ?? entry.first;
  // agreeReads gives an entry only where one of the reads has a part.
  if (part === null) throw new Error("a compared part holds a part of one read at least");
  return part;
}

/**
 * K-02 v1's `decideResult` for a turn's first and check reads, before any re-read (reread false, two reads): each part
 * agreed is the first read's part and goes; each part not agreed, or marked for one question, is the last read's part
 * there (K-02: "kept for the trace and the question"), and nothing changes for it. agreed and language are the
 * comparison's.
 */
export function twoReadResult(
  route: TurnRoute,
  first: Read,
  check: Read,
  agreement: Agreement,
): DecideResult {
  const parts = agreement.parts.map((entry): ResultPart =>
    entry.mark === "agreed" && entry.first !== null
      ? Object.freeze({ part: entry.first, outcome: "go" })
      : Object.freeze({ part: lastPart(entry), outcome: "oneQuestion" }),
  );
  return Object.freeze({
    turnId: route.turnId,
    bundleId: route.bundleId,
    stakes: route.stakes,
    routing: route.routing,
    reads: Object.freeze([first, check]),
    agreed: agreement.agreed,
    reread: false,
    language: agreement.language,
    parts: Object.freeze(parts),
  });
}

/** The roles of the reads in `answers` with `status`, first before check. */
function rolesWith(answers: readonly DecideReadAnswer[], status: DecideReadAnswer["status"]): ReadRole[] {
  const roles: ReadRole[] = [];
  answers.forEach((answer, k) => {
    if (answer.status === status) roles.push(k === 0 ? "first" : "check");
  });
  return roles;
}

/**
 * Builds decide's two reads for one bundle: its router (its id, its two model ids and its K-01 v1 routing policy) and
 * decide's one read on the same id and models with the bundle's prompts. Refuses, before any call, a bundle the router
 * refuses (GatewayConfigError for an id or model ids the AI gateway refuses, RoutingPolicyError for a policy that is not
 * K-01 v1's) and prompts of another bundle (GatewayConfigError).
 */
export function createDecider(options: DeciderOptions): Decider {
  const router = createRouter(options.bundle);
  // One bundle for both: the reader is built on the router's id and refuses prompts of another (GatewayConfigError).
  const reader = createDecideReader({
    bundle: { bundleId: router.bundleId, models: options.bundle.models },
    prompts: options.prompts,
    env: options.env,
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });

  return Object.freeze({
    bundleId: router.bundleId,
    async decide(context: DecideContext, turnOptions: DecideTurnOptions = {}): Promise<DecideTurnAnswer> {
      const { draw, ...callOptions } = turnOptions;
      // Refuses, before any call, a turn of another bundle, with no choice or with stakes K-02 does not have.
      const route = router.route(context, draw === undefined ? {} : { draw });
      const [firstRead, checkRead] = route.reads;
      // Side by side: each read is decide's one read with the route's purpose, model and seed.
      const answers = await Promise.all([
        reader.read(context, firstRead, callOptions),
        reader.read(context, checkRead, callOptions),
      ]);
      const [first, check] = answers;
      const base = {
        turnId: route.turnId,
        bundleId: route.bundleId,
        stakes: route.stakes,
        highChoices: route.highChoices,
        routing: route.routing,
        answers: Object.freeze([first, check] as const),
        modelCalls: Object.freeze([...first.modelCalls, ...check.modelCalls]),
        // Each read's seed has its own name (T-367); the counts are the one context's, the same in both.
        span: Object.freeze({ ...first.span, ...check.span }),
      };
      if (first.status === "modelsDown" || check.status === "modelsDown")
        return Object.freeze({ ...base, status: "modelsDown" });
      if (first.status !== "ok" || check.status !== "ok")
        return Object.freeze({
          ...base,
          status: "unmapped",
          refused: Object.freeze(rolesWith(answers, "refused")),
        });
      const agreement = agreeReads(first.read.output, check.read.output, route.stakes);
      return Object.freeze({
        ...base,
        status: "decided",
        agreement,
        result: twoReadResult(route, first.read, check.read, agreement),
      });
    },
  });
}
