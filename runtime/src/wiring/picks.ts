// Which implementation each port takes in each environment (T-550): the one table the composition root reads and each
// join (T-552 to T-564) edits, one line per port, in D-017's turn order (./ports.ts).
//
//   test        Vitest and CI: every port on its fake, the doubles the runtime's own tests use (./test-support.ts), but a
//               joined port on its real package, fed by those doubles.
//   staging     the Worker under env.staging (wrangler.jsonc vars: ENVIRONMENT "staging", BASE_PATH "/test").
//   production  the Worker anywhere else (ENVIRONMENT "production", or a value the root does not know).
//
// A join swaps one line's test and staging picks for the real package's implementation (./real.ts, the set the root
// builds itself); production's waits for the release that takes it there. Joined so far: linqVerify (T-552), the Linq
// adapter's verify, fed by the Linq double's signer in a test and by LINQ_WEBHOOK_SECRET on staging, behind the skeleton
// flag (./skeleton.ts); sealing (T-553), K-05 v1.2 handleSealingKey with its database bound, fed by the K-05 double in a
// test and by no database on staging until T-567, so every seal there fails closed; safetyRead (T-554), @rosie/ai's
// safety read, over the recorded-model double in a test and over no reader on staging until the bundle's manifest and
// the model key can be read there, so every read there fails closed and the actor applies its no-verdict rule; turnRow
// (T-555), K-05's commitTurn and parkTurn with their database bound, the two calls that write a turn's one row under the
// turn id the lease hashed, fed by the K-05 double in a test and by no database on staging until T-567, so every commit
// and park there fails closed; bundles and targets (T-556), K-05 v1 item 7's bundle reads and K-05 v1.2 handleTargets
// with their database bound, the turn's pin (so the guard's keyword list is the pinned bundle's) and the guard's
// targets, fed in a test by the K-05 doubles (bundle v0 as bundles/v0 publishes it; test owner 1's seeded rows answering
// as targets-first-text.json) and by no database on staging until T-567 (and no BUNDLES until T-566), so every pin and
// every targets read there fails closed; frontier (T-557), K-09 buildFrontier through @rosie/actions' turn face over the
// turn's pinned bundle and K-05 v1.2 readTurnState as rosie_job under the call's business scope, fed in a test by the
// K-05 double over test owner 1's seeded rows (T-1148) and by no database on staging until T-567, so every frontier
// there fails closed; decide (T-558), @rosie/ai's two reads and its one Sonnet re-read, one decider per bundle, over the
// recorded-model double in a test and over no decider on staging until the bundle's manifest and flows and the model key
// can be read there (J-02), so every decide and re-read there fails closed before any model call; gate (T-559), K-09
// gateAndCommit through @rosie/actions' turn face (the gate, then one K-05 commitTurn through the turn-row port, under the
// turn id, on the turn's pinned bundle), its reads fed in a test by the K-05 doubles over test owner 1's seeded rows and
// by no database on staging until T-567, so every gate there fails closed and nothing commits; composeInput (T-560), K-09
// composeInput through @rosie/actions' turn face (each committed row's K-03 composer input from K-05 v1.6 readOutboxRow
// and the row's pinned bundle, its inbound text the words the turn's gate request handed in), fed in a test by a K-05
// double over the rows the commit wrote and test owner 1's seeded rows and by no database on staging until T-567, so
// every compose input there fails closed; and composer (T-560), @rosie/ai's composer and its one rewrite, one per bundle,
// over the recorded-model double in a test and over no composer on staging until the bundle's manifest and the model key
// can be read there (J-02), so every compose and rewrite there fails closed before any model call; and finalize (T-561),
// K-09 finalizeMessage through @rosie/actions' turn face (T-313's finalize with T-314's fixed lines, the claim check and
// the message checks, over K-05 v1.6 readOutboxRow and v1.3 readFixedLineFacts and the row's pinned bundle, the plan and
// final parts written into the row by T-196's writePlan), fed in a test by K-05 doubles over the rows the commit wrote and
// test owner 1's seeded rows and by no database on staging until T-567, so every finalize there fails closed and nothing
// is written. Every other port of the Worker's environments stays closed: each call fails, as
// `unconfiguredGateway` did before, so a webhook that gets past the verify still answers 503. The fakes never reach a
// Worker bundle: they are test code (the runtime's test-support files are "Not imported by the Worker"; the Linq double is
// "test code only, never in a Worker bundle"), so only a test hands the root its fake set.

import type { PortName } from "./ports";

export const ENVIRONMENTS = ["test", "staging", "production"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * fake: the test doubles. real: the real package, joined (./real.ts). closed: not joined in this environment, so every
 * call fails (./closed.ts).
 */
export type ImplementationName = "fake" | "real" | "closed";

/** One port's implementation in each environment. */
export interface PortPick {
  readonly port: PortName;
  readonly test: ImplementationName;
  readonly staging: ImplementationName;
  readonly production: ImplementationName;
}

/** One line per port, in D-017's turn order; the join that swaps it is named beside it. */
export const PICKS: readonly PortPick[] = [
  { port: "linqVerify", test: "real", staging: "real", production: "closed" }, // T-552
  { port: "sealing", test: "real", staging: "real", production: "closed" }, // T-553
  { port: "safetyRead", test: "real", staging: "real", production: "closed" }, // T-554
  { port: "turnRow", test: "real", staging: "real", production: "closed" }, // T-555
  { port: "bundles", test: "real", staging: "real", production: "closed" }, // T-556
  { port: "targets", test: "real", staging: "real", production: "closed" }, // T-556
  { port: "frontier", test: "real", staging: "real", production: "closed" }, // T-557
  { port: "stateReads", test: "fake", staging: "closed", production: "closed" }, // T-562, T-564
  { port: "turnFace", test: "fake", staging: "closed", production: "closed" }, // no D-017 hop
  { port: "decide", test: "real", staging: "real", production: "closed" }, // T-558
  { port: "gate", test: "real", staging: "real", production: "closed" }, // T-559
  { port: "composeInput", test: "real", staging: "real", production: "closed" }, // T-560
  { port: "composer", test: "real", staging: "real", production: "closed" }, // T-560
  { port: "finalize", test: "real", staging: "real", production: "closed" }, // T-561
  { port: "dataAccess", test: "fake", staging: "closed", production: "closed" }, // T-562, T-564
  { port: "linqSend", test: "fake", staging: "closed", production: "closed" }, // T-563
];

/**
 * The Worker's environment from its ENVIRONMENT var (factory spec 6): "staging" is staging; anything else is production,
 * the stricter of the two. A Worker is never the test environment: only a test asks for it.
 */
export function environmentOf(vars: { readonly ENVIRONMENT: string }): Exclude<Environment, "test"> {
  return vars.ENVIRONMENT === "staging" ? "staging" : "production";
}
