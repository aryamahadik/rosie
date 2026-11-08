// How the minute sweep and staging's Fire now reach a clock row's handle actor (T-254): the directory names the actor
// of the row's handle (K-04 handles.id to actorNameOf's name), and the HandleActor namespace gives its stub. The
// namespace is the HANDLE_ACTOR binding of wrangler.jsonc (T-276; not edited here, NQ-RT-5); env.staging has no copy
// until T-566, so there the Worker has none and a handle's row is left to its actor's own alarm.

import type { ClockActorRpc, ClockActors, ClockDeps } from "./types";

declare global {
  namespace Cloudflare {
    interface Env {
      /** The HandleActor namespace (wrangler.jsonc, T-276). Missing where the environment has no copy (env.staging until T-566). */
      HANDLE_ACTOR?: DurableObjectNamespace;
    }
  }
}

/** The HANDLE_ACTOR binding as the sweep and Fire now use it; null where the environment has none. */
export function clockActorsOf(env: Cloudflare.Env): ClockActors<DurableObjectId> | null {
  const namespace = env.HANDLE_ACTOR;
  if (namespace === undefined) return null;
  return {
    idFromName: (name) => namespace.idFromName(name),
    // The stub's own type cannot carry the actor's RPC methods (the class is the actor module's), so it is typed here.
    get: (id) => namespace.get(id) as unknown as ClockActorRpc,
  };
}

/** The actor of a clock row's handle, or null when no namespace is bound or the directory cannot name it. */
export async function actorOf(
  set: ClockDeps,
  actors: ClockActors | null,
  handleId: string,
): Promise<ClockActorRpc | null> {
  if (actors === null) return null;
  let name: unknown;
  try {
    name = await set.directory.actorNameOf(handleId);
  } catch {
    return null;
  }
  if (typeof name !== "string" || name === "") return null;
  return actors.get(actors.idFromName(name));
}
