// The turn's one Sonnet re-read (T-370, C-116; arch 02 step 5, line 119; arch 06 line 289; arch 04 line 221: + 3 to
// 6 s; Q-41; S13-25 rules 16 and 17; K-02 v1 decide-reads-disagree.json; K-09 README default 25).
//
// "Disagreement, an unmapped part or a value that fails its words: one Sonnet re-read per turn. Still unclear: one
// question, and nothing changes for that part. Parts about other bookings that both reads agree on go ahead." The
// re-read is decide's one read (T-368) once more, with the purpose reread, the model the bundle's policy names for it
// (K-01 v1 `policy.reread`: Sonnet in every sample bundle; the gateway's retry and fallback as for any call) and its own
// seed, so it lists the choices in its own order. It runs when asked:
//
//   disagreed        by the turn loop (T-251) with decide's K-02 result, when the first and check reads differ on a part
//                    or on the language (agreed false): the turn loop never takes such a result to the gate before it;
//   valueFailsWords  by the turn loop, after the gate refused a value failing its words before the re-read, naming the
//                    parts and fields (K-09 commit-limit-6-reread-first.json, then commit-limit-6-value-fails.json);
//   unmapped         by the AI layer itself, for a turn decide answered `unmapped` (a read the validator refused): such a
//                    turn has no K-02 result to hand the turn loop (CQ-162 (a)), so T-558's decide port asks for it.
//
// What it answers: K-02 v1's result with the re-read (reread true), where only parts two reads give alike go
// (result.ts); or, when a read of the turn is refused (the re-read itself, or the first or check read of an unmapped
// turn), the AI layer's own `unmapped` answer: the turn ends in one question and nothing changes for any part, because
// K-02 v1's result holds only K-02 reads (CQ-162 (a), the architect's); or `modelsDown`, after which T-271's path runs.
//
// Once per turn (Q-41): a result that already holds the re-read is refused, and so is a second request for a turn this
// decider has re-read since the turn's last decide (a new decide is a new run of the turn, as when the lease reruns it).
// Every refusal comes before any call. Before it takes the turn's one re-read it checks, so nothing goes ahead on a result
// decide did not give: the context is the result's turn, on the decider's bundle; the result's stakes and read pair are
// the turn's route; its two reads are K-02 reads of this context (the named rules too); and the result is exactly what
// those two reads give (twoReadResult), so no part can go that the reads did not agree on.
//
// Nothing here logs. The span facts are the re-read's seed and the context's counts; a refusal names fields, places and
// rules, never words.

import { canonical, sameBundleId } from "../cache/bundle";
import { drawSeed } from "../context";
import { turnStakes, type Router } from "../routing";
import { agreeReads } from "./agree";
import { readProblems } from "./check";
import { DecideRequestError, RereadRefusedError } from "./errors";
import { rereadResult, twoReadResult, type ResultRoute } from "./result";
import {
  REREAD_WHYS,
  type Agreement,
  type DecideContext,
  type DecideReadAnswer,
  type DecideReader,
  type DecideTurnOptions,
  type ReadRole,
  type RereadAfterReads,
  type RereadAnswer,
  type RereadRequest,
  type RereadUnmappedTurn,
} from "./types";

/** How many turns a decider remembers re-reading since each one's last decide; the oldest is let go first. */
export const REREAD_MEMORY = 1024;

/** The turns whose one re-read a decider has used (Q-41: once per turn). */
export interface RereadLedger {
  /** A new decide of the turn: a new run of it, whose one re-read is not yet used. */
  open(turnId: string): void;
  /**
   * Takes the turn's one re-read for `asked`, the result or answer of decide it re-reads. Throws RereadRefusedError when
   * the turn's re-read has run since its last decide, or `asked` was re-read already.
   */
  claim(turnId: string, asked: object): void;
}

/** A decider's ledger of re-read turns: at most `memory` turn ids, and every result or answer re-read, held weakly. */
export function createRereadLedger(memory: number = REREAD_MEMORY): RereadLedger {
  const turns = new Set<string>();
  // Results and answers already re-read; held weakly, so the ledger keeps nothing a turn no longer holds.
  const asked = new WeakSet();
  return Object.freeze({
    open(turnId: string): void {
      turns.delete(turnId);
    },
    claim(turnId: string, what: object): void {
      if (turns.has(turnId) || asked.has(what))
        throw new RereadRefusedError(
          "the turn's one re-read has run: a second request in the same turn is refused (Q-41)",
        );
      turns.add(turnId);
      asked.add(what);
      for (const oldest of turns) {
        if (turns.size <= memory) break;
        turns.delete(oldest);
      }
    },
  });
}

/** What the re-read runs with: the decider's router (its bundle and policy), its one read and its ledger. */
export interface RereadStage {
  readonly router: Router;
  readonly reader: DecideReader;
  readonly ledger: RereadLedger;
}

const sameJson = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** The roles of the answers with `status`, first before check. */
function rolesWith(answers: readonly DecideReadAnswer[], status: DecideReadAnswer["status"]): ReadRole[] {
  const roles: ReadRole[] = [];
  answers.forEach((answer, k) => {
    if (answer.status === status) roles.push(k === 0 ? "first" : "check");
  });
  return roles;
}

/** The request is about this context's turn, on the decider's bundle, with the stakes and read pair of its route. */
function checkTurn(stage: RereadStage, context: DecideContext, route: ResultRoute): void {
  if (route.turnId !== context.turnId)
    throw new DecideRequestError("the re-read is asked for another turn than the context's");
  if (
    !sameBundleId(route.bundleId, stage.router.bundleId) ||
    !sameBundleId(context.bundleId, stage.router.bundleId)
  )
    throw new DecideRequestError("the re-read is asked on another bundle than the decider's");
  // Throws RoutingRefusedError for a context with no choice, or a choice with stakes K-02 does not have.
  const { stakes } = turnStakes(context);
  if (route.stakes !== stakes)
    throw new DecideRequestError("the stakes are not the turn's, as its choices give them (T-363)");
  const pair = stage.router.policy[stakes];
  if (route.routing.first !== pair.first || route.routing.second !== pair.second)
    throw new DecideRequestError("the read pair is not the bundle policy's for the turn's stakes");
}

/** Decide's K-02 result before any re-read, checked as the turn's own: the first and check reads' comparison. */
function checkAfterReads(stage: RereadStage, request: RereadAfterReads): Agreement {
  const { context, decide, why, failing } = request;
  if (decide.reread || decide.reads.some((read) => read.role === "reread"))
    throw new RereadRefusedError(
      "the result already holds the turn's one re-read: a second request is refused (Q-41)",
    );
  checkTurn(stage, context, decide);
  const [first, check] = decide.reads;
  if (decide.reads.length !== 2 || first?.role !== "first" || check?.role !== "check")
    throw new DecideRequestError("a re-read follows the turn's first and check reads, in that order");
  for (const [role, read] of [
    ["first", first],
    ["check", check],
  ] as const) {
    const problems = readProblems(context, read.output);
    if (problems.length > 0)
      throw new DecideRequestError(
        `the ${role} read is not a K-02 read of this context: ${problems.join("; ")}`,
      );
  }
  const agreement = agreeReads(first.output, check.output, decide.stakes);
  if (!sameJson(twoReadResult(decide, first, check, agreement), decide))
    throw new DecideRequestError(
      "the result is not what its first and check reads give: a part goes only where both agree (T-369)",
    );
  if (why === "disagreed") {
    if (decide.agreed)
      throw new DecideRequestError("the first and check reads agree: there is nothing to re-read");
    if (failing.length > 0)
      throw new DecideRequestError("only the gate names values that fail their words (valueFailsWords)");
    return agreement;
  }
  if (failing.length === 0)
    throw new DecideRequestError("valueFailsWords names the parts whose values fail their words");
  const named = new Set<number>();
  failing.forEach((entry, k) => {
    const at = `failing[${String(k)}]`;
    const given = Number.isInteger(entry.part) ? decide.parts[entry.part] : undefined;
    if (given?.outcome !== "go" || named.has(entry.part))
      throw new DecideRequestError(`${at} names no part decide sent to the gate, or one named before`);
    named.add(entry.part);
    const part = given.part;
    const carried =
      part.verb === "choose" || part.verb === "enter" ? part.fields.map((field) => field.name) : [];
    if (entry.fields.length === 0 || entry.fields.some((name) => !carried.includes(name)))
      throw new DecideRequestError(`${at} names no field, or a field its part does not carry`);
  });
  return agreement;
}

/**
 * Decide's unmapped answer, checked as the turn's own: its two reads' answers, one refused at least, none down. An
 * unmapped turn's reads were never compared, so there is no comparison to hand on (null).
 */
function checkUnmapped(stage: RereadStage, request: RereadUnmappedTurn): null {
  const { context, unmapped } = request;
  // The types say both; an answer that crossed a port untyped is still checked.
  const status: unknown = unmapped.status;
  if (status !== "unmapped")
    throw new DecideRequestError("an unmapped turn's re-read takes decide's unmapped answer");
  checkTurn(stage, context, unmapped);
  const refused = rolesWith(unmapped.answers, "refused");
  if (
    (unmapped.answers as readonly unknown[]).length !== 2 ||
    refused.length === 0 ||
    rolesWith(unmapped.answers, "modelsDown").length > 0 ||
    !sameJson(refused, unmapped.refused)
  )
    throw new DecideRequestError(
      "decide's unmapped answer holds its first and check reads' answers, one refused at least and none down",
    );
  return null;
}

/** The turn's one re-read: decide's one read with the purpose reread, on the policy's model, with its own seed. */
function readAgain(
  stage: RereadStage,
  context: DecideContext,
  options: DecideTurnOptions,
): Promise<DecideReadAnswer> {
  const { draw, ...callOptions } = options;
  const seed = (draw ?? drawSeed)();
  return stage.reader.read(
    context,
    { purpose: "reread", model: stage.router.policy.reread, seed },
    callOptions,
  );
}

/**
 * The turn's one Sonnet re-read (see the head of this file). Never rejects for a failed model call or a bad answer
 * (`modelsDown`, `unmapped`); rejects before any call a second request (RereadRefusedError) and a request it cannot serve
 * (DecideRequestError), and what decide's one read rejects.
 */
export async function rereadTurn(
  stage: RereadStage,
  request: RereadRequest,
  options: DecideTurnOptions = {},
): Promise<RereadAnswer> {
  // The types say which; a caller that casts (the turn loop's noneFits) is still refused before any call.
  if (!(REREAD_WHYS as readonly string[]).includes(request.why))
    throw new DecideRequestError(
      "this re-read runs when the reads disagree, a read is unmapped or a value fails its words: not after meaning search",
    );
  // Each request is checked as the turn's own before the turn's one re-read is taken: a refused one never uses it.
  const agreement =
    request.why === "unmapped" ? checkUnmapped(stage, request) : checkAfterReads(stage, request);
  const asked = request.why === "unmapped" ? request.unmapped : request.decide;
  stage.ledger.claim(asked.turnId, asked);

  const again = await readAgain(stage, request.context, options);
  const base = {
    turnId: asked.turnId,
    bundleId: asked.bundleId,
    stakes: asked.stakes,
    routing: asked.routing,
    why: request.why,
    model: stage.router.policy.reread,
    modelCalls: Object.freeze([...again.modelCalls]),
    span: again.span,
  };
  if (again.status === "modelsDown") return Object.freeze({ ...base, status: "modelsDown", reread: again });
  if (again.status === "refused" || request.why === "unmapped" || agreement === null) {
    const before = request.why === "unmapped" ? request.unmapped.refused : [];
    const refused: ReadRole[] = again.status === "refused" ? [...before, "reread"] : [...before];
    return Object.freeze({
      ...base,
      status: "unmapped",
      reread: again,
      refused: Object.freeze(refused),
      end: "oneQuestion",
    });
  }
  const { result, settlement } = rereadResult(request.decide, agreement, again.read, request.failing);
  return Object.freeze({ ...base, status: "decided", reread: again, settlement, result });
}
