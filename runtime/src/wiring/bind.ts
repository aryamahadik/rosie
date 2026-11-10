// Binding each port once (T-550): the composition root's check that every port of ./ports.ts takes exactly one
// implementation in its environment. A port named twice by the picks, a port no pick names, or a pick whose
// implementation is not at hand is refused, naming the port, so nothing is ever bound by halves.

import type { Environment, ImplementationName, PortPick } from "./picks";
import { PORTS, type PortName, type Ports } from "./ports";

/** One port's binding: the implementation it took. */
export interface Binding {
  readonly port: PortName;
  readonly implementation: ImplementationName;
}

/** The implementations at hand, by name; one may hold only some of the ports. */
export type ImplementationSets = Readonly<Partial<Record<ImplementationName, Partial<Ports>>>>;

/** The ports could not be bound; the message names each port at fault and never a value. */
export class WiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WiringError";
  }
}

export interface BoundPorts {
  readonly ports: Ports;
  /** Each port and the implementation it took, in D-017's turn order. */
  readonly bindings: readonly Binding[];
}

/**
 * Binds each port to the implementation its pick names for `environment`, taken from `sets`. Throws `WiringError` when a
 * port is picked twice, when a port is picked by no line, or when the named implementation is not in `sets`.
 */
export function bindPorts(
  picks: readonly PortPick[],
  environment: Environment,
  sets: ImplementationSets,
): BoundPorts {
  const picked = new Set<PortName>();
  const bound = new Map<PortName, { implementation: ImplementationName; value: unknown }>();
  const missing: string[] = [];
  for (const pick of picks) {
    if (picked.has(pick.port)) throw new WiringError(`port ${pick.port} is bound twice in ${environment}`);
    picked.add(pick.port);
    const implementation = pick[environment];
    const value: unknown = sets[implementation]?.[pick.port];
    if (value === undefined) missing.push(`${pick.port} (no ${implementation} implementation)`);
    else bound.set(pick.port, { implementation, value });
  }
  for (const port of PORTS) if (!picked.has(port)) missing.push(`${port} (no pick)`);
  if (missing.length > 0) {
    throw new WiringError(`left unbound in ${environment}: ${missing.join(", ")}`);
  }

  const take = <P extends PortName>(port: P): Ports[P] => bound.get(port)?.value as Ports[P];
  return {
    ports: {
      linqVerify: take("linqVerify"),
      sealing: take("sealing"),
      safetyRead: take("safetyRead"),
      turnRow: take("turnRow"),
      bundles: take("bundles"),
      targets: take("targets"),
      stateReads: take("stateReads"),
      turnFace: take("turnFace"),
      decide: take("decide"),
      composer: take("composer"),
      finalize: take("finalize"),
      dataAccess: take("dataAccess"),
      linqSend: take("linqSend"),
    },
    bindings: PORTS.map((port) => ({ port, implementation: pickOf(picks, port, environment) })),
  };
}

/** The implementation a port's one pick names for the environment (every port has exactly one pick by now). */
function pickOf(picks: readonly PortPick[], port: PortName, environment: Environment): ImplementationName {
  const pick = picks.find((candidate) => candidate.port === port);
  if (pick === undefined) throw new WiringError(`left unbound in ${environment}: ${port} (no pick)`);
  return pick[environment];
}
