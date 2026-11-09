// The composition root's bindings (T-550), under Node (Vitest project "unit"): the ports the root binds in each
// environment, each once and none left unbound; the check that refuses a port bound twice or left unbound; each bound port
// handed to the part that calls it; and the closed implementation the Worker's environments still bind everywhere.
import { describe, expect, it } from "vitest";

import {
  bindPorts,
  closedPorts,
  composeRoot,
  environmentOf,
  NotJoinedError,
  PICKS,
  PORTS,
  WiringError,
  workerRoot,
  type PortPick,
  type Ports,
} from "./index";
import { skeletonFakes } from "./test-support";

const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };

/** A Worker's env as wrangler.jsonc's vars give it, for one environment. */
function workerEnv(environment: string): Cloudflare.Env {
  return { ENVIRONMENT: environment, BASE_PATH: "", DB_SCHEMA: "" };
}

describe("the ports the root binds", () => {
  it("names D-017's ten ports in its turn order", () => {
    expect(PORTS).toEqual([
      "linqVerify",
      "sealing",
      "safetyRead",
      "stateReads",
      "turnFace",
      "decide",
      "composer",
      "finalize",
      "dataAccess",
      "linqSend",
    ]);
  });

  it("picks each port once, in turn order: no port is picked twice and none is left out", () => {
    expect(PICKS.map((pick) => pick.port)).toEqual([...PORTS]);
  });

  it("binds every port once under test, each to its fake", () => {
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: VARS,
    });

    expect(root.bindings).toEqual(PORTS.map((port) => ({ port, implementation: "fake" })));
  });

  it.each(["staging", "production"] as const)(
    "binds every port once on the Worker's %s, each still closed: no join has landed",
    (environment) => {
      const root = workerRoot(workerEnv(environment));

      expect(root.environment).toBe(environment);
      expect(root.bindings).toEqual(PORTS.map((port) => ({ port, implementation: "closed" })));
    },
  );

  it("hands each bound port to the part that calls it", () => {
    const fakes = skeletonFakes();
    const root = composeRoot({ environment: "test", sets: { fake: fakes.ports }, actors: null, vars: VARS });

    for (const port of PORTS) expect(root.ports[port]).toBe(fakes.ports[port]);
    expect(root.gateway.linq).toBe(fakes.ports.linqVerify);
    expect(root.gateway.keys).toBe(fakes.ports.sealing);
    expect(root.safety.keys).toBe(fakes.ports.sealing);
    expect(root.turn.keys).toBe(fakes.ports.sealing);
    expect(root.safety.read).toBe(fakes.ports.safetyRead);
    expect(root.safety.bundle).toBe(fakes.ports.stateReads.safety.bundle);
    expect(root.safety.directory).toBe(fakes.ports.stateReads.safety.directory);
    expect(root.safety.core).toBe(fakes.ports.turnFace.safetyCore);
    expect(root.safety.direct).toBe(fakes.ports.linqSend.direct);
    expect(root.turn.directory).toBe(fakes.ports.stateReads.turn.directory);
    expect(root.turn.safety).toBe(fakes.ports.stateReads.turn.safety);
    expect(root.turn.ai).toBe(fakes.ports.decide);
    expect(root.turn.composer).toBe(fakes.ports.composer);
    expect(root.turn.rows).toBe(fakes.ports.dataAccess.rows);
    expect(root.turn.dispatcher).toBe(root.dispatcher);
  });

  it("puts the turn face and finalize together as the turn's Tool API, each call to its own port", async () => {
    const fakes = skeletonFakes();
    const root = composeRoot({ environment: "test", sets: { fake: fakes.ports }, actors: null, vars: VARS });
    const caller = {
      kind: "turn" as const,
      turnId: "turn-wiring",
      requestId: "turn-wiring",
      businessId: null,
      personId: null,
      traceId: "trace-wiring",
    };
    const trace = {} as Parameters<Ports["finalize"]["finalizeMessage"]>[1];

    await root.turn.toolApi.composeInput({ caller, outboxRowId: "out-wiring" }, trace);
    await root.turn.toolApi.finalizeMessage(
      {
        caller,
        outboxRowId: "out-wiring",
        expectVersion: 1,
        attempt: "composed",
        plan: {
          row: "out-wiring",
          channel: "imessage",
          copyOf: null,
          plan: { formats: ["text"], lines: [], question: null, pageType: null, threadReplyTo: null },
        },
      },
      trace,
    );

    expect(fakes.face.log).toEqual(["composeInput:out-wiring", "finalize:composed:out-wiring"]);
  });
});

describe("a port bound twice or left unbound is refused, naming the port", () => {
  const sets = { fake: skeletonFakes().ports };

  it("refuses a port picked twice", () => {
    const twice: PortPick[] = [
      ...PICKS,
      { port: "decide", test: "fake", staging: "closed", production: "closed" },
    ];

    expect(() => bindPorts(twice, "test", sets)).toThrow(
      new WiringError("port decide is bound twice in test"),
    );
  });

  it("refuses a port no pick names", () => {
    const without = PICKS.filter((pick) => pick.port !== "finalize");

    expect(() => bindPorts(without, "test", sets)).toThrow(
      new WiringError("left unbound in test: finalize (no pick)"),
    );
  });

  it("refuses a port whose picked implementation is not at hand", () => {
    const partial = Object.fromEntries(
      Object.entries(skeletonFakes().ports).filter(([port]) => port !== "decide"),
    ) as Partial<Ports>;

    expect(() => bindPorts(PICKS, "test", { fake: partial })).toThrow(
      new WiringError("left unbound in test: decide (no fake implementation)"),
    );
  });

  it("leaves every port unbound where the environment picks a set the root was not handed: no Worker takes the fakes", () => {
    const unbound = PORTS.map((port) => `${port} (no fake implementation)`).join(", ");

    expect(() => composeRoot({ environment: "test", actors: null, vars: VARS })).toThrow(
      new WiringError(`left unbound in test: ${unbound}`),
    );
  });
});

describe("the Worker's environments", () => {
  it("is staging under env.staging and production anywhere else", () => {
    expect(environmentOf({ ENVIRONMENT: "staging" })).toBe("staging");
    expect(environmentOf({ ENVIRONMENT: "production" })).toBe("production");
    expect(environmentOf({ ENVIRONMENT: "" })).toBe("production");
  });

  it("keeps one root per Worker env object", () => {
    const env = workerEnv("staging");

    expect(workerRoot(env)).toBe(workerRoot(env));
  });

  it("keeps the gateway's doors closed while no port is joined: verify, the seal and the actor all fail", async () => {
    const { gateway } = workerRoot(workerEnv("staging"));
    const handle = { kind: "phone", address: "+15555550100" };

    await expect(
      gateway.linq.verifyWebhook({
        webhookId: "msg_1",
        timestamp: "1760286001",
        signature: "v1,x",
        raw: "{}",
        receivedAt: "2026-10-12T16:20:01.000Z",
        traceId: "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69",
      }),
    ).rejects.toThrow(new NotJoinedError("linqVerify"));
    await expect(gateway.keys.getOrCreateKey(handle)).rejects.toThrow(new NotJoinedError("sealing"));
    // No HandleActor namespace is handed to the Worker's root yet (T-553): the door to the actor is closed.
    await expect(gateway.actor.accept({} as never)).rejects.toThrow(
      new WiringError("no HandleActor namespace is bound here"),
    );
    // The active bundle id cannot be read: the gateway's answer rules then use bundle v0's stand-in (answer.ts).
    await expect(Promise.resolve(gateway.bundleId())).rejects.toThrow(new NotJoinedError("stateReads"));
  });
});

describe("a closed port", () => {
  it("fails every call at once, naming its port and no value", async () => {
    const closed = closedPorts();

    await expect(closed.safetyRead.read({} as never)).rejects.toThrow(new NotJoinedError("safetyRead"));
    await expect(closed.decide.decide({} as never, {} as never)).rejects.toThrow(
      new NotJoinedError("decide"),
    );
    await expect(closed.dataAccess.outbox.claimOutbox({} as never)).rejects.toThrow(
      new NotJoinedError("dataAccess"),
    );
    await expect(closed.linqSend.parts.sendPart({} as never)).rejects.toThrow(new NotJoinedError("linqSend"));
    expect(() => closed.stateReads.safety.bundle.dangerWords()).toThrow(new NotJoinedError("stateReads"));
  });
});
