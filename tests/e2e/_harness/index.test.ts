// The end-to-end harness loads a double by port name (T-003). Run by `npm run test:e2e`.

import { describe, expect, it } from "vitest";

import { createDoubleLoader, loadDouble } from "./index";

describe("the end-to-end harness", () => {
  it("loads a double by port name through the shared loader", async () => {
    const loader = createDoubleLoader([
      {
        port: "sample",
        module: "tests/contract/_harness/sample/sample-double.ts",
        exports: ["createSampleDouble"],
      },
    ]);
    const loaded = await loader.load("sample");
    const create = loaded.createSampleDouble as () => { call(input: string): string };
    expect(create().call("e2e")).toBe("sample:e2e");
  });

  it("refuses a port that has no double", async () => {
    await expect(loadDouble("no-such-port")).rejects.toThrow('double for port "no-such-port"');
  });
});
