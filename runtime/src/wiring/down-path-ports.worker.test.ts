// T-1363 (T-1326's NEED; DL-699): the root's two ports for the PostgreSQL-down path, in the Workers runtime. Of
// DbOutageDeps' six fields (../outage/db/types.ts), core.recordStopOrStart and timers.fireFromCopy had no root port; the
// root now binds both (./ports.ts DOWN_PATH_PORTS), kept apart from D-017's twenty-one, which stay as they were: on its
// fake in a test root (./test-support.ts fakeStopOrStart and fakeTimerFire) and closed on staging and in production
// (./closed.ts), whatever the root is handed. A closed recordStopOrStart refuses the STOP or START written on return
// before anything is read or recorded (no answer: the actor keeps the record for its next try), and a closed
// fireFromCopy fires nothing: no alert goes, and the timer copy's sealed address is never opened (QUESTIONS.md CQ-101
// (c): opening it is the CTO's call with the security reviewer). Nothing is joined here: T-1326 joins both into
// setDbOutageDeps. Test values only (rule 9): K-09 v1's fixtures (start-recorded.json, Ben's START; and
// j3-stop-on-return-tells-businesses.json, Alex's STOP, from the fictional 555-01xx numbers), K-34's seed timer and the
// master's sample cast.
import startRecorded from "@rosie/contracts/tool-api/fixtures/start-recorded.json";
import stopOnReturn from "@rosie/contracts/tool-api/fixtures/j3-stop-on-return-tells-businesses.json";
import { describe, expect, it } from "vitest";

import { SAM_TIMER } from "../actor/copies/test-support";
import type { SafetyTimerCopy } from "../actor/copies/types";
import { actorNameOf } from "../gateway";
import { dbFakes, idsOf } from "../outage/db/test-support";
import type { StopOrStartCore, StopOrStartOnReturn, TimerFireRequest } from "../outage/db/types";
import { SAM } from "../turn/test-support";
import { bindPorts, type ImplementationSets } from "./bind";
import { closedPorts, NotJoinedError } from "./closed";
import { DOWN_PATH_PICKS, PICKS, type Environment } from "./picks";
import { DOWN_PATH_PORTS, PORTS } from "./ports";
import { realPorts } from "./real";
import { composeRoot, workerRoot, type Root } from "./root";
import { skeletonFakes, type SkeletonFakes } from "./test-support";

/** Alex's STOP, which his handle actor took while PostgreSQL was down and writes on return (K-09 v1 actorOnReturn). */
const STOP = stopOnReturn.request as unknown as StopOrStartOnReturn;
/** Ben's START, taken and written the same way (start-recorded.json). */
const START = startRecorded.request as unknown as StopOrStartOnReturn;

/** K-34's seed timer (seed-safety-timer.json) as the actor copies it: the job's address the seed's sealed stand-in. */
const TIMER: SafetyTimerCopy = {
  timerId: SAM_TIMER.id,
  state: "running",
  version: SAM_TIMER.version,
  dueAt: SAM_TIMER.due_at,
  dueZone: SAM_TIMER.due_zone,
  address: SAM_TIMER.address,
  addressFor: SAM_TIMER.address_for_person_id,
  contact: {
    personId: SAM_TIMER.emergency_contact_person_id,
    handleId: SAM_TIMER.emergency_contact_handle_id,
  },
  workerHandleId: SAM_TIMER.worker_handle_id,
  clockRowId: SAM_TIMER.clock_row_id,
  businessId: SAM_TIMER.business_id,
  bookingId: SAM_TIMER.booking_id,
  refreshedAt: 0,
};

/** The fire the down path asks for that timer while PostgreSQL is down: one request id per timer row version. */
const FIRE: TimerFireRequest = {
  actorName: actorNameOf(SAM.handle),
  requestId: `timer:${SAM_TIMER.id}:${String(SAM_TIMER.version)}`,
  timer: TIMER,
};

/** The fictional numbers and the words these requests carry: none may reach a refusal, in any form. */
const NEVER_NAMED = [
  STOP.phoneNumber,
  STOP.phoneNumber.slice(1),
  START.phoneNumber,
  START.phoneNumber.slice(1),
  STOP.sentByActor.linqMessageId,
  START.sentByActor.linqMessageId,
  TIMER.address,
];

const WORKER_ENVIRONMENTS = ["staging", "production"] as const;

/**
 * The root for `environment`, handed the fake set (the test environment binds it; staging and production must not) and
 * the doubles a key read or a send would reach (the K-05 key double, the Linq line), so a test sees none is reached.
 */
function rootFor(fakes: SkeletonFakes, environment: Environment): Root {
  return composeRoot({
    environment,
    sets: { fake: fakes.ports },
    actors: null,
    vars: { ENVIRONMENT: environment === "test" ? "staging" : environment, GIT_SHA: "test-sha" },
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    linqSendCall: fakes.linq.call,
  });
}

/** The deployed Worker's own root for a Worker environment, as wrangler.jsonc's vars give it. */
const deployed = (environment: (typeof WORKER_ENVIRONMENTS)[number]): Root =>
  workerRoot({ ENVIRONMENT: environment, BASE_PATH: "", DB_SCHEMA: "" });

/** The PostgreSQL-down path's own doubles (../outage/db/test-support.ts), whose recordStopOrStart a test root may hold. */
const downPathDoubles = (root: Root, fakes: SkeletonFakes): ReturnType<typeof dbFakes> =>
  dbFakes(root.ports.sealing, {}, { start: fakes.clock.now(), ids: idsOf(SAM.party) });

/** What a call through a port did: answered, or failed with this error's name and message. */
async function outcomeOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return { answered: await call() };
  } catch (error) {
    const { name, message } = error as Error;
    return { failed: { name, message } };
  }
}

const failedWith = (error: Error): unknown => ({ failed: { name: error.name, message: error.message } });

describe("the PostgreSQL-down path's two root ports (T-1363)", () => {
  it("are kept apart from D-017's twenty-one, each picked once: on its fake in a test, closed on staging and in production", () => {
    expect(DOWN_PATH_PORTS).toEqual(["stopOrStart", "timerFire"]);
    expect(DOWN_PATH_PICKS).toEqual([
      { port: "stopOrStart", test: "fake", staging: "closed", production: "closed" },
      { port: "timerFire", test: "fake", staging: "closed", production: "closed" },
    ]);
    for (const port of DOWN_PATH_PORTS) {
      expect(PORTS).not.toContain(port);
      expect(PICKS.map((pick) => pick.port)).not.toContain(port);
    }

    const fakes = skeletonFakes();
    const sets: ImplementationSets = {
      fake: fakes.ports,
      real: realPorts({ linq: fakes.linqInputs, now: () => fakes.clock.now() }),
      closed: closedPorts(),
    };
    for (const environment of ["test", ...WORKER_ENVIRONMENTS] as const) {
      const bound = bindPorts(PICKS, environment, sets);
      const implementation = environment === "test" ? "fake" : "closed";
      expect(bound.downPathBindings).toEqual([
        { port: "stopOrStart", implementation },
        { port: "timerFire", implementation },
      ]);
      // D-017's bindings are its twenty-one alone, in its turn order, as before.
      expect(bound.bindings.map((binding) => binding.port)).toEqual([...PORTS]);
    }
  });

  it("binds each to its fake in a test root: the fake set's own objects, which keep what the actor hands them", async () => {
    const fakes = skeletonFakes();
    const root = rootFor(fakes, "test");

    expect(root.ports.stopOrStart).toBe(fakes.stopOrStart);
    expect(root.ports.stopOrStart).toBe(fakes.ports.stopOrStart);
    expect(root.ports.timerFire).toBe(fakes.timerFire);
    expect(root.ports.timerFire).toBe(fakes.ports.timerFire);
    expect(root.bindings.map((binding) => binding.port)).toEqual([...PORTS]);

    // A timer fired from the copy is kept as the actor handed it, on the test clock: its address still the sealed stand-in.
    const at = fakes.clock.now();
    await root.ports.timerFire.fireFromCopy(FIRE);
    expect(fakes.timerFire.fired).toEqual([{ at, request: FIRE }]);
    expect(fakes.timerFire.fired[0]?.request.timer.address).toBe(SAM_TIMER.address);
    // A fire that does not go throws (not fired: the down path tries again 5 s on), and is not kept.
    fakes.timerFire.fail = 1;
    await expect(root.ports.timerFire.fireFromCopy(FIRE)).rejects.toThrow("the alerts did not go");
    expect(fakes.timerFire.fired).toHaveLength(1);
  });

  it("the test fake hands each recordStopOrStart to the action layer's where the test root holds one, as kept-results.worker.test.ts does today, and refuses it with nothing written while it holds none", async () => {
    const fakes = skeletonFakes();
    const root = rootFor(fakes, "test");
    const db = downPathDoubles(root, fakes);

    // None held: refused (no answer), nothing written, so the actor keeps the record for its next try.
    expect(await outcomeOf(() => root.ports.stopOrStart.recordStopOrStart(STOP))).toEqual({
      failed: { name: "Error", message: "this test root holds no recordStopOrStart: nothing is written" },
    });
    expect(db.stops).toEqual([]);

    // Held: each request goes to it as the actor sent it, and its answer comes back as it is.
    const answers: unknown[] = [];
    const held: StopOrStartCore = {
      async recordStopOrStart(request) {
        const answer = await db.outageDeps.core.recordStopOrStart(request);
        answers.push(answer);
        return answer;
      },
    };
    fakes.stopOrStart.core = held;
    const stopped = await root.ports.stopOrStart.recordStopOrStart(STOP);
    const started = await root.ports.stopOrStart.recordStopOrStart(START);
    expect(answers).toEqual([stopped, started]);
    expect(stopped).toMatchObject({ stopped: true, repeated: false });
    expect(started).toMatchObject({ stopped: false, repeated: false });
    expect(db.stops).toEqual([STOP, START]);
    // A repeat of a request id is the held call's to answer: its first answer, repeated, nothing written again.
    expect(await root.ports.stopOrStart.recordStopOrStart(STOP)).toMatchObject({
      stopped: true,
      repeated: true,
    });
    expect(db.stops).toEqual([STOP, START]);

    // While PostgreSQL is forced down, refused before the held call is asked.
    fakes.stopOrStart.down = true;
    await expect(root.ports.stopOrStart.recordStopOrStart(START)).rejects.toThrow(
      "PostgreSQL is unreachable",
    );
    expect(answers).toHaveLength(3);
    expect(db.stops).toEqual([STOP, START]);
    expect(fakes.stopOrStart.requests).toEqual([STOP, STOP, START, STOP, START]);
  });

  it.each(WORKER_ENVIRONMENTS)(
    "a closed recordStopOrStart refuses and records nothing on %s: the STOP and the START are refused naming the port and no value, even with the fake set handed in holding a recordStopOrStart, which is never reached",
    async (environment) => {
      const fakes = skeletonFakes();
      const root = rootFor(fakes, environment);
      const db = downPathDoubles(root, fakes);
      fakes.stopOrStart.core = db.outageDeps.core;

      for (const of of [root, deployed(environment)]) {
        expect(await outcomeOf(() => of.ports.stopOrStart.recordStopOrStart(STOP))).toEqual(
          failedWith(new NotJoinedError("stopOrStart")),
        );
        expect(await outcomeOf(() => of.ports.stopOrStart.recordStopOrStart(START))).toEqual(
          failedWith(new NotJoinedError("stopOrStart")),
        );
      }
      const refused = JSON.stringify(await outcomeOf(() => root.ports.stopOrStart.recordStopOrStart(STOP)));
      for (const value of NEVER_NAMED) expect(refused).not.toContain(value);
      // Nothing recorded: the fake set was not reached, and neither was the recordStopOrStart it holds.
      expect(fakes.stopOrStart.requests).toEqual([]);
      expect(db.stops).toEqual([]);
      expect(db.log).toEqual([]);
    },
  );

  it.each(WORKER_ENVIRONMENTS)(
    "a closed fireFromCopy fires nothing on %s: the timer is refused naming the port and no value, no alert goes, no key is read for its sealed address, and the copy is left as it was",
    async (environment) => {
      const fakes = skeletonFakes();
      const root = rootFor(fakes, environment);
      const asHanded = structuredClone(FIRE);

      for (const of of [root, deployed(environment)]) {
        expect(await outcomeOf(() => of.ports.timerFire.fireFromCopy(FIRE))).toEqual(
          failedWith(new NotJoinedError("timerFire")),
        );
      }
      const refused = JSON.stringify(await outcomeOf(() => root.ports.timerFire.fireFromCopy(FIRE)));
      for (const value of NEVER_NAMED) expect(refused).not.toContain(value);
      // Nothing fired: the fake set was not reached, nothing went through Linq, and no key was asked of K-05.
      expect(fakes.timerFire.fired).toEqual([]);
      expect(fakes.direct.sent).toEqual([]);
      expect(fakes.linq.requests).toEqual([]);
      expect(fakes.handleKeys.requests).toEqual([]);
      expect(FIRE).toEqual(asHanded);
    },
  );
});
