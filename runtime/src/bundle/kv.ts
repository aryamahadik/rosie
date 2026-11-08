// The bundle KV namespace as the pin reads it (T-249). The binding is T-277's (wrangler.jsonc `kv_namespaces`, BUNDLES);
// env.staging has no copy of it until T-566, so there the actor has none and reads every value from PostgreSQL's copy.

import type { BundleKv } from "./types";

declare global {
  namespace Cloudflare {
    interface Env {
      /** The bundle KV namespace (wrangler.jsonc, T-277): one value per K-01 v1 key. Missing where the environment has no copy. */
      BUNDLES?: KVNamespace;
    }
  }
}

/** The binding as the pin reads it, a value's text by its key; null when the environment has no binding. */
export function bundleKvOf(namespace: KVNamespace | undefined): BundleKv | null {
  if (namespace === undefined) return null;
  return { get: (key) => namespace.get(key, "text") };
}
