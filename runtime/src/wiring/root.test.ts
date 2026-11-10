// The composition root's bindings (T-550, T-552, T-553, T-554, T-555, T-556), under Node (Vitest project "unit"): the
// ports the root binds in each environment, each once and none left unbound; the check that refuses a port bound twice or
// left unbound; each bound port handed to the part that calls it; and the closed implementation the Worker's environments
// still bind for every port no join has reached (T-552 joined the Linq verify on staging, T-553 the sealing, T-554 the
// safety read, T-555 the turn-row calls, T-556 the bundle reads and the guard's targets; production takes no join yet).
import parkTurnJson from "@rosie/contracts/data-access/fixtures/park-turn.json";
import { describe, expect, it } from "vitest";

import { turnIdOf } from "../actor/lease";
import type { ParkTurnRequest } from "../turn/types";
import {
  bindPorts,
  closedPorts,
  composeRoot,
  environmentOf,
  LINQ_WEBHOOK_SECRET,
  MissingSecretError,
  NoDatabaseError,
  NotJoinedError,
  PICKS,
  PORTS,
  realPorts,
  WiringError,
  workerRoot,
  type ImplementationSets,
  type PortName,
  type PortPick,
  type Ports,
} from "./index";
import { skeletonFakes } from "./test-support";

const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };

/** A Worker's env as wrangler.jsonc's vars give it, for one environment. */
function workerEnv(environment: string): Cloudflare.Env {
  return { ENVIRONMENT: environment, BASE_PATH: "", DB_SCHEMA: "" };
}

/**
 * The ports joined so far in each environment (./picks.ts): their real package; every other port on its fake under test,
 * and closed on the Worker's environments.
 */
const JOINED: Readonly<Record<"test" | "staging" | "production", readonly PortName[]>> = {
  test: ["linqVerify", "sealing", "safetyRead", "turnRow", "bundles", "targets"],
  staging: ["linqVerify", "sealing", "safetyRead", "turnRow", "bundles", "targets"],
  production: [],
};

/** park-turn.json's request under the turn id the lease hashes from its event ids (CQ-09), as a lapsed turn's park sends it. */
async function leasePark(): Promise<ParkTurnRequest> {
  const request = structuredClone(parkTurnJson.request) as unknown as ParkTurnRequest;
  return { ...request, turn: { ...request.turn, id: await turnIdOf(request.turn.eventIds) } };
}

describe("the ports the root binds", () => {
  it("names D-017's thirteen ports in its turn order", () => {
    expect(PORTS).toEqual([
      "linqVerify",
      "sealing",
      "safetyRead",
      "turnRow",
      "bundles",
      "targets",
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

  it("binds every port once under test: the joined Linq verify, sealing, safety read, turn-row calls, bundle reads and targets read to their real packages, every other port to its fake", () => {
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: VARS,
    });

    expect(root.bindings).toEqual(
      PORTS.map((port) => ({ port, implementation: JOINED.test.includes(port) ? "real" : "fake" })),
    );
  });

  it.each(["staging", "production"] as const)(
    "binds every port once on the Worker's %s: each port joined there to its real package, every other still closed",
    (environment) => {
      const root = workerRoot(workerEnv(environment));
      const joined = JOINED[environment];

      expect(root.environment).toBe(environment);
      expect(root.bindings).toEqual(
        PORTS.map((port) => ({ port, implementation: joined.includes(port) ? "real" : "closed" })),
      );
    },
  );

  it("hands each bound port to the part that calls it", async () => {
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: VARS,
      turnRows: fakes.turnRows.calls,
    });
    const fakeSet: Partial<Ports> = fakes.ports;

    for (const port of PORTS) {
      if (!JOINED.test.includes(port)) {
        expect(root.ports[port]).toBe(fakeSet[port]);
      }
    }
    expect(root.gateway.linq).toBe(root.ports.linqVerify);
    expect(root.gateway.keys).toBe(root.ports.sealing);
    expect(root.safety.keys).toBe(root.ports.sealing);
    expect(root.turn.keys).toBe(root.ports.sealing);
    expect(root.safety.read).toBe(root.ports.safetyRead);
    expect(root.safety.bundle).toBe(fakes.ports.stateReads.safety.bundle);
    expect(root.safety.directory).toBe(fakes.ports.stateReads.safety.directory);
    expect(root.safety.core).toBe(fakes.ports.turnFace.safetyCore);
    expect(root.safety.direct).toBe(fakes.ports.linqSend.direct);
    expect(root.turn.directory).toBe(fakes.ports.stateReads.turn.directory);
    expect(root.turn.safety).toBe(fakes.ports.stateReads.turn.safety);
    expect(root.turn.ai).toBe(fakes.ports.decide);
    expect(root.turn.composer).toBe(fakes.ports.composer);
    // The turn's plan calls go to the data-access port; its park writes the turn's one row through the turn-row port
    // (T-555), never through the data-access port's fake.
    const park = await leasePark();
    await root.turn.rows.unplannedRows({ turnId: park.turn.id });
    expect(await root.turn.rows.parkTurn(park)).toMatchObject({ result: "parked", turnId: park.turn.id });
    expect(fakes.face.log).toEqual(["unplannedRows"]);
    expect(fakes.turnRows.parks.map((request) => request.turn.id)).toEqual([park.turn.id]);
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
  const fakes = skeletonFakes();
  const sets: ImplementationSets = {
    fake: fakes.ports,
    real: realPorts({ linq: fakes.linqInputs, now: () => fakes.clock.now() }),
  };

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

    expect(() => bindPorts(PICKS, "test", { ...sets, fake: partial })).toThrow(
      new WiringError("left unbound in test: decide (no fake implementation)"),
    );
  });

  it("leaves every port unbound where the environment picks a set the root was not handed: no Worker takes the fakes", () => {
    const unbound = PORTS.filter((port) => !JOINED.test.includes(port))
      .map((port) => `${port} (no fake implementation)`)
      .join(", ");

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

  it("keeps the gateway's doors closed: with no Linq webhook secret set the joined verify fails, the joined seal and active bundle read fail with no database bound (until T-567), and the actor fails", async () => {
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
    ).rejects.toThrow(new MissingSecretError(LINQ_WEBHOOK_SECRET));
    await expect(gateway.keys.getOrCreateKey(handle)).rejects.toThrow(
      new NoDatabaseError("handleSealingKey"),
    );
    // No HandleActor namespace is handed to the Worker's root yet (T-553): the door to the actor is closed.
    await expect(gateway.actor.accept({} as never)).rejects.toThrow(
      new WiringError("no HandleActor namespace is bound here"),
    );
    // The active bundle id cannot be read: the bundle port is joined (T-556) but fed no database until T-567, so the
    // gateway's answer rules use bundle v0's stand-in (answer.ts).
    await expect(Promise.resolve(gateway.bundleId())).rejects.toThrow(
      new NoDatabaseError("readActiveBundle"),
    );
  });
});

describe("a closed port", () => {
  it("fails every call at once, naming its port and no value", async () => {
    const closed = closedPorts();

    await expect(closed.safetyRead.read({} as never)).rejects.toThrow(new NotJoinedError("safetyRead"));
    await expect(closed.turnRow.commitTurn({} as never)).rejects.toThrow(new NotJoinedError("turnRow"));
    await expect(closed.turnRow.parkTurn({} as never)).rejects.toThrow(new NotJoinedError("turnRow"));
    await expect(closed.bundles.registry.readActiveBundle({})).rejects.toThrow(new NotJoinedError("bundles"));
    await expect(closed.bundles.registry.readBundleValue({ key: "bundle/x/1/manifest" })).rejects.toThrow(
      new NotJoinedError("bundles"),
    );
    await expect(closed.targets.handleTargets({ handleId: "handle-sam" })).rejects.toThrow(
      new NotJoinedError("targets"),
    );
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
