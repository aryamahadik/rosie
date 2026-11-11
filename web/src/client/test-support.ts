// Test support for the K-21 client (T-511): the transport over the Tool API mock (C-186, contracts/mock), which the
// client and every shell and page test run against until the action layer's page calls exist. For tests only: the mock
// reads its generated answers from a file, so nothing the Worker loads may import this module.
//
// The mock answers a request that is a frozen fixture's request, in the environment the fixture names, with a copy of
// that fixture's outcome, and throws ToolApiMockError for anything else. The transport lets that error through, so a
// page test that sends a request no fixture holds fails loudly and never gets a made-up answer.

import { loadToolApiMock, type MockEnvironment, type ToolApiMock } from "../../../contracts/mock/mock.mjs";
import type { PageCall } from "./calls";
import type { PageApiTransport } from "./client";

/** One call as the transport sent it to the mock. */
export interface SentCall {
  readonly call: PageCall;
  readonly request: unknown;
  readonly traceId: string;
}

/** The transport over the mock, with the calls it has sent so far, in order. */
export interface MockTransport extends PageApiTransport {
  readonly environment: MockEnvironment;
  readonly sent: readonly SentCall[];
}

/** A transport that answers from the Tool API mock for pages that run in `environment` (K-21 given.environment). */
export function mockTransport(
  environment: MockEnvironment,
  mock: ToolApiMock = loadToolApiMock({ environment }),
): MockTransport {
  const sent: SentCall[] = [];
  return {
    environment,
    sent,
    send(call, request, traceId) {
      sent.push({ call, request, traceId });
      // In a promise, so the mock's loud error rejects the call instead of throwing past it.
      return new Promise((resolve) => {
        resolve(mock.answer("page-api", call, request));
      });
    },
  };
}
