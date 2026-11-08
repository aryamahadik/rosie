// The walking skeleton's end-to-end test (C-148; build prompt section 10, D-017), in its prefix form (T-1103; CQ-78).
// One JOIN webhook goes in through T-465's local target with every double and is judged by T-551's checkSkeletonRun.
// Each hop join (T-552 to T-563) proves its own prefix with it, after writing its hop's contract test report:
//
//   npm run test:contract -- tests/contract/<the hop's contract test> --reporter=json --outputFile=<report.json>
//   SKELETON_UPTO=<name> CONTRACT_REPORT=<report.json> npm run test:e2e -- skeleton
//
// - SKELETON_UPTO names a hop of 02-contracts section 11 (T-551's SKELETON_UPTO_NAMES, such as gateway). The run passes
//   only when its trace shows hops 1 to n once each, in turn order (the spans after hop n are not judged), and the hop's
//   contract tests passed in the Vitest JSON report that CONTRACT_REPORT names (a path from the repository root). With
//   no CONTRACT_REPORT the hop fails, naming the report it lacks (fail closed: T-551 default 4). A name that is no hop
//   of section 11 fails the test, naming it.
// - SKELETON_UPTO unset (`npm run test:e2e`, as the merge check runs it): checkSkeletonRun is T-465's full check,
//   checkRun's own report. Only the gateway is joined on today's main, so the file asserts only what T-465's driver
//   already proves there (local-target.test.ts): the gateway answers the signed text 200, and checkRun finds its
//   receive hop once, under one trace id and one bundle id, with no part sent twice. Nothing is skipped.
//
// T-466 completes this same file (D-017's automated tests): the JOIN gives exactly 1 outbox row and 1 send to the Linq
// double, carrying S1-02's question; every hop of section 11 runs once, in order, under one trace id and one bundle id;
// the same webhook sent again (the repeat) adds no outbox row and no send; and 20 consecutive runs give the same result.
//
// The gateway is runtime/src/gateway's Linq webhook entry (C-044), composed as T-465's local target test composes it
// (T-465 default 7: runtime/src/index.ts imports cloudflare:workers, which the Node e2e project cannot load): T-413's
// verifier holding the run's made-up secret, which the Linq double's own hook signs with; the fake sealing key store;
// and doors that store an event once, as the handle actor and the dispatcher do. The Linq double a send would reach is
// the local target's RecordingLinqDouble. No key is read, and nothing here prints a message's words or a phone number.

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLinqWebhookVerifier } from "../../../adapters/src/linq/webhook";
import type { InboundEvent } from "../../../adapters/src/linq/webhook/types";
import {
  DEFAULT_BUNDLE_ID,
  LINQ_WEBHOOK_PATH,
  handleLinqWebhook,
  type GatewayDeps,
  type LinqPort,
  type StoreAnswer,
  type VerifyWebhookResult,
} from "../../../runtime/src/gateway";
import { fakeKeyStore } from "../../../runtime/src/gateway/test-support";
import { REPO_ROOT } from "../../contract/_harness";
import {
  checkRun,
  createLocalTarget,
  makeTestWebhookSecret,
  schemaProblems,
  type LocalTarget,
} from "../_driver";
import {
  SKELETON_UPTO,
  checkSkeletonRun,
  contractTestOf,
  readContractReport,
  skeletonUpto,
  type ContractReport,
  type SkeletonPrefix,
} from "../_driver/prefix";

type Env = Readonly<Record<string, string | undefined>>;

/** The environment variable that names the hop's contract test report (CQ-78's default (b)). */
const CONTRACT_REPORT = "CONTRACT_REPORT";

/**
 * Sam's JOIN: test owner 1's first text, how the sign-up link starts an owner's chat (D-017's human test; S1-01), as
 * one K-06 v1 event. The master's sample cast, never a real person: its ids are K-08 trace-skeleton.json's
 * (evt-sam-0000, trace-sam-0000), its number is test owner 1's on K-21 test-roster.json (tp-01, Sam, the fictional
 * 555-0100), and every other field takes K-06 text-imessage.json's form.
 */
const JOIN: InboundEvent = {
  eventId: "evt-sam-0000",
  provider: "linq",
  handle: { kind: "phone", address: "+15555550100" },
  service: "imessage",
  kind: "text",
  messageId: "linq-msg-demo-in-sam-0000",
  chatId: "linq-chat-demo-sam",
  sentAt: "2026-10-19T14:01:49Z",
  receivedAt: "2026-10-19T14:01:50Z",
  body: "JOIN",
  scrubbed: { cards: 0, ssns: 0 },
  attachments: [],
  threadedReplyTo: null,
  poll: null,
  reaction: null,
  edit: null,
  status: null,
  fromRosie: false,
  email: null,
  traceId: "trace-sam-0000",
};

/** What a door reads of a handoff: its K-06 event id. */
interface Handoff {
  readonly event: { readonly eventId: string };
}

/** A door that stores an event once and calls a known event id a duplicate, as the actor's and the dispatcher's do. */
function storeOnce(): { accept(handoff: Handoff): Promise<StoreAnswer> } {
  const seen = new Set<string>();
  return {
    accept(handoff) {
      if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
      seen.add(handoff.event.eventId);
      return Promise.resolve("written");
    },
  };
}

/**
 * The gateway as the Worker routes it (runtime/src/index.ts, BASE_PATH ""): POST /webhooks/linq to runtime/src/gateway's
 * handleLinqWebhook, with T-413's verifier holding `secret` and a double at every other door; 404 elsewhere.
 */
function skeletonGateway(secret: string): (request: Request) => Response | Promise<Response> {
  const verifier = createLinqWebhookVerifier({ secret: () => secret });
  // T-413's answer carries the K-06 event the gateway's port type also names (its own fields typed as strings).
  const linq: LinqPort = {
    verifyWebhook: async (request) => (await verifier.verifyWebhook(request)) as VerifyWebhookResult,
  };
  const deps: GatewayDeps = {
    linq,
    actor: storeOnce(),
    receipts: storeOnce(),
    keys: fakeKeyStore(),
    bundleId: () => DEFAULT_BUNDLE_ID,
  };
  return (request) =>
    request.method === "POST" && new URL(request.url).pathname === LINQ_WEBHOOK_PATH
      ? handleLinqWebhook(request, deps, { environment: "local", version: "e2e" })
      : new Response('{"ok":false,"error":"not_found"}', {
          status: 404,
          headers: { "x-trace-id": crypto.randomUUID() },
        });
}

/** The report CONTRACT_REPORT names, read with T-551's readContractReport; null when it is unset or empty. */
function contractReportOf(env: Env): ContractReport | null {
  const file = env[CONTRACT_REPORT];
  return file === undefined || file === "" ? null : readContractReport(path.resolve(REPO_ROOT, file));
}

/** What a prefix run must show, said when it fails: hops 1 to n, and the report that holds the hop's contract tests. */
function prefixHint(prefix: SkeletonPrefix, env: Env): string {
  const tests = prefix.row.contracts.map((contract) => contractTestOf(contract).file).join(", ");
  const file = env[CONTRACT_REPORT];
  const given =
    file === undefined || file === "" ? `${CONTRACT_REPORT} is not set` : `${CONTRACT_REPORT}=${file}`;
  return `${SKELETON_UPTO}=${prefix.name}: hops ${prefix.hops.join(", ")} once each, in turn order, and hop ${prefix.hop}'s contract tests (${tests}) passed in a Vitest JSON report (${given})`;
}

const upto = process.env[SKELETON_UPTO];
const mode =
  upto === undefined || upto === ""
    ? `${SKELETON_UPTO} unset: T-465's full check`
    : `${SKELETON_UPTO}=${upto}`;

let target: LocalTarget | undefined;
afterEach(() => {
  target?.close();
  target = undefined;
});

describe(`the walking skeleton end to end (${mode})`, () => {
  it("sends Sam's JOIN as a K-06 v1 event", () => {
    expect(schemaProblems("inbound-event/inbound-event.v1.schema.json", undefined, JOIN)).toEqual([]);
  });

  it("one JOIN webhook in through the local target with every double, judged by checkSkeletonRun", async () => {
    const env: Env = process.env;
    // A name that is no hop of 02-contracts section 11 fails here, named (T-551's prefixOf).
    const prefix = skeletonUpto(env);
    // Read only under a prefix (T-551 default 5); a file that is not Vitest's JSON report fails here, named.
    const contracts = prefix === null ? null : contractReportOf(env);

    const secret = makeTestWebhookSecret();
    target = createLocalTarget({ gateway: skeletonGateway(secret), webhookSecret: secret });
    const sent = await target.sendEvent(JOIN);
    // The gateway took the signed JOIN, as T-465's local target shows of its text.
    expect(sent.gatewayStatus).toBe(200);
    const collected = await target.collect(sent.traceId);
    const report = checkSkeletonRun(collected, { env, contracts });

    if (prefix === null) {
      // T-465's full check: checkRun's own report (T-551 default 5). Only the gateway is joined on today's main, so
      // this asserts only what T-465's checkRun already proves there: the receive hop once, under one trace id and one
      // bundle id, with no part sent twice. T-466 completes the file with the full check: no problem at all.
      expect(report).toStrictEqual(checkRun(collected));
      expect(checkRun(collected, ["receive"]).problems).toEqual([]);
      return;
    }
    expect(report.problems, prefixHint(prefix, env)).toEqual([]);
  });
});
