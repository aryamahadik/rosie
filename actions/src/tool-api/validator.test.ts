// T-290: the Tool API's one validator holds the frozen schemas, and agrees with the contracts' own fixtures: K-09 v1's
// accepted exchanges pass their call's request and response or errors, its refused requests are refused, and K-08 v1.1's
// span refuses a raw phone number and a person's words. Values come only from the contracts' fixtures (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CALL_NAMES, CALLER_KINDS } from "./calls";
import { acceptedExchanges, contractFile, fixture, fixtureEntries } from "./test-support";
import {
  CONTRACTS_DIR,
  SCHEMA_FILES,
  createToolApiValidator,
  formatProblems,
  loadToolApiSchemas,
} from "./validator";

const validator = createToolApiValidator();

type Json = Record<string, unknown>;

const k09 = contractFile("tool-api/tool-api.v1.schema.json") as { $defs: Record<string, Json> };

/** Every file a schema's $refs name, relative to contracts/. */
function referencedFiles(file: string): string[] {
  const refs: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref" && typeof inner === "string") refs.push(inner);
        else walk(inner);
      }
    }
  };
  walk(JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")));
  return refs
    .map((ref) => ref.split("#")[0] ?? "")
    .filter((target) => target !== "")
    .map((target) => path.posix.join(path.posix.dirname(file), target));
}

describe("the validator holds K-09 v1 and every schema it refers to", () => {
  it("registers exactly the calls of $defs/callName, in its order", () => {
    expect(k09.$defs.callName?.enum).toEqual([...CALL_NAMES]);
  });

  it("knows exactly the caller kinds of $defs/caller", () => {
    const caller = k09.$defs.caller as { properties: { kind: { enum: string[] } } };
    expect(caller.properties.kind.enum).toEqual([...CALLER_KINDS]);
  });

  it("holds a closed set of schema files: every $ref of each names a file of the set", () => {
    const files = new Set<string>(SCHEMA_FILES);
    for (const file of SCHEMA_FILES) {
      for (const target of referencedFiles(file))
        expect(files.has(target), `${file} refers to ${target}`).toBe(true);
    }
    expect(loadToolApiSchemas()).toHaveLength(SCHEMA_FILES.length);
  });

  it("compiles every call's request, response and errors in strict mode, and an empty request is refused", () => {
    for (const call of CALL_NAMES) {
      expect(validator.check(call, "request", {}), call).not.toEqual([]);
      expect(Array.isArray(validator.check(call, "response", {})), call).toBe(true);
      expect(validator.check(call, "errors", {}), call).not.toEqual([]);
    }
  });

  it("throws for a name that is no call, rather than checking against nothing", () => {
    expect(() => validator.check("bookEverything" as never, "request", {})).toThrow("not a call of K-09 v1");
  });
});

describe("the validator agrees with K-09 v1's fixtures", () => {
  const exchanges = acceptedExchanges();

  it("reads all 59 accepted exchanges", () => {
    expect(exchanges).toHaveLength(59);
  });

  for (const { file, exchange } of exchanges) {
    it(`${file}: the request passes ${exchange.call}.request and the outcome its response or errors`, () => {
      expect(validator.check(exchange.call, "request", exchange.request)).toEqual([]);
      const asResponse = validator.check(exchange.call, "response", exchange.outcome);
      const asErrors = validator.check(exchange.call, "errors", exchange.outcome);
      expect(asResponse.length === 0 || asErrors.length === 0).toBe(true);
    });
  }

  const refusedRequests = fixtureEntries().filter(
    (entry) => entry.expect === "refuse" && entry.def.endsWith(".request"),
  );

  it("reads the six refused requests", () => {
    expect(refusedRequests.map((entry) => entry.file)).toHaveLength(6);
  });

  for (const entry of refusedRequests) {
    it(`${entry.file} is refused by ${entry.def}`, () => {
      const call = entry.def.replace(/[.]request$/u, "") as (typeof CALL_NAMES)[number];
      expect(validator.check(call, "request", fixture(entry.file))).not.toEqual([]);
    });
  }
});

describe("the validator holds spans to K-08 v1.1", () => {
  it("accepts K-08's accepted span fixtures", () => {
    for (const file of ["span-places-call.json", "span-effect-run-retry.json"]) {
      expect(validator.checkSpan(contractFile(`event-trace/fixtures/${file}`)), file).toEqual([]);
    }
  });

  it("refuses refuse-raw-phone-in-span.json, and accepts it once the handle reference is the handle id", () => {
    const refused = contractFile("event-trace/fixtures/invalid/refuse-raw-phone-in-span.json") as Json;
    expect(validator.checkSpan(refused)).not.toEqual([]);
    expect(validator.checkSpan({ ...refused, handle_ref: "handle-sam" })).toEqual([]);
  });

  it("refuses refuse-raw-text-in-span.json, and accepts it once the words are dropped", () => {
    const refused = contractFile("event-trace/fixtures/invalid/refuse-raw-text-in-span.json") as Json;
    expect(validator.checkSpan(refused)).not.toEqual([]);
    expect(validator.checkSpan({ ...refused, got: { kind: "text" } })).toEqual([]);
  });
});

describe("problem lines", () => {
  it("name the place and what the schema wants, never the value", () => {
    const { request } = fixture("stop-other-number.json") as { request: Json };
    const problems = validator.check("recordStopOrStart", "request", { ...request, phone: "+15555550131" });
    expect(problems).toEqual(["(root) must NOT have additional properties (phone)"]);
    const badKind = validator.check("recordStopOrStart", "request", {
      ...request,
      kind: "Ben T. please stop",
    });
    expect(badKind.join(" ")).not.toContain("Ben T.");
  });

  it("stop at 20 lines and say how many more there were", () => {
    const errors = Array.from({ length: 25 }, (_, index) => ({
      instancePath: `/x/${String(index)}`,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    }));
    const lines = formatProblems(errors);
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe("and 5 more");
  });
});
