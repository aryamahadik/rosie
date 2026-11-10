// buildFrontier, the Tool API call (T-291, T-1150; K-09 v1's call, typed and checked by K-09 v1.5's buildFrontier; arch
// 02 step 4, line 117): the turn, its targets from the guard and the pinned bundle give K-02 v1.1's context. Registered
// on the T-290 base (createToolApi), which checks the request against K-09 v1.5, runs this handler inside one
// transaction scoped to the caller's business, holds the answer to buildFrontier's response or errors, and opens the
// call's one K-08 span (hop frontier). In this order:
//
//   1. the pinned bundle's manifest (K-01 v1), or bundleNotFound;
//   2. the turn's stored state in one read: K-05 v1.2 readTurnState under the call's business, with the business's name
//      and zone and the people's names as facts from their homes (K-04 v1 businesses, persons); its notFound and
//      transient are buildFrontier's own errors, answered as they are;
//   3. the open questions' bookings' visit times (FrontierRepo.readVisitTimes; K-05 v1.2 open gap 25);
//   4. the context's flow (frame.ts), and the flow graphs of the pinned bundle and of each bundle an open question was
//      asked under;
//   5. every source in its slot (registry.ts frontierSources, made for the bundles port the call reads with: the
//      hubs-and-doors source reads its doors' words through it), assembled (assemble.ts): a source not built, throwing
//      or refused offers nothing and is logged;
//   6. the cap (T-295, cap/): over 60 choices, each booking other than the target collapses to one 'which booking?'
//      choice (arch 03 line 167), named in `collapsedBookingIds`; still over 60: tooManyChoices with the count;
//   7. the facts the choices' steps need, each once from its one home with its row and version, read strong: the
//      primary, uncached (T-295, facts/; arch 02 line 117; arch 10 line 538); a second value for one key is refused, the
//      home's value goes in and the step is named in `flagged`. The read's notFound and transient are buildFrontier's
//      own errors;
//   8. the context, checked against K-02 v1.1 as a whole. No choice at all, or a context K-02 refuses: a FrontierError,
//      which the base records as a failed span and passes on, so the turn takes the outage path (arch 06 line 293) and
//      decide never sees a frontier that is not closed and valid.
//
// Reads only: nothing is written, so a repeat is safe (K-09 README). No model is called (arch 03 line 153).
// `recentMessages` is empty while no frozen call reads them (K-05 v1.2 open gap 20).

import { notBuiltHandlers, type Handler, type Handlers } from "../../tool-api/tool-api";
import { MAX_CHOICES, capChoices } from "../cap";
import { factsFor, type FrontierFactsOptions } from "../facts";
import { assemble } from "./assemble";
import { readBundle, readManifest, flowOfStep, type ManifestView } from "./bundle";
import { defaultChecker, type FrontierChecker } from "./check";
import { DEFAULT_BUSINESS_LANGUAGE, contextFlowOf, frameFacts, namedPersons, writerOf } from "./frame";
import { consoleSink, frontierLogger, type FrontierLogSink } from "./log";
import { frontierSources } from "./registry";
import {
  bundleKey,
  type BuildFrontierAnswer,
  type BuildFrontierRequest,
  type BundleId,
  type BundleView,
  type Context,
  type FlowLetter,
  type FrontierBundles,
  type FrontierInput,
  type FrontierRepo,
  type SourceSlot,
  type Time,
} from "./types";

/** The most choices a frontier holds (arch 01 line 69; K-02 v1.1 context.choices maxItems): the cap's (cap/). */
export { MAX_CHOICES };

/** Why the frontier cannot answer within K-09 v1.5: a builder fault, never a refusal of the caller. */
export type FrontierFault = "noChoices" | "noWriter" | "unknownFact" | "badState" | "invalidContext";

/** A builder fault: the base records a failed span and passes it on. Its message is its code, never a value. */
export class FrontierError extends Error {
  override name = "FrontierError";
  readonly code: FrontierFault;

  constructor(code: FrontierFault) {
    super(code);
    this.code = code;
  }
}

export interface FrontierOptions {
  /** The bundles, read under their ids (KV, or PostgreSQL's copy on a miss). */
  bundles: FrontierBundles;
  /** The slots, in order. Default: the registry's, made for `bundles` (registry.ts frontierSources). */
  sources?: readonly SourceSlot[];
  /** Where the frontier's log lines go. Default: one JSON line each on console.warn. */
  log?: FrontierLogSink;
  /** The K-02 v1.1 checks. Default: one checker per isolate. */
  checker?: FrontierChecker;
  /** The facts' homes, sources and read port (facts/). Default: no home listed yet, so no fact; K-05 readTurnState. */
  facts?: FrontierFactsOptions;
}

/** buildFrontier's handler on the Tool API base: its repo is the call's scoped transaction. */
export function createBuildFrontierHandler<Repo extends FrontierRepo>(
  options: FrontierOptions,
): Handler<"buildFrontier", Repo> {
  return (request, context) => buildFrontier(request, context.repo, context.businessId, options);
}

/** Every call's handler for the base: buildFrontier built, every other call still its notBuilt stub. */
export function frontierHandlers<Repo extends FrontierRepo>(options: FrontierOptions): Handlers<Repo> {
  return { ...notBuiltHandlers(), buildFrontier: createBuildFrontierHandler<Repo>(options) };
}

function unique<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** The flows to read of one bundle: each own flow of the steps asked under it, and the context's for a shared step. */
function flowsFor(steps: readonly string[], contextFlow: FlowLetter, pinned: boolean): FlowLetter[] {
  const flows = steps.map((step) => flowOfStep(step) ?? contextFlow);
  return unique(pinned ? [contextFlow, ...flows] : flows);
}

async function buildFrontier(
  request: BuildFrontierRequest,
  repo: FrontierRepo,
  businessId: string,
  options: FrontierOptions,
): Promise<BuildFrontierAnswer> {
  const log = frontierLogger(options.log ?? consoleSink, {
    traceId: request.caller.traceId,
    turnId: request.turn.id,
  });
  const checker = options.checker ?? defaultChecker();

  // 1. The pinned bundle.
  const pinnedId: BundleId = request.turn.bundleId;
  const pinnedManifest = await readManifest(options.bundles, pinnedId);
  if (pinnedManifest === null) return { error: "bundleNotFound", bundleId: pinnedId };

  // 2. The turn's stored state, one read of the primary under the call's business.
  const read = await repo.readTurnState({
    handleId: request.turn.handleId,
    businessId,
    bookingIds: [],
    facts: frameFacts(businessId, namedPersons(request)),
  });
  if ("error" in read) {
    if (read.error === "notFound" || read.error === "transient") return read;
    throw new FrontierError("unknownFact");
  }
  // A read of another business than the call's would label its choices wrongly: never used.
  if (read.businessId !== businessId) throw new FrontierError("badState");
  const facts = new Map(read.facts.map((fact) => [fact.key, fact.value]));
  const name = facts.get("biz.name");
  const zone = facts.get("biz.zone");
  if (typeof name !== "string" || typeof zone !== "string") throw new FrontierError("badState");
  const names = new Map<string, string>();
  for (const [key, value] of facts) {
    if (key.startsWith("person.name/") && typeof value === "string") {
      names.set(key.slice("person.name/".length), value);
    }
  }

  // 3. The open questions' bookings' visit times.
  const visits = new Map<string, Time | null>();
  const bookingIds = unique(
    read.openQuestions.flatMap((row) => (row.bookingId === null ? [] : [row.bookingId])),
  );
  if (bookingIds.length > 0) {
    const answer = await repo.readVisitTimes({ bookingIds });
    if ("error" in answer) return answer;
    for (const bookingId of bookingIds) {
      const visit = answer.visits.find((each) => each.bookingId === bookingId);
      visits.set(bookingId, visit?.visitAt ?? null);
    }
  }

  // 4. The flow, and the bundles' flow graphs.
  const flow = contextFlowOf(read.openQuestions, pinnedManifest.flows);
  if (flow === null) return { error: "bundleNotFound", bundleId: pinnedId };
  const asked = new Map<string, { bundleId: BundleId; steps: string[] }>();
  for (const row of read.openQuestions) {
    const key = bundleKey(row.bundleId);
    const entry = asked.get(key) ?? { bundleId: row.bundleId, steps: [] };
    entry.steps.push(row.step);
    asked.set(key, entry);
  }
  const pinnedKey = bundleKey(pinnedId);
  const pinned = await readBundle(
    options.bundles,
    pinnedId,
    pinnedManifest,
    flowsFor(asked.get(pinnedKey)?.steps ?? [], flow, true),
  );
  const alwaysOn = pinned.flows[flow]?.alwaysOnSha256 ?? null;
  if (alwaysOn === null) return { error: "bundleNotFound", bundleId: pinnedId };
  const bundles = new Map<string, BundleView | null>([[pinnedKey, pinned]]);
  for (const [key, entry] of asked) {
    if (bundles.has(key)) continue;
    const manifest: ManifestView | null = await readManifest(options.bundles, entry.bundleId);
    bundles.set(
      key,
      manifest === null
        ? null
        : await readBundle(options.bundles, entry.bundleId, manifest, flowsFor(entry.steps, flow, false)),
    );
  }

  // 5. The sources.
  const input: FrontierInput = {
    request,
    business: { id: businessId, name, zone },
    state: read,
    visits,
    flow,
    pinned,
    bundles,
    log,
  };
  const assembled = await assemble(options.sources ?? frontierSources(options.bundles), input, checker);
  if (assembled.choices.length === 0) throw new FrontierError("noChoices");

  // 6. The cap.
  const capped = capChoices(assembled.choices, assembled.openQuestions, MAX_CHOICES);
  if (capped.result === "tooMany") return { error: "tooManyChoices", count: capped.count };
  const [first, ...rest] = capped.choices;
  if (first === undefined) throw new FrontierError("noChoices");

  // 7. The facts.
  const writer = writerOf(request, read, names);
  if (writer === null) throw new FrontierError("noWriter");
  const found = await factsFor(
    {
      choices: capped.choices,
      target: { businessId, bookingId: capped.target },
      handleId: request.turn.handleId,
      askedUnder: new Map(read.openQuestions.map((row) => [row.id, row.bundleId])),
      pinned: pinnedId,
      flow,
      bundles: options.bundles,
      repo,
    },
    options.facts,
  );
  if ("fault" in found) throw new FrontierError(found.fault);
  if ("error" in found) return found;

  // 8. The context.
  const context: Context = {
    turnId: request.turn.id,
    bundleId: { hash: pinnedId.hash, build: pinnedId.build },
    flow,
    texts: request.texts,
    writer,
    businessLanguage: DEFAULT_BUSINESS_LANGUAGE,
    openQuestions: assembled.openQuestions,
    choices: [first, ...rest],
    cards: assembled.cards,
    facts: found.facts,
    alwaysOn: { flow, prefixSha256: alwaysOn },
    recentMessages: [],
    meaningSearch: null,
  };
  if (checker.check("context", context).length > 0) throw new FrontierError("invalidContext");
  return { context, flagged: found.flagged, collapsedBookingIds: capped.collapsedBookingIds };
}
