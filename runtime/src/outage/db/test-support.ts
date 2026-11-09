// Doubles for the PostgreSQL-down path's tests (T-270). Not imported by the Worker. One switch, `down`, makes the data
// access fail as PostgreSQL unreachable everywhere the actor reaches it, each call answering as the frozen contracts state
// while it is up:
//
//   - the probe (`DbOutageDeps.probe`): a throw while down;
//   - K-09 v1's shared core: the safety read's recordSafetyOutcome and sendFixedLine (../../safety/test-support.ts's core
//     double, safety-outcome-hold.json's shape), and recordStopOrStart as start-recorded.json and
//     j3-stop-on-return-tells-businesses.json answer it (the phone row's stopped flag and version; a repeat of a request id
//     answers its first commit, repeated): each throws while down, and each one taken is noted in `log`, in order;
//   - K-05 v1 readActiveBundle and readBundleValue (../../bundle/test-support.ts), so a turn's bundle cannot be pinned;
//   - the turn's commit through the lease (K-09 gateAndCommit, T-269's Tool API double: ../../actor/copies/test-support.ts),
//     noted in `log` with the turn's event ids.
// Linq's direct send (the safety read's double), the handle's key store and its directory answer whatever `down` says: the
// actor reaches them without PostgreSQL. The clock is the safety read's fake clock, started at a given instant. Test values
// only: the master's sample cast, the fixtures' ids and phones in the fictional 555-01xx range (rule 9).

import type { CommitContext, CommitTurnAnswer, CommitTurnRequest } from "../../actor";
import { fakeToolApi, type FakeToolApi } from "../../actor/copies/test-support";
import type { BundleDeps } from "../../bundle";
import { fakeBundles } from "../../bundle/test-support";
import type { SealingKeyStore } from "../../gateway/seal";
import {
  fakeClock,
  fakeCore,
  fakeDirect,
  fakeRead,
  fixtureBundle,
  TEST_IDS,
  type FakeClock,
  type FakeCore,
  type FakeDirect,
} from "../../safety/test-support";
import type { HandleIds, SafetyDeps, SafetyResult } from "../../safety/types";
import type { DbOutageDeps, StopOrStartOnReturn, StopOrStartRecorded, TimerFireRequest } from "./types";

export interface FakeTimers {
  /** Each timer fired from the copy, with the clock time it was fired at, in order. */
  readonly fired: { at: number; request: TimerFireRequest }[];
  /** How many of the next fires throw (not fired). */
  fail: number;
  fireFromCopy(request: TimerFireRequest): Promise<void>;
}

export interface DbFakes {
  readonly clock: FakeClock;
  /** The shared core's safety calls (the safety read's double). */
  readonly core: FakeCore;
  /** Linq's direct sends, the safety read's and the down path's, in order. */
  readonly direct: FakeDirect;
  readonly timers: FakeTimers;
  /** Every recordStopOrStart the core took, in order. */
  readonly stops: StopOrStartOnReturn[];
  /** The Tool API double behind the lease's commit (T-269's), which writes a timer row when a test gives it one. */
  readonly api: FakeToolApi;
  /** Each probe's clock time, in order. */
  readonly probes: number[];
  /** Each call the data access took, in order: `<call>:<event id>`, and `commit:<event ids>` for a turn's commit. */
  readonly log: string[];
  /** While true, every data-access call fails as PostgreSQL unreachable. */
  down: boolean;
  /** How many of the next recordSafetyOutcome calls fail as PostgreSQL unreachable, for them alone (a blip). */
  failRecords: number;
  readonly safetyDeps: SafetyDeps;
  readonly outageDeps: DbOutageDeps;
  readonly bundleDeps: BundleDeps;
  /** The lease's commit hook: K-09 gateAndCommit through T-269's Tool API double, failing while down. */
  commit(request: CommitTurnRequest, at: CommitContext): Promise<CommitTurnAnswer>;
}

const unreachable = (): Promise<never> => Promise.reject(new Error("PostgreSQL is unreachable"));

/**
 * The down path's doubles for one test: the safety read answering `answers` (no verdict for a text not named), on a fake
 * clock started at `start`, with the handle's ids TEST_IDS's form for `ids`.
 */
export function dbFakes(
  keys: SealingKeyStore,
  answers: Record<string, SafetyResult>,
  options: { start: number; ids: HandleIds },
): DbFakes {
  const clock = fakeClock(options.start);
  const core = fakeCore(clock);
  const direct = fakeDirect(clock);
  const read = fakeRead(clock, answers);
  const bundles = fakeBundles();
  const api = fakeToolApi();
  const log: string[] = [];
  const stops: StopOrStartOnReturn[] = [];
  const firstAnswers = new Map<string, StopOrStartRecorded>();
  let phoneVersion = 3;
  const timers: FakeTimers = {
    fired: [],
    fail: 0,
    fireFromCopy(request) {
      if (timers.fail > 0) {
        timers.fail -= 1;
        return Promise.reject(new Error("the alert did not go"));
      }
      timers.fired.push({ at: clock.now(), request: structuredClone(request) });
      return Promise.resolve();
    },
  };
  const fakes: DbFakes = {
    clock,
    core,
    direct,
    timers,
    stops,
    api,
    probes: [],
    log,
    failRecords: 0,
    get down() {
      return core.down;
    },
    set down(value: boolean) {
      core.down = value;
    },
    safetyDeps: {
      read,
      bundle: fixtureBundle(),
      core: {
        async recordSafetyOutcome(request) {
          if (fakes.failRecords > 0) {
            fakes.failRecords -= 1;
            return unreachable();
          }
          const answer = await core.recordSafetyOutcome(request);
          log.push(`recordSafetyOutcome:${request.safety.eventId}`);
          return answer;
        },
        async sendFixedLine(request) {
          const answer = await core.sendFixedLine(request);
          log.push(`sendFixedLine:${request.caller.requestId}`);
          return answer;
        },
        releaseSafetyHold: (request) => core.releaseSafetyHold(request),
      },
      directory: { idsOf: () => Promise.resolve(options.ids) },
      keys,
      direct,
      clock,
      isStopped: () => false,
    },
    outageDeps: {
      probe() {
        fakes.probes.push(clock.now());
        return core.down ? unreachable() : Promise.resolve(true);
      },
      keys,
      direct,
      directory: { idsOf: () => Promise.resolve(options.ids) },
      core: {
        recordStopOrStart(request) {
          if (core.down) return unreachable();
          const known = firstAnswers.get(request.caller.requestId);
          if (known !== undefined) return Promise.resolve({ ...known, repeated: true });
          stops.push(structuredClone(request));
          log.push(`recordStopOrStart:${request.inboundEventId}`);
          phoneVersion += 1;
          const answer: StopOrStartRecorded = {
            consentRowIds: [`consent-${request.inboundEventId}`],
            stopped: request.kind === "stop",
            chatOpen: request.kind !== "stop",
            phoneVersion,
            reply: { fixedLineId: request.sentByActor.fixedLineId, outboxRowId: null },
            askedWhichTexts: null,
            flaggedBookingIds: [],
            repeated: false,
          };
          firstAnswers.set(request.caller.requestId, answer);
          return Promise.resolve(answer);
        },
      },
      timers,
    },
    bundleDeps: {
      ...bundles.deps,
      registry: {
        readActiveBundle: (request) =>
          core.down ? unreachable() : bundles.deps.registry.readActiveBundle(request),
        readBundleValue: (request) =>
          core.down ? unreachable() : bundles.deps.registry.readBundleValue(request),
      },
    },
    commit(request, at) {
      if (core.down) return unreachable();
      log.push(`commit:${request.turn.eventIds.join("+")}`);
      return api.commit(request, at);
    },
  };
  return fakes;
}

/** The ids of TEST_IDS's form for a party: its K-04 handle, business and person. */
export function idsOf(party: { handleId: string; businessId: string; personId: string }): HandleIds {
  return { ...TEST_IDS, handleId: party.handleId, businessId: party.businessId, personId: party.personId };
}
