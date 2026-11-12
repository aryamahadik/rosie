// T-1243 (the D-017 path audit's gap G13; DL-492), in the Workers runtime: the HandleActor the Worker exports
// (runtime/src/index.ts) wires its isolate's actor ports as it is built, before its constructor reads one. Cloudflare does
// not say that a Durable Object runs in the isolate of the fetch handler that reached it (./test-phone/line.ts treats them
// as two), so a stub call or an alarm can land in an isolate no request or retry batch has wired, where an unwired actor
// stores each text 'unwired' and holds it for good. The pool is one isolate, so each test here meets "no request or retry
// batch came first" by putting the module's wired state back (unwireWorker, the existing test seam) and letting the
// actor's own wiring go (setActorWiring("auto"), as in every deployed Worker): a text the gateway's door hands the actor is
// then read for danger on arrival through staging's root (the turn's first step), and an alarm that lands on a new
// instance finds the isolate wired. A test's own ports are never overwritten: once the isolate is wired nothing installs
// again, and while a test holds the actor's wiring an actor installs nothing, so it runs on the ports the test installed,
// or on its unwired defaults where the test installed none. An actor's call in production wires production's root, every
// port closed. Test values only (rule 9): K-06's text-imessage.json under made-up event ids and a made-up trace id.
import {
  createExecutionContext,
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import { setBatchHooks, setSafetyDeps, type HandleActor, type SafetyEntry } from "../actor";
import { prepareHandoff, type InboundEvent, type SealedHandoff } from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import worker from "../index";
import { harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import { spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { setActorWiring, unwireWorker, wiredRoot, wireWorker, workerRoot } from "./root";

const TRACE = "5b0c2e7a-1d3f-4c6e-9a8b-2f1e0d3c4b5a";
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const keys = fakeKeyStore();

type Namespace = DurableObjectNamespace<HandleActor>;

/** The HANDLE_ACTOR binding (env.staging's since T-566; the pool runs env.staging), as the root's door reaches it. */
function namespace(): Namespace {
  const bound = env.HANDLE_ACTOR;
  if (bound === undefined) throw new Error("the pool's env binds no HANDLE_ACTOR");
  return bound as unknown as Namespace;
}

/** The actor's reads over RPC: the stub's own type cannot carry the sealed event's open shape, so they are typed here. */
interface ActorRpc {
  readSafety(): Promise<SafetyEntry[]>;
  routineHeld(): Promise<boolean>;
  safetyIdle(): Promise<void>;
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

function actorOf(actorName: string): ActorRpc {
  return stubOf(actorName);
}

/** text-imessage.json under its own event id, sealed and handed on as the gateway hands a text to its actor. */
async function handoffOf(eventId: string): Promise<SealedHandoff> {
  const prepared = await prepareHandoff(
    {
      event: { ...(textImessage as Record<string, unknown>), eventId, traceId: TRACE } as InboundEvent,
      partKey: null,
      traceId: TRACE,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  return prepared.handoff;
}

/** The safety read's double, answering safety-no.json for this text, and the batch clock on its clock: a test's ports. */
function installTestPorts(eventId: string): { read: () => string[]; restore: () => void } {
  const h = harness(keys, { [eventId]: safetyNo as unknown as SafetyResult });
  const restores = [setSafetyDeps(h.deps), setBatchHooks({ clock: h.clock })];
  return {
    read: () => h.read.requests.map((request) => request.eventId),
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

let restoreActorWiring: () => void = () => undefined;

beforeEach(() => {
  // No request or retry batch has wired this isolate (an earlier test's may have: the pool is one isolate), and the
  // actor's own wiring is let go, as it is wherever the Worker runs.
  unwireWorker();
  restoreActorWiring = setActorWiring("auto");
});

afterEach(async () => {
  restoreActorWiring();
  unwireWorker();
  vi.restoreAllMocks();
  await reset();
});

describe("the handle actor wires its own isolate before its first call (T-1243)", () => {
  it("a text the gateway's door hands an actor in an isolate no request or retry batch has wired: the actor wires it with staging's root as it is built, and the text is read for danger on arrival, never stored 'unwired'", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(wiredRoot()).toBeNull();
    const root = workerRoot(env);
    const handoff = await handoffOf("evt-t1243-text");

    // The stub call the gateway makes: the root's door to the handle's actor, over HANDLE_ACTOR.
    expect(await root.gateway.actor.accept(handoff)).toBe("written");

    // The turn's first step ran (arch 02 step S): the read on arrival, through staging's root, whose sealing port has no
    // database yet, so the words cannot be opened and the timeout rule applies at once (T-1088 security note d). An
    // unwired actor would have stored the text 'unwired', and held it for good.
    const actor = actorOf(handoff.actorName);
    await actor.safetyIdle();
    const safety = await actor.readSafety();
    expect(safety.map((entry) => entry.eventId)).toEqual([handoff.event.eventId]);
    expect(safety[0]?.state).not.toBe("unwired");
    const trace = spansOfTrace(spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])), TRACE);
    expect(trace.map((span) => span.hop)).toEqual(["safetyRead"]);
    // Wired with staging's root, for the env the runtime handed the actor: in the pool that is not the object `env` is
    // here, so the root is its own, with the same bindings.
    expect(wiredRoot()?.environment).toBe("staging");
    expect(wiredRoot()?.bindings).toEqual(root.bindings);
  });

  it("an alarm that lands on a new instance in an isolate nothing has wired: the instance built for it wires the isolate before the alarm runs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handoff = await handoffOf("evt-t1243-alarm");
    expect(await workerRoot(env).gateway.actor.accept(handoff)).toBe("written");
    await actorOf(handoff.actorName).safetyIdle();
    const stub = stubOf(handoff.actorName);
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).not.toBeNull();

    // A new instance in an isolate nothing has wired: the instance's memory goes, and the module's wired state is put
    // back (unwireWorker restores the ports from before the wiring: none). Its storage and its alarm stay.
    await evictDurableObject(stub);
    unwireWorker();
    expect(wiredRoot()).toBeNull();

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(wiredRoot()?.environment).toBe("staging");
    expect(wiredRoot()?.bindings).toEqual(workerRoot(env).bindings);
  });

  it("an actor built after a test installed its own ports, while the test holds the actor's wiring: it runs on the test's ports, and nothing is wired", async () => {
    const restoreHold = setActorWiring("held");
    const eventId = "evt-t1243-held";
    const ports = installTestPorts(eventId);
    try {
      const handoff = await handoffOf(eventId);
      expect(await workerRoot(env).gateway.actor.accept(handoff)).toBe("written");
      await actorOf(handoff.actorName).safetyIdle();

      expect(ports.read()).toEqual([eventId]);
      expect(await actorOf(handoff.actorName).readSafety()).toMatchObject([{ eventId, state: "done" }]);
      expect(wiredRoot()).toBeNull();
    } finally {
      ports.restore();
      restoreHold();
    }
  });

  it("an actor built in an isolate a request already wired, after a test installed its own ports over the root's: it runs on the test's ports, and nothing is installed again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = workerRoot(env);
    const install = vi.spyOn(root, "install");
    const health = await worker.fetch(
      new Request(`https://rosie.test${env.BASE_PATH}/health`),
      env,
      createExecutionContext(),
    );
    expect(health.status).toBe(200);
    expect(install).toHaveBeenCalledTimes(1);
    const eventId = "evt-t1243-wired";
    const ports = installTestPorts(eventId);
    try {
      const handoff = await handoffOf(eventId);
      expect(await root.gateway.actor.accept(handoff)).toBe("written");
      await actorOf(handoff.actorName).safetyIdle();

      expect(ports.read()).toEqual([eventId]);
      expect(await actorOf(handoff.actorName).readSafety()).toMatchObject([{ eventId, state: "done" }]);
      expect(install).toHaveBeenCalledTimes(1);
      expect(wiredRoot()).toBe(root);
    } finally {
      ports.restore();
    }
  });

  it("an actor built with no ports installed, while a test holds the actor's wiring: it keeps its unwired defaults, so the text is stored 'unwired' and held, as before T-1243", async () => {
    const restoreHold = setActorWiring("held");
    try {
      const handoff = await handoffOf("evt-t1243-unwired");
      expect(await workerRoot(env).gateway.actor.accept(handoff)).toBe("written");

      expect(await actorOf(handoff.actorName).readSafety()).toMatchObject([{ state: "unwired" }]);
      expect(await actorOf(handoff.actorName).routineHeld()).toBe(true);
      expect(wiredRoot()).toBeNull();
    } finally {
      restoreHold();
    }
  });

  it("production: an actor's call wires production's root, every port closed, as the fetch and queue entries wire it", () => {
    const bound = env.HANDLE_ACTOR;
    if (bound === undefined) throw new Error("the pool's env binds no HANDLE_ACTOR");
    const production: Cloudflare.Env = {
      ENVIRONMENT: "production",
      BASE_PATH: "",
      DB_SCHEMA: "",
      HANDLE_ACTOR: bound,
    };

    const root = wireWorker(production, "actor");

    expect(root?.environment).toBe("production");
    expect(root?.bindings.filter((binding) => binding.implementation !== "closed")).toEqual([]);
    expect(wiredRoot()).toBe(root);
  });
});
