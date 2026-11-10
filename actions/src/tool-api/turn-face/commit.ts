// The turn face's gate and commit (T-1141; C-074 over C-087; K-09 v1.5 gateAndCommit): T-305's one commit per turn bound
// to what it reads and calls, each port another task's, so the commit runs for real on the turn's pinned bundle:
//
//   - the limits: the flags, then limits 1 to 6 as registered (actions/src/gate/limits.ts), but for limit 1, which is given
//     the turn's bundle's step cards (STATE note 65: Limit1Deps.steps from the pinned bundle's flow graphs, read through
//     the bundles port, KV first: rosie_app holds no grant on bundle_values), so a step's side is read from its card;
//     limit 2 is T-300's as registered (no walk proposal and no K-26 read yet: a part that may carry an owner rule is
//     refused, any other passes);
//   - writesOf: T-1139's walk after the choice on the pinned bundle's flow graphs (createWritesOf({ bundles }));
//   - runCore: T-1140's createRunCore({ safety: { reader, sealer, lines, stopWords, telling } }), built for each call:
//       reader     K-05 v1.4's safety reads (T-1161): outcomeOfEvent, outcome, hold, holdOfOutcome, outboxRowWritten and
//                  businessZone on the call's own transaction (rosie_app) with the call's own business; ownerOf through
//                  readBusinessOwner, which needs the runtime side (rosie_app holds no grant on person_handles or
//                  handles: STATE note 59), in its own transaction under the call's business; notFound,
//                  moreThanOneOwner and transient thrown, never read as none (K-05 v1.4 default 61); arrivedAt null until
//                  T-1155, so a release that needs the arrival order fails closed (release.ts default 13);
//       sealer     read-only: the person's key already exists (the gateway made it at first sight, K-05 item 29), and
//                  this binding never makes one (sealer.ts);
//       lines      the pinned bundle's checked lines (pinnedSafetyLines below), under the core's line rule (lines.ts);
//       stopWords  PLUGIN_LISTS_NO_STOP_WORDS for the barbershop (K-09 v1.1 j3-safety-arrival-own-line.json), given by
//                  the wiring, never a default;
//       telling    NOT_TOLD_YET until T-319, so an outcome that must tell someone answers notBuilt;
//   - openHolds: K-05 v1.3 readOpenHolds on the call's transaction (rosie_app, the call's business), naming the turn's
//     texts whose recordSafetyOutcome is not among the request's core actions and every unread id the runtime's
//     CommitContext carries, each hold cut to K-09 safetyHold's three fields, joined with CommitContext.holds read at
//     commit time, the actor's own hold included (DL-326 note c), and CommitContext.unread kept whole (DL-133; DL-326
//     note e): any unread id holds;
//   - commitTurn: K-05 v1.1 commitTurn, the wiring's (pg: T-306's pgCommitTurn, its own runtime transaction).
//
// Every port only reads, inside the call's business scope or in a read-only runtime transaction of its own, and hands back
// what the commit is to write: a repeated turn runs them all again before K-05 answers repeated (STATE note 1). Nothing
// here logs; a throw names a read, a fault or a code, never a value.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A hold the actor keeps that PostgreSQL has not recorded (CommitContext hold with no hold id), or one still waiting
//      for its read (rule unread), holds as an unread text does: its event id joins unreadEventIds, so every part but a
//      protective one is held. A hold id is never made up, and nothing the actor holds is dropped.
//   2. The actor's hold and K-34's hold with the same id are both kept, so the stricter binds (STATE note 21).
//   3. The pinned bundle's checked lines are K-01's fixed lines it holds words for (crisis words, an emergency, Unsure by
//      its danger words, and the outage line). A bundle that holds any step of section 3 (the safety steps, whose cards
//      carry their own lines) answers notBuilt for a danger outcome's line, since their card lines are not read here yet
//      (fail closed); bundle v0 holds none (S1-01 and S1-02 only).

import type { CommitContext } from "../../../../runtime/src/actor";
import type {
  CommitDeps,
  CommitPorts,
  CommitTurnContext,
  CoreAction,
  OpenHolds,
  SafetyHold,
} from "../../commit";
import { createRunCore, type CoreSafetyDeps } from "../../commit/core";
import { createWritesOf, type WalkDeps } from "../../commit/walk";
import type {
  OwnerContact,
  SafetyLineChoice,
  SafetyLines,
  SafetyReader,
  SafetyTelling,
  StopWords,
  StoredHold,
  StoredOutcome,
  WordsSealer,
} from "../../domain/safety";
import { flowsListed } from "../../frontier/assemble/bundle";
import type { BundleId, FlowLetter, FrontierBundles } from "../../frontier/assemble/types";
import { flagsFirst } from "../../gate/flags";
import type { LimitRegistry } from "../../gate/framework";
import { createLimit1, stepCardsOf, type StepCards } from "../../gate/limit-1";
import { limit2 } from "../../gate/limit-2";
import { limit3 } from "../../gate/limit-3";
import { limit4 } from "../../gate/limit-4";
import { limit5 } from "../../gate/limit-5";
import { limit6 } from "../../gate/limit-6";
import { NotBuiltError } from "../errors";
import { TurnFaceReadError, TurnFaceRefusedError } from "./errors";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The runtime's commit-time context (runtime/src/actor/lease.ts CommitContext), handed on unchanged by the actor. */
export type CommitAt = CommitContext;

/** Nothing open at commit time: no hold and no unread text (a caller with no actor, such as a test of one call). */
export const NOTHING_OPEN_AT: CommitAt = { holds: [], unread: [] };

// ---- the K-05 reads and calls the commit binds, each the wiring's ---------------------------------------------------

/** A K-05 notFound answer (K-05 v1 notFoundError). */
export interface NotFoundAnswer {
  readonly error: "notFound";
  readonly table: string;
  readonly rowId: string;
}

/** K-05 v1.3 readOpenHolds.request (item 34). */
export interface OpenHoldsRequest {
  readonly handleId: string;
  readonly businessId: string | null;
  readonly eventIds: readonly string[];
}

/** K-05 v1.3 readOpenHolds.response, as far as the commit reads it: each hold's three safetyHold fields, the unread ids. */
export interface OpenHoldsAnswer {
  readonly result: "openHolds";
  readonly holds: readonly {
    readonly holdId: string;
    readonly releaseRule: SafetyHold["releaseRule"];
    readonly blocksBooking: boolean;
  }[];
  readonly unreadEventIds: readonly string[];
}

/**
 * K-05 v1.4's seven safety reads as the safety service's reader takes them (T-1161's db/repo/safety-reads.ts): six on the
 * call's own transaction (`repo`), each naming the call's business, and readBusinessOwner on the runtime side in a
 * transaction of its own. Each answers K-05's response or one of its errors; the binding throws on every error.
 */
export interface SafetyReads<Repo> {
  outcomeOfEvent(
    repo: Repo,
    request: { eventId: string; businessId: string },
  ): Promise<{ safetyOutcome: StoredOutcome | null } | ErrorAnswer>;
  outcome(
    repo: Repo,
    request: { outcomeId: string; businessId: string },
  ): Promise<{ safetyOutcome: StoredOutcome | null } | ErrorAnswer>;
  hold(
    repo: Repo,
    request: { holdId: string; businessId: string },
  ): Promise<{ hold: StoredHold | null } | ErrorAnswer>;
  holdOfOutcome(
    repo: Repo,
    request: { outcomeId: string; businessId: string },
  ): Promise<{ hold: StoredHold | null } | ErrorAnswer>;
  outboxRowWritten(
    repo: Repo,
    request: { outboxRowId: string; businessId: string },
  ): Promise<{ written: boolean } | ErrorAnswer>;
  businessZone(repo: Repo, request: { businessId: string }): Promise<{ timeZone: string } | ErrorAnswer>;
  /** The runtime side's read (rosie_job), in its own transaction under the business's scope. */
  businessOwner(request: { businessId: string }): Promise<{ owner: OwnerContact | null } | ErrorAnswer>;
}

/** Any K-05 error answer: an object with its own "error" code. */
export interface ErrorAnswer {
  readonly error: string;
}

/** What the commit binding reads and calls: K-05's calls and the pinned bundle. */
export interface TurnCommitBinding<Repo> {
  /** The pinned bundle's manifest and flow graphs (the frontier's port: KV, or PostgreSQL's copy on a miss). */
  readonly bundles: FrontierBundles;
  /** K-05 v1.1 commitTurn (T-306's pgCommitTurn on PostgreSQL). */
  readonly commitTurn: CommitPorts<Repo>["commitTurn"];
  /** K-05 v1.3 readOpenHolds on the call's transaction (rosie_app, the call's business). */
  readonly readOpenHolds: (repo: Repo, request: OpenHoldsRequest) => Promise<OpenHoldsAnswer | ErrorAnswer>;
  /** K-05 v1.4's safety reads. */
  readonly safetyReads: SafetyReads<Repo>;
  /** Seals a read's words under a person's key that already exists; never makes a key (sealer.ts). */
  readonly sealer: WordsSealer;
  /**
   * The plug-in's stop words, named by the wiring, never a default (domain/safety/ports.ts): PLUGIN_LISTS_NO_STOP_WORDS
   * for the barbershop, whose plug-in lists none (DL-344).
   */
  readonly stopWords: StopWords;
  /** Hand-offs and pages (T-319), named by the wiring: NOT_TOLD_YET until T-319 lands, so such an outcome is notBuilt. */
  readonly telling: SafetyTelling;
  /**
   * The safety service's other ports, as T-1140's CoreSafetyDeps names them (T-317's and T-307's readers, ids, visits).
   * Default: the service's own, on the call's transaction.
   */
  readonly safetyExtra?: Partial<
    Omit<CoreSafetyDeps<Repo>, "reader" | "sealer" | "lines" | "stopWords" | "telling">
  >;
  /** Default 131's turn key for the walk's row ids. Default: the turn's own id. */
  readonly turnKey?: WalkDeps["turnKey"];
  /** Limits 1 to 6 for a turn, given its bundle's step cards. Default: the registry with limit 1 given them. */
  readonly limits?: (steps: (bundleId: BundleId, flow: FlowLetter) => StepCards) => LimitRegistry<Repo>;
}

// ---- openHolds: K-05 readOpenHolds joined with the runtime's commit-time context ------------------------------------

/** The four K-34 release rules a safetyHold takes (K-09 v1 safetyHold.releaseRule). */
const RELEASE_RULES: readonly string[] = ["at_once", "when_private", "after_safe", "never"];

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** The event ids whose recordSafetyOutcome rides among the request's core actions (their outcome is this commit's). */
function recordedInThisCommit(core: readonly CoreAction[]): ReadonlySet<string> {
  const recorded = new Set<string>();
  for (const action of core) {
    if (action.call !== "recordSafetyOutcome") continue;
    const safety: unknown = (action.request as { safety?: unknown }).safety;
    if (isRecord(safety) && typeof safety.eventId === "string") recorded.add(safety.eventId);
  }
  return recorded;
}

/** The actor's holds as the commit reads them (defaults 1 and 2): K-34 holds by id, every other one as an unread text. */
function actorHolds(at: CommitAt): { holds: SafetyHold[]; unread: string[] } {
  const holds: SafetyHold[] = [];
  const unread: string[] = [];
  for (const hold of at.holds) {
    if (hold.holdId !== null && RELEASE_RULES.includes(hold.rule)) {
      holds.push({
        holdId: hold.holdId,
        releaseRule: hold.rule as SafetyHold["releaseRule"],
        blocksBooking: hold.blocksBooking,
      });
    } else {
      unread.push(hold.eventId);
    }
  }
  return { holds, unread };
}

/**
 * The commit's openHolds port for one call: readOpenHolds on the call's transaction under its business, naming the
 * turn's texts whose outcome does not ride in this commit and the runtime's unread ids, joined with what the runtime
 * holds at commit time (`at`). A read that answers an error fails the call closed.
 */
export function openHoldsPort<Repo>(
  at: CommitAt,
  readOpenHolds: TurnCommitBinding<Repo>["readOpenHolds"],
): CommitPorts<Repo>["openHolds"] {
  return async (turn: CommitTurnContext<Repo>): Promise<OpenHolds> => {
    const recorded = recordedInThisCommit(turn.request.core);
    const eventIds = unique([...turn.turn.eventIds.filter((id) => !recorded.has(id)), ...at.unread]);
    const answer = await readOpenHolds(turn.repo, {
      handleId: turn.turn.handleId,
      businessId: turn.businessId,
      eventIds,
    });
    if ("error" in answer) throw new TurnFaceReadError("readOpenHolds", answer.error);
    const actor = actorHolds(at);
    return {
      holds: [
        ...answer.holds.map((hold) => ({
          holdId: hold.holdId,
          releaseRule: hold.releaseRule,
          blocksBooking: hold.blocksBooking,
        })),
        ...actor.holds,
      ],
      unreadEventIds: unique([...answer.unreadEventIds, ...at.unread, ...actor.unread]),
    };
  };
}

// ---- runCore's safety reader over K-05 v1.4 ---------------------------------------------------------------------------

/** A read's answer, or its error thrown (default 61 of K-05 v1.4: an error is never read as none). */
function answered<T extends object>(read: string, answer: T | ErrorAnswer): T {
  if ("error" in answer) throw new TurnFaceReadError(read, answer.error);
  return answer;
}

/**
 * The safety service's reader for one call: every read names the call's own business, the In reads on the call's
 * transaction, the owner on the runtime side; arrivedAt null until T-1155 (release.ts default 13: fail closed).
 */
export function safetyReaderOf<Repo>(reads: SafetyReads<Repo>, repo: Repo, businessId: string): SafetyReader {
  return {
    async outcomeOfEvent(eventId) {
      return answered("readSafetyOutcomeOfEvent", await reads.outcomeOfEvent(repo, { eventId, businessId }))
        .safetyOutcome;
    },
    async outcome(outcomeId) {
      return answered("readSafetyOutcome", await reads.outcome(repo, { outcomeId, businessId }))
        .safetyOutcome;
    },
    async hold(holdId) {
      return answered("readSafetyHold", await reads.hold(repo, { holdId, businessId })).hold;
    },
    async holdOfOutcome(outcomeId) {
      return answered("readSafetyHoldOfOutcome", await reads.holdOfOutcome(repo, { outcomeId, businessId }))
        .hold;
    },
    async outboxRowWritten(rowId) {
      return answered(
        "readOutboxRowWritten",
        await reads.outboxRowWritten(repo, { outboxRowId: rowId, businessId }),
      ).written;
    },
    async ownerOf(asked) {
      // Only the call's own business is read: the service names it (record.ts lineRows), and another is refused.
      if (asked !== businessId) throw new TurnFaceReadError("readBusinessOwner", "otherBusiness");
      return answered("readBusinessOwner", await reads.businessOwner({ businessId })).owner;
    },
    async businessZone(asked) {
      if (asked !== businessId) throw new TurnFaceReadError("readBusinessZone", "otherBusiness");
      return answered("readBusinessZone", await reads.businessZone(repo, { businessId })).timeZone;
    },
    arrivedAt: () => Promise.resolve(null),
  };
}

// ---- the pinned bundle's checked lines (default 3) and step cards (STATE note 65) ------------------------------------

/** K-01 v1's fixed lines a manifest holds words for (status asWritten, text given), by id. */
function heldFixedLines(manifest: Json): ReadonlySet<string> {
  const lists = isRecord(manifest.lists) ? manifest.lists : {};
  const fixedLines = isRecord(lists.fixedLines) ? lists.fixedLines : {};
  const lines: unknown[] = Array.isArray(fixedLines.lines) ? fixedLines.lines : [];
  return new Set(
    lines.flatMap((line) =>
      isRecord(line) &&
      typeof line.id === "string" &&
      line.status === "asWritten" &&
      typeof line.text === "string"
        ? [line.id]
        : [],
    ),
  );
}

/** The step ids one K-01 v1 flow graph holds. */
function stepIdsOf(graph: unknown): string[] {
  return isRecord(graph) && isRecord(graph.steps) ? Object.keys(graph.steps) : [];
}

/** A section 3 step (the safety steps A3-xx and their flow B twins B3-xx), whose card carries its own checked line. */
const SAFETY_SECTION = /^[AB]3-/u;

/** The pinned bundle's manifest, refused when neither KV nor PostgreSQL's copy holds it. */
async function manifestOf(bundles: FrontierBundles, bundleId: BundleId): Promise<Json> {
  const manifest = await bundles.manifest(bundleId);
  if (!isRecord(manifest)) throw new TurnFaceRefusedError("bundleMissing");
  return manifest;
}

/**
 * The checked lines of the turn's pinned bundle (default 3): K-01's crisis, emergency and outage lines it holds words
 * for, each to the writer; a danger outcome's line is refused (notBuilt) when the bundle holds a safety step, whose own
 * card line is not read here yet. The core's line rule goes on top (commit/core/lines.ts coreSafetyLines).
 */
export async function pinnedSafetyLines(bundles: FrontierBundles, bundleId: BundleId): Promise<SafetyLines> {
  const manifest = await manifestOf(bundles, bundleId);
  const held = heldFixedLines(manifest);
  const graphs = await Promise.all(flowsListed(manifest).map((flow) => bundles.flow(bundleId, flow)));
  const holdsSafetyStep = graphs.some((graph) => stepIdsOf(graph).some((id) => SAFETY_SECTION.test(id)));
  const line = (fixedLineId: string): SafetyLineChoice | null =>
    held.has(fixedLineId) ? { fixedLineId, to: "writer", hotline: null } : null;
  return {
    lineOf(outcome, wordKinds) {
      if (outcome === "No") return null;
      if (holdsSafetyStep) throw new NotBuiltError("recordSafetyOutcome");
      switch (outcome) {
        case "Crisis words":
          return line("safetyCrisis");
        case "An emergency":
          return line("safetyEmergency");
        case "Unsure":
          return line(wordKinds.includes("selfHarm") ? "safetyCrisis" : "safetyEmergency");
        default:
          return null;
      }
    },
    outageLine: () => (held.has("outage") ? "outage" : null),
  };
}

/**
 * Limit 1's step cards for a turn (STATE note 65; T-299's Limit1Deps.steps): the turn's bundle's flow graphs it lists,
 * the context's flow first, read once when limit 1 first asks for a step. A bundle that cannot be read gives no card, so
 * every step's side is the business's (DL-188 ruling 1; fails closed).
 */
export function bundleStepCards(
  bundles: FrontierBundles,
): (bundleId: BundleId, flow: FlowLetter) => StepCards {
  return (bundleId, flow) => {
    let cards: Promise<StepCards> | null = null;
    const load = async (): Promise<StepCards> => {
      const manifest = await bundles.manifest(bundleId);
      if (!isRecord(manifest)) return stepCardsOf([]);
      const listed = flowsListed(manifest);
      const other: FlowLetter = flow === "A" ? "B" : "A";
      const order = [flow, other].filter((each) => listed.includes(each));
      return stepCardsOf(await Promise.all(order.map((each) => bundles.flow(bundleId, each))));
    };
    return { step: async (stepId) => (await (cards ??= load())).step(stepId) };
  };
}

/** The flags, then limits 1 to 6 as registered, limit 1 given the turn's bundle's step cards (STATE note 65). */
export function turnLimits<Repo>(
  steps: (bundleId: BundleId, flow: FlowLetter) => StepCards,
): LimitRegistry<Repo> {
  return flagsFirst([createLimit1({ steps }), limit2, limit3, limit4, limit5, limit6]);
}

// ---- the commit's deps for one call -----------------------------------------------------------------------------------

/**
 * The commit's deps for one gateAndCommit call, given the runtime's commit-time context: the limits, writesOf, runCore,
 * openHolds and commitTurn as the top of this file binds them.
 */
export function turnCommitDeps<Repo>(binding: TurnCommitBinding<Repo>): (at: CommitAt) => CommitDeps<Repo> {
  const { bundles } = binding;
  const steps = bundleStepCards(bundles);
  const writesOf = createWritesOf<Repo>({
    bundles,
    ...(binding.turnKey === undefined ? {} : { turnKey: binding.turnKey }),
  });
  const limitsOf = binding.limits ?? turnLimits;
  return (at) => {
    const runCore: CommitPorts<Repo>["runCore"] = async (action, turn, open) => {
      const lines = await pinnedSafetyLines(bundles, turn.turn.bundleId);
      const run = createRunCore<Repo>({
        safety: {
          ...binding.safetyExtra,
          reader: (repo) => safetyReaderOf(binding.safetyReads, repo, turn.businessId),
          sealer: () => binding.sealer,
          lines,
          stopWords: binding.stopWords,
          telling: binding.telling,
        },
      });
      return run(action, turn, open);
    };
    return {
      limits: limitsOf(steps),
      ports: {
        commitTurn: binding.commitTurn,
        writesOf,
        runCore,
        openHolds: openHoldsPort(at, binding.readOpenHolds),
      },
    };
  };
}
