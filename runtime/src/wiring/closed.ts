// The closed implementation of every port (T-550): what a port is bound to in an environment where it is not joined yet
// (./picks.ts). Each call fails at once with `NotJoinedError`, naming the port and never a value, so a webhook route
// answers 503 with nothing stored, as `unconfiguredGateway` did, and nothing waits on a port that cannot answer. Worker
// code: no double, no fixture, no network call, no key.

import type { PortName, Ports } from "./ports";

/** A call through a port not joined in this environment; its message names the port only. */
export class NotJoinedError extends Error {
  readonly port: PortName;

  constructor(port: PortName) {
    super(`the ${port} port is not joined in this environment`);
    this.name = "NotJoinedError";
    this.port = port;
  }
}

const fail = (port: PortName): Promise<never> => Promise.reject(new NotJoinedError(port));

const failNow = (port: PortName): never => {
  throw new NotJoinedError(port);
};

/** Every port closed. */
export function closedPorts(): Ports {
  return {
    linqVerify: { verifyWebhook: () => fail("linqVerify") },
    sealing: { getOrCreateKey: () => fail("sealing") },
    safetyRead: { read: () => fail("safetyRead") },
    turnRow: { commitTurn: () => fail("turnRow"), parkTurn: () => fail("turnRow") },
    stateReads: {
      bundles: {
        registry: {
          readActiveBundle: () => fail("stateReads"),
          readBundleValue: () => fail("stateReads"),
        },
      },
      safety: {
        directory: { idsOf: () => fail("stateReads") },
        bundle: {
          fixedLine: () => failNow("stateReads"),
          outcomeLine: () => failNow("stateReads"),
          dangerWords: () => failNow("stateReads"),
        },
        isStopped: () => fail("stateReads"),
      },
      targets: { handleTargets: () => fail("stateReads") },
      turn: {
        directory: { partyOf: () => fail("stateReads") },
        safety: { resultsOf: () => fail("stateReads") },
      },
      dispatch: {
        recipients: { chatFor: () => fail("stateReads") },
        sendState: { sendStateFor: () => fail("stateReads") },
      },
      arming: {
        facts: { questionFacts: () => fail("stateReads") },
        directory: { actorNameOf: () => fail("stateReads") },
      },
    },
    turnFace: {
      buildFrontier: () => fail("turnFace"),
      closestEntries: () => fail("turnFace"),
      gateAndCommit: () => fail("turnFace"),
      composeInput: () => fail("turnFace"),
      safetyCore: {
        recordSafetyOutcome: () => fail("turnFace"),
        sendFixedLine: () => fail("turnFace"),
        releaseSafetyHold: () => fail("turnFace"),
      },
    },
    decide: { decide: () => fail("decide"), reread: () => fail("decide") },
    composer: { compose: () => fail("composer"), rewrite: () => fail("composer") },
    finalize: { finalizeMessage: () => fail("finalize") },
    dataAccess: {
      rows: {
        unplannedRows: () => fail("dataAccess"),
        writePlan: () => fail("dataAccess"),
      },
      outbox: {
        markRow: () => fail("dataAccess"),
        claimOutbox: () => fail("dataAccess"),
        renewClaim: () => fail("dataAccess"),
        markPart: () => fail("dataAccess"),
      },
      clocks: { armClock: () => fail("dataAccess"), cancelClock: () => fail("dataAccess") },
    },
    linqSend: {
      parts: { sendPart: () => fail("linqSend") },
      direct: { send: () => fail("linqSend") },
    },
  };
}
