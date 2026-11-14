// stagingOptions(env): the RootOptions inputs staging gives (T-1257; the D-017 path audit's P1a, its wiring part:
// ops/reviews/D-017-path-audit/order_d017.txt line 29; critic_size B3, B9, N1 and N3; critic_collisions B2, B6, B7, N1 and
// N4; the lead's notes DL-757 and DL-760). The Worker's root (../root.ts workerRoot) spreads them into its options.
//
// The environment first: before any binding is read, ENVIRONMENT must be staging (../picks.ts environmentOf). Anywhere else
// (production, or a value the root does not know) it reads nothing more and gives every input null (critic_collisions N1:
// env.production binds a HYPERDRIVE of its own, and flags, testPhone and copies are no ports, so picks.ts closes nothing
// for them). On staging it makes the root's one database handle (./part.ts stagingDb over T-1254's ./db.ts, which reads
// each binding's connection string at each call, never here) and hands each later part of T-1154 its part: the env, the
// handle, and what that part's builder names. It binds no port by itself: each part fills its own input in its own file,
// and is null until then, so each port fails closed exactly as it does with nothing bound. Making them reads nothing but
// ENVIRONMENT.
//
// The parts, in the order they are built (each file says what it gives and what its null does until then):
//   ./k05-receipt.ts    T-1394 (P2a)  handleKey, chatOpenCall; handed the SEALING_WRAP_KEY-only resolver (./secrets.ts)
//   ./k05-turn.ts       T-1395 (P2b)  bundleReads, handleTargets, frontierScope, turnRows
//   ./models.ts         T-1396 (P3a)  safetyReaders, deciders, composers; handed P2b's bundleReads, the actor's BUNDLES KV
//                                     and the fetch seam (DL-757; critic_collisions B6a, critic_size B9)
//   ./bundle-safety.ts  T-1397 (P3b)  bundleSafety, the one BundleSafety adapter, which the root hooks at the pin (Root.pin)
//                                     and reads as the safety read's lines; handed BUNDLES and P2b's bundleReads
//   ./tool-api-gate.ts  T-1398 (P4a)  gateReads; handed the resolver and that same adapter, for SafetyDeps.words (DL-757)
//   ./tool-api-rows.ts  T-1399 (P4b)  composeReads, finalizeData, planCalls
//   ./state-reads.ts    T-1400 (SR)   turnDirectory (handleDirectory and stoppedFlags wait for a K-05 version)
//   ./send.ts           T-1401 (P5)   outboxCalls, sendStateCall, linqSendCall, armingCalls, all or nothing
//   ./flags.ts          T-1393 (P1c)  flags
//   ./test-phone.ts     T-1305 (P6b)  testPhone
//   ./copies.ts         T-1306 (P6c)  copies, which install() sets (`setCopyDeps`)
// The three seams critic_collisions B6 names are made here: the model readers' manifest access (P2b's bundle reads handed to
// ./models.ts), the BundleSafety hook at the pin (RootOptions.bundleSafety, checked at each pin: ../real.ts checkedPin) and
// the copy deps in install() (RootOptions.copies). The first text into a fresh isolate's lines (DL-757's option (c)) is
// T-1397's own seam in ../real.ts and ../root.ts.
//
// Never logged or put in an error here: a binding, a connection string, a secret's value, a number or a word.

import type { FetchLike } from "@rosie/ai/src/gateway/types";

import { bundleKvOf } from "../../bundle/kv";
import { environmentOf } from "../picks";
import type { RootOptions } from "../root";
import { stagingBundleSafety } from "./bundle-safety";
import { stagingCopies } from "./copies";
import { stagingFlags } from "./flags";
import { stagingReceiptCalls } from "./k05-receipt";
import { stagingTurnCalls } from "./k05-turn";
import { stagingModels } from "./models";
import { stagingDb, type StagingDb, type StagingEnv, type StagingPart } from "./part";
import { sealingWrapKeys } from "./secrets";
import { stagingSendCalls } from "./send";
import { stagingDirectories } from "./state-reads";
import { stagingTestPhone } from "./test-phone";
import { stagingGateReads } from "./tool-api-gate";
import { stagingRowCalls } from "./tool-api-rows";

/** The RootOptions inputs staging's parts give: every database call's, model reader's, line's and flag's. */
export type StagingInputName =
  | "handleKey"
  | "chatOpenCall"
  | "safetyReaders"
  | "turnRows"
  | "bundleReads"
  | "handleTargets"
  | "frontierScope"
  | "bundleSafety"
  | "handleDirectory"
  | "stoppedFlags"
  | "turnDirectory"
  | "deciders"
  | "gateReads"
  | "composeReads"
  | "composers"
  | "finalizeData"
  | "outboxCalls"
  | "sendStateCall"
  | "planCalls"
  | "linqSendCall"
  | "armingCalls"
  | "flags"
  | "testPhone"
  | "copies";

/** Each of those inputs, null where it is not bound. */
export type StagingInputs = Required<Pick<RootOptions, StagingInputName>>;

/** Every input null: production's, and staging's while no part has bound its input. */
export const NO_STAGING_INPUTS: StagingInputs = Object.freeze({
  handleKey: null,
  chatOpenCall: null,
  safetyReaders: null,
  turnRows: null,
  bundleReads: null,
  handleTargets: null,
  frontierScope: null,
  bundleSafety: null,
  handleDirectory: null,
  stoppedFlags: null,
  turnDirectory: null,
  deciders: null,
  gateReads: null,
  composeReads: null,
  composers: null,
  finalizeData: null,
  outboxCalls: null,
  sendStateCall: null,
  planCalls: null,
  linqSendCall: null,
  armingCalls: null,
  flags: null,
  testPhone: null,
  copies: null,
});

/** Each part's builder, as its own file exports it. */
export interface StagingBuilders {
  readonly receipt: typeof stagingReceiptCalls;
  readonly turn: typeof stagingTurnCalls;
  readonly models: typeof stagingModels;
  readonly bundleSafety: typeof stagingBundleSafety;
  readonly gate: typeof stagingGateReads;
  readonly rows: typeof stagingRowCalls;
  readonly directories: typeof stagingDirectories;
  readonly send: typeof stagingSendCalls;
  readonly flags: typeof stagingFlags;
  readonly testPhone: typeof stagingTestPhone;
  readonly copies: typeof stagingCopies;
}

/** The parts' builders the Worker runs: each part's own. */
export const STAGING_BUILDERS: StagingBuilders = Object.freeze({
  receipt: stagingReceiptCalls,
  turn: stagingTurnCalls,
  models: stagingModels,
  bundleSafety: stagingBundleSafety,
  gate: stagingGateReads,
  rows: stagingRowCalls,
  directories: stagingDirectories,
  send: stagingSendCalls,
  flags: stagingFlags,
  testPhone: stagingTestPhone,
  copies: stagingCopies,
});

export interface StagingSeams {
  /**
   * Every model call's fetch, handed to ./models.ts (critic_size B9: P3a's proof answers its calls through a double). Left
   * out: the global fetch, read at each call.
   */
  readonly fetch?: FetchLike;
  /** The handle every part's calls run on. Left out: ./part.ts stagingDb(env), one for this root. */
  readonly db?: StagingDb;
  /** The parts' builders. Left out: each part's own (STAGING_BUILDERS); a test may stand one in to see what it is handed. */
  readonly builders?: Partial<StagingBuilders>;
}

/** The global fetch, read at each call (never kept when the root is built). */
const globalFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * The RootOptions inputs staging gives. Anywhere but staging: every input null, and nothing read but ENVIRONMENT. On
 * staging: each later part's input as its own file builds it over the root's one handle, null until that part binds it;
 * nothing is read to make them but ENVIRONMENT (each part reads its bindings and secrets at its own calls).
 */
export function stagingOptions(env: StagingEnv, seams: StagingSeams = {}): StagingInputs {
  if (environmentOf(env) !== "staging") return NO_STAGING_INPUTS;
  const build: StagingBuilders = { ...STAGING_BUILDERS, ...seams.builders };
  const part: StagingPart = { env, db: seams.db ?? stagingDb(env) };
  const keys = sealingWrapKeys(env);
  const kv = (): ReturnType<typeof bundleKvOf> => bundleKvOf(env.BUNDLES);

  const receipt = build.receipt({ ...part, keys });
  const turn = build.turn(part);
  const models = build.models({
    ...part,
    bundleReads: turn.bundleReads,
    kv,
    fetch: seams.fetch ?? globalFetch,
  });
  // The one BundleSafety adapter: RootOptions.bundleSafety and the gate's SafetyDeps.words are this same instance.
  const bundleSafety = build.bundleSafety({ ...part, kv, bundleReads: turn.bundleReads });
  const gateReads = build.gate({ ...part, keys, bundleSafety });
  const rows = build.rows(part);
  const directories = build.directories(part);
  const send = build.send(part);

  return {
    handleKey: receipt.handleKey,
    chatOpenCall: receipt.chatOpenCall,
    safetyReaders: models.safetyReaders,
    turnRows: turn.turnRows,
    bundleReads: turn.bundleReads,
    handleTargets: turn.handleTargets,
    frontierScope: turn.frontierScope,
    bundleSafety,
    handleDirectory: directories.handleDirectory,
    stoppedFlags: directories.stoppedFlags,
    turnDirectory: directories.turnDirectory,
    deciders: models.deciders,
    gateReads,
    composeReads: rows.composeReads,
    composers: models.composers,
    finalizeData: rows.finalizeData,
    outboxCalls: send.outboxCalls,
    sendStateCall: send.sendStateCall,
    planCalls: rows.planCalls,
    linqSendCall: send.linqSendCall,
    armingCalls: send.armingCalls,
    flags: build.flags(part),
    testPhone: build.testPhone(part),
    copies: build.copies(part),
  };
}
