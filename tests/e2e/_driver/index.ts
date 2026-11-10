// The end-to-end driver (T-465; C-148), on T-003's shared harness and the e2e Vitest project (`npm run test:e2e`).
//
// It sends a text into the gateway and reads back what came of it, by the trace id the gateway opened at receipt:
//   - local target (createLocalTarget): the webhook is signed by the Linq double's own hook with a secret made at run
//     time, and posted to the gateway the caller wires (the Worker's fetch); the spans are the Worker's log lines;
//   - staging target (openStagingTarget), by name only and never in CI (DL-024): GET {BASE_PATH}/health first, staging
//     or nothing; then K-21 v1's testPhoneSend, and testPhoneParts for what the test phone got.
// Then: the trace (K-08 v1), the Linq double's parts (K-11 v1; K-21 v1 RecordedPart) and its faked receipts and
// failures, the outbox rows under the trace (K-07 v1 schema and lifeChain), and the hop check: the walking skeleton's
// hops (02-contracts section 11) once each, in turn order, with the AI gateway's model-call spans set aside (checkHops;
// CQ-36); a repeated webhook (a known K-06 event id) dropped at receipt (readReceipt, checkRepeat); no part reached the
// person twice, counted by K-07's part states or the double's reports, a retry on the same key being one message
// (checkParts).
//
//   const target = createLocalTarget({ gateway: (request) => worker.fetch(request, env, ctx), outbox });
//   const sent = await target.sendEvent(joinText);
//   const report = checkRun(await target.collect(sent.traceId, { until, timeoutMs }));
//   expect(report.problems).toEqual([]);
//
// No key is read anywhere here, and nothing here prints a message's words, a phone number or a token.

export { K07, K08, K21, lifeChain, schemaProblems, validatorOf, type LifeChain } from "./contracts";
export {
  SKELETON_HOPS,
  checkHops,
  checkRepeat,
  isModelCallSpan,
  readReceipt,
  spansInOrder,
  type HopCheck,
  type HopProblem,
  type HopProblemKind,
  type ReceiptReading,
} from "./hops";
export {
  createLocalTarget,
  makeTestWebhookSecret,
  type LocalTarget,
  type LocalTargetOptions,
  type SendOptions,
} from "./local-target";
export { checkOutboxRows, type OutboxCheck, type OutboxReader } from "./outbox";
export {
  RecordingLinqDouble,
  checkParts,
  deliveryName,
  partsOf,
  type Delivery,
  type PartDeliveries,
  type PartReports,
  type PartsCheck,
  type RecordingLinqDoubleOptions,
  type SentPart,
} from "./parts";
export {
  checkRun,
  settle,
  type CollectOptions,
  type Collected,
  type RunReport,
  type SentText,
  type TargetName,
} from "./run";
export {
  StagingCallError,
  StagingRefusedError,
  inCi,
  openStagingTarget,
  type Fetch,
  type StagingHealth,
  type StagingPageCall,
  type StagingRefusal,
  type StagingTarget,
  type StagingTargetOptions,
  type StagingText,
} from "./staging-target";
export {
  asTrace,
  captureConsoleLog,
  k08TraceCheck,
  spansOfLogLines,
  traceOf,
  type CollectedTrace,
  type LogCapture,
  type LogLine,
  type SpanReader,
  type TraceCheck,
} from "./trace";
