// The AI provider down (T-271; C-174): the outage line once per waiting text, never to a stopped number, the turn's
// retries every 30 s, and the return order of its commit (danger, stops, then the rest). The turn loop runs through it
// (runtime/src/turn `runTurnThroughOutage`); D-017 joins its ports with `setOutageDeps`.

export {
  inReturnOrder,
  MODELS_DOWN,
  OUTAGE_LINE_ID,
  outageLineRequest,
  RETRY_MS,
  runThroughOutage,
  setOutageDeps,
  type LeaseView,
  type RunEnd,
} from "./outage";
export * from "./types";
