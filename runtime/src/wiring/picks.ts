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
// every targets read there fails closed. Every other port of the Worker's environments stays closed: each call fails, as
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
  { port: "stateReads", test: "fake", staging: "closed", production: "closed" }, // T-557, T-562, T-564
  { port: "turnFace", test: "fake", staging: "closed", production: "closed" }, // T-557, T-559, T-560
  { port: "decide", test: "fake", staging: "closed", production: "closed" }, // T-558
  { port: "composer", test: "fake", staging: "closed", production: "closed" }, // T-560
  { port: "finalize", test: "fake", staging: "closed", production: "closed" }, // T-561
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
