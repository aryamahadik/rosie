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
// flag (./skeleton.ts). Every other port of the Worker's environments stays closed: each call fails, as
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
  { port: "sealing", test: "fake", staging: "closed", production: "closed" }, // T-553
  { port: "safetyRead", test: "fake", staging: "closed", production: "closed" }, // T-554
  { port: "stateReads", test: "fake", staging: "closed", production: "closed" }, // T-555 to T-557, T-562, T-564
  { port: "turnFace", test: "fake", staging: "closed", production: "closed" }, // T-557, T-559, T-560
  { port: "decide", test: "fake", staging: "closed", production: "closed" }, // T-558
  { port: "composer", test: "fake", staging: "closed", production: "closed" }, // T-560
  { port: "finalize", test: "fake", staging: "closed", production: "closed" }, // T-561
  { port: "dataAccess", test: "fake", staging: "closed", production: "closed" }, // T-555, T-562, T-564
  { port: "linqSend", test: "fake", staging: "closed", production: "closed" }, // T-563
];

/**
 * The Worker's environment from its ENVIRONMENT var (factory spec 6): "staging" is staging; anything else is production,
 * the stricter of the two. A Worker is never the test environment: only a test asks for it.
 */
export function environmentOf(vars: { readonly ENVIRONMENT: string }): Exclude<Environment, "test"> {
  return vars.ENVIRONMENT === "staging" ? "staging" : "production";
}
