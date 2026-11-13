// Fixtures and doubles for the gate framework's tests (T-298). Never imported by the Worker. The doubles stand in for
// limits 1 to 6 (each limit's rule is T-299 to T-304's), never for the gate under test: each answers what its script
// says and writes down every call, so a test sees which limit ran on which part, in what order.
// Values come only from the contracts' fixtures (K-02 v1 and K-09 v1: the master's sample cast, the 555-01xx range;
// rule 9).

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import { HANDLE_REF, contractFile, fixture } from "../../tool-api/test-support";
import type { CallContext, SpanNotes } from "../../tool-api/tool-api";
import { notBuiltLimit } from "./stub";
import type {
  Context,
  DecidePart,
  DecideResult,
  Decided,
  GateRequest,
  Limit,
  LimitNumber,
  LimitRegistry,
  LimitVerdict,
} from "./types";

/** A fresh deep copy: each test changes its own. */
export function copy<T>(value: T): T {
  return structuredClone(value);
}

/** One of K-02 v1's fixtures (contracts/model/fixtures), freshly parsed. */
export function modelFixture(file: string): unknown {
  return contractFile(`model/fixtures/${file}`);
}

/** One K-02 v1 decide read (`decideRead`), such as a refused fixture's. */
export type DecideRead = DecideResult["reads"][number]["output"];

/**
 * Sam's "block thursday afternoon and also tile is $12 a foot from now on" (arch 04): K-02's context-two-requests.json
 * with decide-two-requests.json, two parts that choose two of the owner hub's cases, about no booking.
 */
export function twoRequests(): Decided {
  return {
    context: modelFixture("context-two-requests.json") as Context,
    decide: modelFixture("decide-two-requests.json") as DecideResult,
  };
}

/** Sam names the kinds of work (S1-02): K-02's context-s1-02.json with decide-s1-02-choose.json. */
export function samKinds(): Decided {
  return {
    context: modelFixture("context-s1-02.json") as Context,
    decide: modelFixture("decide-s1-02-choose.json") as DecideResult,
  };
}

/** One gateAndCommit exchange of K-09 v1 (contracts/tool-api/fixtures), freshly parsed. */
export function gateExchange(file: string): K09.GateAndCommitExchange {
  return fixture(file) as K09.GateAndCommitExchange;
}

/** The decided pair a K-09 gate exchange carries. */
export function decidedOf(exchange: K09.GateAndCommitExchange): Decided {
  const { input } = exchange.request;
  if (input.kind !== "decided") throw new Error("the exchange carries no decided texts");
  return input.decided;
}

/**
 * K-09's gate exchanges on decided texts, each answered per part or refused before any write: v1's, and v1.5's turn 1
 * (commit-s1-01.json: Sam's first text enters K-02 v1.1's sign-up door; T-1183).
 */
export const DECIDED_GATE_FIXTURES = [
  "commit-s1-01.json",
  "commit-s1-02.json",
  "commit-limit-1-unproven-sender.json",
  "commit-limit-2-owner-rule.json",
  "commit-limit-3-no-exact-yes.json",
  "commit-limit-4-changed.json",
  "commit-limit-5-taken.json",
  "commit-limit-6-reread-first.json",
  "commit-limit-6-value-fails.json",
] as const;

/**
 * Alex's bare "2" to A7-17's question (K-02 decide-bare-2.json), with the context it answers: K-09's
 * commit-limit-2-owner-rule.json context for Alex's A7-17 question, given decide-bare-2's turn, bundle and question id
 * and the text "2". K-02 v1 has no context fixture for it; its two refused reads (refuse-unknown-verb.json,
 * refuse-value-without-words.json) answer the same question.
 */
export function bareTwo(): Decided {
  const decide = modelFixture("decide-bare-2.json") as DecideResult;
  const context = copy(decidedOf(gateExchange("commit-limit-2-owner-rule.json")).context);
  context.turnId = decide.turnId;
  context.bundleId = copy(decide.bundleId);
  context.texts[0].words = "2";
  for (const question of context.openQuestions) question.openQuestionId = "oq-a7-17";
  for (const choice of context.choices) choice.question = "oq-a7-17";
  return { context, decide };
}

/** The pair with every read's output, and the agreed parts, set to one decide read (each part going to the gate). */
export function withRead(decided: Decided, read: DecideRead): Decided {
  const pair = copy(decided);
  for (const each of pair.decide.reads) each.output = copy(read);
  const [first, ...rest] = copy(read.parts);
  pair.decide.parts = [
    { part: first, outcome: "go" },
    ...rest.map((part) => ({ part, outcome: "go" as const })),
  ];
  return pair;
}

/** One of K-02 v1's refused decide reads (contracts/model/fixtures/invalid). */
function refusedRead(file: string): DecideRead {
  return modelFixture(`invalid/${file}`) as DecideRead;
}

/**
 * K-02 v1's four refused decide outputs, each as the gate reads it, with the named rule K-09's `decideRefused` gives:
 * the two refused pairs as they are, and the two refused reads as Alex's bare "2" (bareTwo) with every read and the
 * agreed part set to them.
 */
export function refusedDecideOutputs(): [string, Decided, "optionOffered" | "quoteInText"][] {
  return [
    [
      "refuse-option-not-offered.json",
      modelFixture("invalid/refuse-option-not-offered.json") as Decided,
      "optionOffered",
    ],
    [
      "refuse-quote-not-in-text.json",
      modelFixture("invalid/refuse-quote-not-in-text.json") as Decided,
      "quoteInText",
    ],
    [
      "refuse-unknown-verb.json",
      withRead(bareTwo(), refusedRead("refuse-unknown-verb.json")),
      "optionOffered",
    ],
    [
      "refuse-value-without-words.json",
      withRead(bareTwo(), refusedRead("refuse-value-without-words.json")),
      "quoteInText",
    ],
  ];
}

/** Turns a part, in place, into `next`: the old verb's own properties go and `next`'s come (for use in changePart). */
export function becomes(part: DecidePart, next: DecidePart): void {
  for (const key of Object.keys(part)) Reflect.deleteProperty(part, key);
  Object.assign(part, copy(next));
}

/** Changes the part at `index` the same way in decide.parts and in every read, so only that change differs. */
export function changePart(decided: Decided, index: number, change: (part: DecidePart) => void): Decided {
  const pair = copy(decided);
  const entry = pair.decide.parts[index];
  if (entry === undefined) throw new Error(`no part ${String(index)}`);
  change(entry.part);
  for (const read of pair.decide.reads) {
    const part = read.output.parts[index];
    if (part !== undefined) change(part);
  }
  return pair;
}

/**
 * A gateAndCommit request for a decided pair, as the handle actor sends it: a turn's caller under the business its
 * choices are for, acting for the writer, the turn row over its texts' events, no core action, 'now' the last text's
 * send time.
 */
export function gateRequest(decided: Decided): GateRequest {
  const { context, decide } = decided;
  const turnId = context.turnId;
  const traceId = `trace-${turnId}`;
  const [firstText, ...moreTexts] = context.texts;
  const lastText = moreTexts.at(-1) ?? firstText;
  return {
    caller: {
      kind: "turn",
      turnId,
      requestId: turnId,
      businessId: context.choices[0].target.businessId,
      personId: context.writer.people[0].personId,
      traceId,
    },
    turn: {
      id: turnId,
      handleId: HANDLE_REF,
      eventIds: [firstText.eventId, ...moreTexts.map((text) => text.eventId)],
      bundleId: copy(decide.bundleId),
      traceId,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "decided", decided, planner: null },
    core: [],
    now: lastText.sentAt.utc,
  };
}

/** The repo the gate's direct tests hand it: never read by the doubles, so a test can see it reach each limit. */
export interface FakeRepo {
  readonly name: "gate-test-repo";
}

/** A call context as the Tool API base gives a handler (CallContext), with a fresh span. */
export function callContext(businessId = "biz-lee-home-services"): CallContext<FakeRepo> {
  const span: SpanNotes = { limits: [], rows: [] };
  return { repo: { name: "gate-test-repo" }, businessId, span };
}

/** One call of a limit double: which limit, on which part. */
export interface LimitCall {
  readonly limit: LimitNumber;
  readonly part: number;
}

/** What each limit double answers for one part, by limit; a limit not named passes. */
export type PartScript = { readonly [N in LimitNumber]?: LimitVerdict<N> };

/** The scripts by part index; a part not named passes every limit. */
export type Script = Readonly<Partial<Record<number, PartScript>>>;

const PASS = { result: "pass" } as const;

/** A limit that writes down each call, then answers as `inner` does. */
function recorded<N extends LimitNumber>(inner: Limit<N>, calls: LimitCall[]): Limit<N> {
  return {
    limit: inner.limit,
    check(part, turn) {
      calls.push({ limit: inner.limit, part: part.index });
      return inner.check(part, turn);
    },
  };
}

function scripted<N extends LimitNumber>(limit: N, script: Script): Limit<N> {
  return {
    limit,
    check(part) {
      const verdict: LimitVerdict<N> = script[part.index]?.[limit] ?? PASS;
      return Promise.resolve(verdict);
    },
  };
}

/**
 * Limits 1 to 6 as doubles: each answers its script (pass where the script names nothing), and each limit listed in
 * `notBuilt` is the fail-closed stub itself (stub.ts). Every call is written down in `calls`, in order.
 */
export function scriptedLimits(
  script: Script = {},
  calls: LimitCall[] = [],
  notBuilt: readonly LimitNumber[] = [],
): LimitRegistry {
  const slot = <N extends LimitNumber>(limit: N): Limit<N> =>
    recorded(notBuilt.includes(limit) ? notBuiltLimit(limit) : scripted(limit, script), calls);
  return [slot(1), slot(2), slot(3), slot(4), slot(5), slot(6)];
}

/** Every limit not built yet: the fail-closed stubs, as the registry holds them before T-299 to T-304 land. */
export function stubLimits(calls: LimitCall[] = []): LimitRegistry {
  return scriptedLimits({}, calls, [1, 2, 3, 4, 5, 6]);
}

/**
 * The script a K-09 gate exchange states: each part's limits as its outcome logs them, up to and including the one that
 * failed, with that limit's outcome (`stoppedBy`); for `valueFailsWords`, limit 6 failing on the fields it names.
 */
export function fixtureScript(exchange: K09.GateAndCommitExchange): Script {
  const script: Record<number, Record<number, unknown>> = {};
  const { outcome } = exchange;
  if ("error" in outcome) {
    if (outcome.error !== "valueFailsWords") throw new Error("not a gate fixture the doubles can script");
    for (const { part, fields } of outcome.parts) {
      script[part] = {
        6: { result: "fail", outcome: { limit: 6, outcome: "ask", action: "oneQuestion" }, fields },
      };
    }
    return script;
  }
  if (outcome.result !== "committed") throw new Error("not a gate fixture the doubles can script");
  for (const part of outcome.parts) {
    const verdicts: Record<number, unknown> = {};
    for (const entry of part.limits) {
      if (entry.result === "fail") {
        verdicts[entry.limit] = { result: "fail", outcome: part.stoppedBy };
        break;
      }
      verdicts[entry.limit] = { result: entry.result };
    }
    script[part.part] = verdicts;
  }
  return script;
}

/** The strings a quote or a value's words hold in a pair: what never goes in a log, a span or an error. */
export function wordsIn(decided: Decided): string[] {
  const words = new Set<string>();
  const add = (part: DecidePart): void => {
    words.add(part.quote);
    if (part.verb === "choose" || part.verb === "enter")
      for (const field of part.fields) words.add(field.words);
    if (part.verb === "pass_on" || part.verb === "redact") words.add(part.words);
  };
  for (const entry of decided.decide.parts) add(entry.part);
  for (const read of decided.decide.reads) for (const part of read.output.parts) add(part);
  for (const text of decided.context.texts) words.add(text.words);
  return [...words].filter((each) => each.trim().length > 0);
}
