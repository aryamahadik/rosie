// T-410: one folder per port, and no SMS (DL-012): no adapters/src/sms folder and no SMS export.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as shared from "./index";
import { OUTSIDE_CALL_HOPS, PORT_FOLDERS, PORT_PROVIDERS, PROVIDERS } from "./ports";
import * as samples from "./samples";

const ADAPTERS_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the adapters' ports", () => {
  it("lists the seven port folders of the plan and no sms", () => {
    expect([...PORT_FOLDERS]).toEqual(["linq", "email", "stripe", "calendar", "places", "files", "geo"]);
  });

  it("gives every K-08 provider but the model's to exactly one port", () => {
    const named = Object.values(PORT_PROVIDERS).flat();
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual(PROVIDERS.filter((provider) => provider !== "anthropic").sort());
  });

  it("names the outside-call hops K-08 requires a provider, call and attempt on", () => {
    expect([...OUTSIDE_CALL_HOPS]).toEqual(["portCall", "effectRun", "dispatch"]);
  });
});

describe("SMS is archived (DL-012)", () => {
  it("has no adapters/src/sms folder, in any case", () => {
    const folders = readdirSync(ADAPTERS_SRC, { withFileTypes: true }).map((entry) =>
      entry.name.toLowerCase(),
    );
    expect(folders).not.toContain("sms");
    expect(folders.filter((name) => name.includes("sms"))).toEqual([]);
  });

  it("has no sms port, provider or export", () => {
    expect(PORT_FOLDERS.map(String)).not.toContain("sms");
    expect([...PROVIDERS].filter((provider) => /sms/i.test(provider))).toEqual([]);
    for (const module of [shared, samples]) {
      expect(Object.keys(module).filter((name) => /sms/i.test(name))).toEqual([]);
    }
  });
});
