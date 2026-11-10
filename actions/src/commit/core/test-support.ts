// Doubles and fixtures for runCore's tests (T-1140). Never imported by the Worker. The doubles stand in for the safety
// service's ports only (DL-341: K-34's reads, the sealer, the pinned bundle's lines, the stop words, who is told), never
// for runCore or the service under test: T-318's in-memory world (domain/safety/test-support.ts), a sealer whose bytes
// depend only on what it seals (DL-330), and the pinned bundle's checked lines read from bundle v0's own files. Values come
// only from the contracts' fixtures, bundle v0 and the master's sample cast, in the 555-01xx range (rule 9).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1";
import {
  PLUGIN_LISTS_NO_STOP_WORDS,
  type SafetyLines,
  type SafetyOutcome,
  type WordsSealer,
} from "../../domain/safety";
import { flagsReaderOn, messagesReaderOn } from "../../domain/flags/test-support";
import {
  BARBERSHOP,
  fakeTelling,
  fixtureSafetyIds,
  safetyReaderOn,
  type SafetyWorld,
} from "../../domain/safety/test-support";
import { copy, gateExchange } from "../../gate/framework/test-support";
import type { CommitTurnContext, GateAndCommitRequest, TurnRow } from "../types";
import type { CoreDeps, CoreSafetyDeps } from "./core";

// ---------------------------------------------------------------------------------------------------------------
// The sealer

export interface SealCall {
  readonly plaintext: string;
  readonly forPersonId: string;
  readonly bytes: Uint8Array;
}

export interface SameSealer extends WordsSealer {
  /** Every seal asked for, in order. */
  readonly calls: SealCall[];
}

const encoder = new TextEncoder();

/**
 * A sealer whose bytes depend only on whom and what it seals (DL-330): a format byte and the first 16 bytes of the SHA-256
 * of the person's id and the words, never the words themselves. A real seal differs on every run (a fresh IV), so only
 * with this double can a run be compared with its rerun.
 */
export function sameSealer(): SameSealer {
  const calls: SealCall[] = [];
  return {
    calls,
    async seal(plaintext, forPersonId) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify([forPersonId, plaintext])),
      );
      const bytes = Uint8Array.from([0x01, ...new Uint8Array(digest).slice(0, 16)]);
      calls.push({ plaintext, forPersonId, bytes });
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The pinned bundle: bundle v0 (T-163), partial, flow A holding S1-01 and S1-02 only

const BUNDLE_V0_DIR = fileURLToPath(new URL("../../../../bundles/v0/bundle/", import.meta.url));

/** The flow A steps whose checked line each danger outcome sends (MASTER-FLOW-A.md A3-23 to A3-26, A3-48 to A3-50). */
export const SAFETY_STEP_OF: Readonly<Record<Exclude<SafetyOutcome, "No" | "Unsure">, string>> = {
  "Safety steps, then go on": "A3-23",
  "An emergency": "A3-24",
  "Crisis words": "A3-25",
  "Needs the business's own line": "A3-26",
  "A threat to staff or others": "A3-48",
  "Harm to a child or older adult": "A3-49",
  "Unsafe at home": "A3-50",
};

/** A bundle as its files hold it: what the safety lines read of it. */
export interface PinnedBundle {
  readonly bundleId: { readonly hash: string; readonly build: number };
  readonly partial: boolean;
  /** The K-01 fixed lines it holds words for (status asWritten), by id. */
  readonly fixedLines: ReadonlySet<string>;
  /** The steps its flow A holds, by id. */
  readonly stepsA: ReadonlySet<string>;
}

interface ManifestFile {
  readonly bundleId: { readonly hash: string; readonly build: number };
  readonly partial?: boolean;
  readonly lists: {
    readonly fixedLines: {
      readonly lines: readonly {
        readonly id: string;
        readonly text: string | null;
        readonly status: string;
      }[];
    };
  };
}

interface FlowFile {
  /** The flow's steps, keyed by step id. */
  readonly steps: Readonly<Record<string, unknown>>;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8")) as unknown;

/** Bundle v0 as bundles/v0/bundle holds it (its manifest and flow A). */
export function bundleV0(): PinnedBundle {
  const manifest = readJson(`${BUNDLE_V0_DIR}manifest.json`) as ManifestFile;
  const flowA = readJson(`${BUNDLE_V0_DIR}flow/A.json`) as FlowFile;
  return {
    bundleId: { ...manifest.bundleId },
    partial: manifest.partial === true,
    fixedLines: new Set(
      manifest.lists.fixedLines.lines
        .filter((line) => line.status === "asWritten" && line.text !== null)
        .map((line) => line.id),
    ),
    stepsA: new Set(Object.keys(flowA.steps)),
  };
}

/**
 * A pinned bundle's checked lines as the safety service's port reads them (domain/safety/ports.ts SafetyLines), for a
 * bundle with no safety step: K-01 v1's own fixed lines only, each to the writer, and only those the bundle holds words
 * for (crisis words, an emergency, and Unsure by its danger words, as FIXED_SAFETY_LINES gives them); any other outcome has
 * no line of its own. It reads no step's line: a bundle that holds a safety step fails loudly here.
 */
export function bundleLines(bundle: PinnedBundle): SafetyLines {
  const held = (fixedLineId: string) =>
    bundle.fixedLines.has(fixedLineId) ? { fixedLineId, to: "writer" as const, hotline: null } : null;
  return {
    lineOf(outcome, wordKinds) {
      if (outcome !== "No" && outcome !== "Unsure" && bundle.stepsA.has(SAFETY_STEP_OF[outcome])) {
        throw new Error(`this double reads no step's line, and the bundle holds ${SAFETY_STEP_OF[outcome]}`);
      }
      switch (outcome) {
        case "Crisis words":
          return held("safetyCrisis");
        case "An emergency":
          return held("safetyEmergency");
        case "Unsure":
          return held(wordKinds.includes("selfHarm") ? "safetyCrisis" : "safetyEmergency");
        default:
          return null;
      }
    },
    outageLine: () => (bundle.fixedLines.has("outage") ? "outage" : null),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The skeleton's turn 1: K-09 v1.5 commit-s1-01.json (T-1142; DL-322)

export const S1_01 = "commit-s1-01.json";

/** The ids commit-s1-01.json names for Sam's text's record; every other row takes the Worker's keyed id. */
export const S1_01_IDS = fixtureSafetyIds({ "evt-sam-s1-01": { outcome: "safety-outcome-sam-s1-01" } });

/** commit-s1-01.json, freshly parsed: its request carries the turn's service and chat id (K-09 v1.5 default 135). */
export function s1_01Exchange(): K09.GateAndCommitExchange {
  return gateExchange(S1_01);
}

/**
 * K-05 v1's turn row of a K-09 turn: its seven fields alone (K-05 v1 turn), without K-09 v1.5's service and chat id, which
 * the commit never writes (DL-340: T-1150 makes the commit write the seven fields itself).
 */
export function k05Turn(turn: TurnRow): TurnRow {
  const { id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries } = turn;
  return copy({ id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries });
}

/** A request with its turn row as K-05 v1 writes it (k05Turn), so the K-05 fake takes the commit it builds. */
export function withK05Turn(request: GateAndCommitRequest): GateAndCommitRequest {
  const next = copy(request);
  if (next.turn !== null) next.turn = k05Turn(next.turn);
  return next;
}

/** The turn as the commit hands it to runCore, inside the call's business scope. */
export function turnContextOf(request: GateAndCommitRequest, businessId = BARBERSHOP): CommitTurnContext {
  if (request.turn === null) throw new Error("the request carries its turn");
  return { request, turn: k05Turn(request.turn), repo: { name: "core-test-repo" }, businessId };
}

// ---------------------------------------------------------------------------------------------------------------
// runCore's ports over the safety world

export interface CoreDoubles {
  readonly deps: CoreDeps<unknown>;
  readonly sealer: SameSealer;
}

/**
 * Every port the safety service reads, over T-318's world under the barbershop's scope: K-34's reads, T-317's and T-307's
 * reads, the same-bytes sealer, bundle v0's lines, the barbershop's plug-in, which lists no stop words (K-09 v1.1
 * j3-safety-arrival-own-line.json), and T-319's hand-offs and pages as T-318's double. `extra` replaces any of them.
 */
export function coreDoublesOn(world: SafetyWorld, extra: Partial<CoreSafetyDeps<unknown>> = {}): CoreDoubles {
  const sealer = sameSealer();
  const safety: CoreSafetyDeps<unknown> = {
    reader: () => safetyReaderOn(world, BARBERSHOP),
    flagsReader: () => flagsReaderOn(world.flags, BARBERSHOP),
    messagesReader: () => messagesReaderOn(world.flags, BARBERSHOP),
    sealer: () => sealer,
    ids: S1_01_IDS,
    lines: bundleLines(bundleV0()),
    stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
    telling: fakeTelling(),
    ...extra,
  };
  return { deps: { safety }, sealer };
}
