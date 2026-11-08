// The clock arming reaching the real handle actor (T-255 with T-254), inside the Workers runtime: A7-03's first delivery
// receipt arms its clock row (arm-clock.json), and the arming's `syncClocks` moves Alex's actor's one alarm to the row's
// due time; when it rings, the actor reads its due rows (due-for-handle.json, the exchange that runs after arm-clock.json)
// and fires A7-03 through T-254's one fire path. One K-05 database stands behind both sets of doubles: the row armClock
// arms (./arming-support.ts) is the row dueClocks reads (./test-support.ts). The actor's clock is the stored schedule's
// fake clock (`setBatchHooks`). Test values only (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import dueForHandle from "../../../contracts/data-access/fixtures/due-for-handle.json";
import { setBatchHooks, type HandleActor } from "../actor";
import { A7_03_ARM_REQUEST, A7_03_DELIVERED, wireArming } from "./arming-support";
import { armAtDelivery, SCHEDULE_CLOCK, setClockDeps, type ArmingData, type ClockActors } from "./index";
import { A7_03, ALEX_ACTOR, ALEX_HANDLE, fakeClocks } from "./test-support";

type Namespace = DurableObjectNamespace<HandleActor>;

let now = 0;
let undo: (() => void)[] = [];

beforeEach(() => {
  undo.push(setBatchHooks({ clock: { now: () => now } }));
});

afterEach(async () => {
  for (const restore of undo.reverse()) restore();
  undo = [];
  await reset();
});

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

function stubOf(name: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(name));
}

/** The namespace as the arming reaches an actor. */
function actors(): ClockActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

/** The clock entry of the actor's stored schedule (on the actor's clock), or null. */
function clockEntry(name: string): Promise<number | null> {
  return runInDurableObject(
    stubOf(name),
    (_instance: HandleActor, state) =>
      state.storage.sql
        .exec<{ due_ms: number }>("SELECT due_ms FROM batch_schedule WHERE kind = ?", SCHEDULE_CLOCK)
        .toArray()[0]?.due_ms ?? null,
  );
}

describe("the arming tells the handle's actor, whose one alarm moves to the armed row", () => {
  it("A7-03 armed at its first receipt: Alex's alarm at its due time, then fired by the alarm when due", async () => {
    const clocks = fakeClocks();
    undo.push(setClockDeps(clocks.deps));
    const wired = wireArming();
    // One database: the row armClock arms is the row the actor's dueClocks reads.
    const data: ArmingData = {
      async armClock(request) {
        const answer = await wired.data.data.armClock(request);
        if ("result" in answer && !answer.repeated) {
          const { version, dueAt, dueZone } = answer.clock;
          clocks.arm({ ...A7_03, fires: { ...A7_03.fires }, version, dueAt, dueZone });
        }
        return answer;
      },
      cancelClock: (request) => wired.data.data.cancelClock(request),
    };
    now = Date.parse(A7_03_DELIVERED.deliveredAt);

    const report = await armAtDelivery(A7_03_DELIVERED, {
      ...wired.options,
      data,
      directory: clocks.deps.directory,
      actors: actors(),
    });

    expect(report).toMatchObject({ outcome: "armed", synced: true, errorCode: null });
    expect(wired.data.armRequests).toEqual([A7_03_ARM_REQUEST]);
    expect(clocks.rowOf(A7_03.clockRowId)).toEqual(A7_03);
    expect(clocks.dueRequests[0]).toMatchObject({ for: "handle", handleId: ALEX_HANDLE });
    expect(await clockEntry(ALEX_ACTOR)).toBe(Date.parse(A7_03_ARM_REQUEST.dueAt));
    expect(clocks.gateRequests).toEqual([]);

    now = Date.parse(dueForHandle.request.now);
    expect(await runDurableObjectAlarm(stubOf(ALEX_ACTOR))).toBe(true);
    expect(clocks.dueRequests.at(-2)).toEqual(dueForHandle.request);
    expect(clocks.gateRequests.map((request) => [request.input.clockRowId, request.input.by])).toEqual([
      [A7_03.clockRowId, "alarm"],
    ]);
    expect(clocks.gateRequests[0]?.input.expectVersion).toBe(dueForHandle.outcome.rows[0]?.version);
    expect(clocks.stateOf(A7_03.clockRowId)).toBe("fired");
    expect(await clockEntry(ALEX_ACTOR)).toBeNull();
  });
});
