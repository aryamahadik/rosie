// Binding each port once (T-550): the composition root's check that every port of ./ports.ts takes exactly one
// implementation in its environment. A port named twice by the picks, a port no pick names, or a pick whose
// implementation is not at hand is refused, naming the port, so nothing is ever bound by halves. D-017's twenty-one are
// bound first, by the picks the root hands in; then the PostgreSQL-down path's two (T-1363), by their own table
// (./picks.ts DOWN_PATH_PICKS), so a set that leaves one of the twenty-one unbound is refused as it was before them.

import { DOWN_PATH_PICKS, type Environment, type ImplementationName, type PortPick } from "./picks";
import { DOWN_PATH_PORTS, PORTS, type PortName, type Ports } from "./ports";

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
  /** Each of D-017's twenty-one ports and the implementation it took, in D-017's turn order. */
  readonly bindings: readonly Binding[];
  /** Each of the PostgreSQL-down path's two ports and the implementation it took, in its order (T-1363). */
  readonly downPathBindings: readonly Binding[];
}

/**
 * Binds each port to the implementation its pick names for `environment`, taken from `sets`: D-017's twenty-one by
 * `picks`, then the PostgreSQL-down path's two by `downPathPicks` (./picks.ts DOWN_PATH_PICKS unless a test hands others).
 * Throws `WiringError` when a port is picked twice (in either table), when a port is picked by no line, or when the named
 * implementation is not in `sets`; a port of the twenty-one left unbound is refused before the down path's are read.
 */
export function bindPorts(
  picks: readonly PortPick[],
  environment: Environment,
  sets: ImplementationSets,
  downPathPicks: readonly PortPick[] = DOWN_PATH_PICKS,
): BoundPorts {
  const picked = new Set<PortName>();
  const bound = new Map<PortName, { implementation: ImplementationName; value: unknown }>();
  /** Binds each line of one table, and refuses, naming each, the ports it leaves unbound of those it must bind. */
  const bindTable = (table: readonly PortPick[], ports: readonly PortName[]): void => {
    const missing: string[] = [];
    for (const pick of table) {
      if (picked.has(pick.port)) throw new WiringError(`port ${pick.port} is bound twice in ${environment}`);
      picked.add(pick.port);
      const implementation = pick[environment];
      const value: unknown = sets[implementation]?.[pick.port];
      if (value === undefined) missing.push(`${pick.port} (no ${implementation} implementation)`);
      else bound.set(pick.port, { implementation, value });
    }
    for (const port of ports) if (!picked.has(port)) missing.push(`${port} (no pick)`);
    if (missing.length > 0) {
      throw new WiringError(`left unbound in ${environment}: ${missing.join(", ")}`);
    }
  };
  bindTable(picks, PORTS);
  bindTable(downPathPicks, DOWN_PATH_PORTS);

  const take = <P extends PortName>(port: P): Ports[P] => bound.get(port)?.value as Ports[P];
  return {
    ports: {
      linqVerify: take("linqVerify"),
      sealing: take("sealing"),
      chatOpen: take("chatOpen"),
      safetyRead: take("safetyRead"),
      turnRow: take("turnRow"),
      bundles: take("bundles"),
      targets: take("targets"),
      frontier: take("frontier"),
      stateReads: take("stateReads"),
      turnFace: take("turnFace"),
      decide: take("decide"),
      gate: take("gate"),
      composeInput: take("composeInput"),
      composer: take("composer"),
      finalize: take("finalize"),
      outbox: take("outbox"),
      sendState: take("sendState"),
      dataAccess: take("dataAccess"),
      linqSend: take("linqSend"),
      arming: take("arming"),
      linqDirect: take("linqDirect"),
      stopOrStart: take("stopOrStart"),
      timerFire: take("timerFire"),
    },
    bindings: PORTS.map((port) => ({ port, implementation: pickOf(picks, port, environment) })),
    downPathBindings: DOWN_PATH_PORTS.map((port) => ({
      port,
      implementation: pickOf(downPathPicks, port, environment),
    })),
  };
}

/** The implementation a port's one pick names for the environment (every port has exactly one pick by now). */
function pickOf(picks: readonly PortPick[], port: PortName, environment: Environment): ImplementationName {
  const pick = picks.find((candidate) => candidate.port === port);
  if (pick === undefined) throw new WiringError(`left unbound in ${environment}: ${port} (no pick)`);
  return pick[environment];
}
