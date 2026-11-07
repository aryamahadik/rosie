// The key of a request (T-004): the same request always gives the same key, whatever order its properties are written in.

import { createHash } from "node:crypto";

/** The JSON text of a value with every object's keys sorted. Refuses what JSON cannot hold (undefined, NaN, functions). */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("a request holds a number that is not finite");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${(value as unknown[]).map(canonicalJson).join(",")}]`;
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("a request holds an object that is not plain JSON");
      const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`a request holds a ${typeof value}, which JSON cannot hold`);
  }
}

/** `<kind>:<sha256 of the request's canonical JSON>`. */
export function requestKey(kind: string, request: unknown): string {
  return `${kind}:${createHash("sha256").update(canonicalJson(request)).digest("hex")}`;
}
