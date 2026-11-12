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
    sealing: { getOrCreateKey: () => fail("sealing"), getOrCreateHandleKey: () => fail("sealing") },
    chatOpen: { openChatOnText: () => fail("chatOpen") },
    safetyRead: { read: () => fail("safetyRead") },
    turnRow: { commitTurn: () => fail("turnRow"), parkTurn: () => fail("turnRow") },
    bundles: {
      registry: {
        readActiveBundle: () => fail("bundles"),
        readBundleValue: () => fail("bundles"),
      },
    },
    targets: { handleTargets: () => fail("targets") },
    frontier: { buildFrontier: () => fail("frontier") },
    stateReads: {
      safety: {
        directory: { idsOf: () => fail("stateReads") },
        bundle: {
          fixedLine: () => failNow("stateReads"),
          outcomeLine: () => failNow("stateReads"),
          dangerWords: () => failNow("stateReads"),
        },
        isStopped: () => fail("stateReads"),
      },
      turn: {
        directory: { partyOf: () => fail("stateReads") },
      },
    },
    turnFace: {
      closestEntries: () => fail("turnFace"),
      safetyCore: {
        recordSafetyOutcome: () => fail("turnFace"),
        sendFixedLine: () => fail("turnFace"),
        releaseSafetyHold: () => fail("turnFace"),
      },
    },
    decide: { decide: () => fail("decide"), reread: () => fail("decide") },
    gate: { gateAndCommit: () => fail("gate") },
    composeInput: { composeInput: () => fail("composeInput") },
    composer: { compose: () => fail("composer"), rewrite: () => fail("composer") },
    finalize: { finalizeMessage: () => fail("finalize") },
    outbox: {
      markRow: () => fail("outbox"),
      claimOutbox: () => fail("outbox"),
      renewClaim: () => fail("outbox"),
      markPart: () => fail("outbox"),
    },
    sendState: {
      sendState: { sendStateFor: () => fail("sendState") },
      recipients: { chatFor: () => fail("sendState") },
    },
    dataAccess: {
      rows: {
        unplannedRows: () => fail("dataAccess"),
        writePlan: () => fail("dataAccess"),
      },
    },
    linqSend: { parts: { sendPart: () => fail("linqSend") } },
    arming: {
      data: { armClock: () => fail("arming"), cancelClock: () => fail("arming") },
      facts: { questionFacts: () => fail("arming") },
      directory: { actorNameOf: () => fail("arming") },
    },
    linqDirect: { send: () => fail("linqDirect") },
  };
}
