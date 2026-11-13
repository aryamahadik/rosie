// T-290: the Tool API's one validator holds the frozen schemas, and agrees with the contracts' own fixtures: K-09 v1's
// accepted exchanges pass their call's request and response or errors, its refused requests are refused, and K-08 v1.1's
// span refuses a raw phone number and a person's words. T-1150: it checks K-09 v1's 29 calls by K-09 v1.5's definitions
// of the same name, so the walking skeleton's turn 1 passes (build-frontier-s1-01.json's sign-up door; commit-s1-01.json's
// turn with the service and chat id of its last text, both or neither: default 135), every v1 fixture gets the answer
// K-09 v1 gives it, and the calls v1.1 to v1.4 add stay unknown. T-1174: composeInput alone is checked by K-09 v1.6's
// definitions, so its v1.6 exchanges pass (term facts, fixedLineRow, masterLineMissing), its refused ones are refused as
// v1.6 says, and every v1 composeInput exchange keeps its verdict. T-1189: SCHEMA_FILES, the one list the validator and
// the prebuilt code read, is the closure of K-09 v1.5's, v1.6's and K-08 v1.1's $refs (validator.worker.test.ts checks
// composeInput by v1.6 inside workerd). Values come only from the contracts' fixtures (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CALL_NAMES, CALLER_KINDS, isCallName, type CallName } from "./calls";
import {
  acceptedExchanges,
  contractFile,
  fixture,
  fixtureEntries,
  recordingScope,
  traceFor,
} from "./test-support";
import { createToolApi, notBuiltHandlers } from "./tool-api";
import {
  AJV_OPTIONS,
  COMPOSE_INPUT_TOOL_API_SCHEMA_ID,
  CONTRACTS_DIR,
  MODEL_SCHEMA_ID,
  SCHEMA_FILES,
  TOOL_API_SCHEMA_ID,
  createToolApiValidator,
  formatProblems,
  loadToolApiSchemas,
  toolApiSchemaIdOf,
  type CallPart,
} from "./validator";

const validator = createToolApiValidator();

type Json = Record<string, unknown>;

const k09 = contractFile("tool-api/tool-api.v1.schema.json") as { $defs: Record<string, Json> };
const k09v15 = contractFile("tool-api/tool-api.v1.5.schema.json") as {
  $id: string;
  $defs: Record<string, Json>;
};

const PARTS: readonly CallPart[] = ["request", "response", "errors"];

/** The $id of K-09 v1, whose definitions the Tool API checked before v1.5. */
const K09_V1_ID = "https://rosie.invalid/contracts/tool-api/tool-api.v1.schema.json";

/** Ajv's compiler on the validator's files (K-09 v1 among them), for K-09 v1's answers beside v1.5's. */
const ajv = new Ajv2020(AJV_OPTIONS);
for (const schema of loadToolApiSchemas()) ajv.addSchema(schema);

/** The problem lines a K-09 definition (`<call>.<part>`) of the schema `schemaId` finds in `value`. */
function problemsUnder(schemaId: string, definition: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${schemaId}#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
  return validate(value) ? [] : formatProblems(validate.errors);
}

/** Every file the $refs of `roots` reach, relative to contracts/ (contracts/README.md convention 2). */
function closureOf(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift() ?? "";
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...referencedFiles(file));
  }
  return [...seen].sort();
}

/** A turn 1 exchange of K-09 v1.5 (contracts/tool-api/fixtures), freshly parsed. */
function v15Exchange(file: string): { call: CallName; request: Json; outcome: unknown } {
  return fixture(file) as { call: CallName; request: Json; outcome: unknown };
}

/** commit-s1-01.json's request with its turn changed by `change`. */
function commitS101With(change: (turn: Json) => void): Json {
  const { request } = v15Exchange("commit-s1-01.json");
  change(request.turn as Json);
  return request;
}

/** The chat id commit-s1-01.json's turn carries (K-06 text-imessage.json's form): never in a problem line. */
const CHAT_ID = "linq-chat-demo-sam";

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
    // K-09 v1.6 and K-03 v1.1 (composeInput's, T-1174) are in the set itself since T-1189, and it is still closed.
    expect(files.has("tool-api/tool-api.v1.6.schema.json")).toBe(true);
    expect(files.has("message-plan/message-plan.v1.1.schema.json")).toBe(true);
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

// ---------------------------------------------------------------------------------------------------------------
// T-1150: K-09 v1.5's definitions of K-09 v1's 29 calls

describe("K-09 v1's 29 calls, each checked by K-09 v1.5's definition of the same name", () => {
  it("checks against K-09 v1.5, and K-02 v1.1 is the frontier's", () => {
    expect(TOOL_API_SCHEMA_ID).toBe(k09v15.$id);
    expect(MODEL_SCHEMA_ID).toBe((contractFile("model/model.v1.1.schema.json") as { $id: string }).$id);
  });

  it("holds exactly the files K-09 v1.5's, v1.6's and K-08 v1.1's $refs reach: K-06 v1, K-02 v1.1, K-03 v1.1 and K-09 v1 to v1.4 among them", () => {
    const reached = closureOf([
      "tool-api/tool-api.v1.5.schema.json",
      "tool-api/tool-api.v1.6.schema.json",
      "event-trace/event-trace.v1.1.schema.json",
    ]);
    expect([...SCHEMA_FILES].sort()).toEqual(reached);
    expect(reached).toEqual(
      expect.arrayContaining([
        "inbound-event/inbound-event.v1.schema.json",
        "model/model.v1.1.schema.json",
        "message-plan/message-plan.v1.1.schema.json",
        "tool-api/tool-api.v1.schema.json",
        "tool-api/tool-api.v1.4.schema.json",
      ]),
    );
    // v1.6 (composeInput's, T-1174) adds exactly K-03 v1.1 and itself to what v1.5's and K-08 v1.1's $refs reach.
    const v15Reached = closureOf([
      "tool-api/tool-api.v1.5.schema.json",
      "event-trace/event-trace.v1.1.schema.json",
    ]);
    expect(reached.filter((file) => !v15Reached.includes(file))).toEqual([
      "message-plan/message-plan.v1.1.schema.json",
      "tool-api/tool-api.v1.6.schema.json",
    ]);
  });

  it("K-09 v1.5 names each call's request, response and errors, and lists every call of v1 among its own", () => {
    for (const call of CALL_NAMES) {
      for (const part of PARTS) expect(k09v15.$defs[`${call}.${part}`], `${call}.${part}`).toBeDefined();
    }
    const v14 = contractFile("tool-api/tool-api.v1.4.schema.json") as {
      $defs: { callName: { enum: string[] } };
    };
    expect(k09v15.$defs.callName).toEqual({ $ref: "tool-api.v1.4.schema.json#/$defs/callName" });
    expect(v14.$defs.callName.enum).toEqual(expect.arrayContaining([...CALL_NAMES]));
  });

  it("the calls v1.1 to v1.4 add are no calls of the Tool API: the validator throws, and the base answers unknownCall", async () => {
    const v14 = contractFile("tool-api/tool-api.v1.4.schema.json") as {
      $defs: { callName: { enum: string[] } };
    };
    const added = v14.$defs.callName.enum.filter((call) => !(CALL_NAMES as readonly string[]).includes(call));
    expect(added.length).toBeGreaterThan(0);
    const api = createToolApi({ validator, scope: recordingScope(), handlers: notBuiltHandlers() });
    for (const call of added) {
      expect(isCallName(call), call).toBe(false);
      expect(() => validator.check(call as CallName, "request", {}), call).toThrow("not a call of K-09 v1");
      const { trace } = traceFor({});
      expect(await api.call(call, {}, trace), call).toEqual({ error: "unknownCall" });
    }
  });
});

describe("every v1 fixture gets the answer K-09 v1 gives it", () => {
  const entries = fixtureEntries().filter((entry) => {
    const [call, part] = entry.def.split(".");
    return isCallName(call) && (part === "exchange" || (PARTS as readonly string[]).includes(part ?? ""));
  });

  it("reads all 59 accepted exchanges, the six refused requests and the exchange a named rule refuses", () => {
    const accepted = entries.filter((entry) => entry.expect === "accept" && entry.def.endsWith(".exchange"));
    const refused = entries.filter((entry) => entry.expect === "refuse" && entry.def.endsWith(".request"));
    expect(accepted).toHaveLength(59);
    expect(refused).toHaveLength(6);
    expect(entries.filter((entry) => !accepted.includes(entry) && !refused.includes(entry))).toEqual([
      expect.objectContaining({
        def: "gateAndCommit.exchange",
        rule: "rereadBeforeQuestion",
        expect: "refuse",
      }),
    ]);
  });

  for (const entry of entries) {
    it(`${entry.file}: K-09 v1.5's definitions give K-09 v1's problem lines (composeInput's v1.6 its verdict)`, () => {
      const [call, part] = entry.def.split(".") as [CallName, string];
      const document = fixture(entry.file) as Json;
      const checks: [CallPart, unknown][] =
        part === "exchange"
          ? [
              ["request", document.request],
              ["response", document.outcome],
              ["errors", document.outcome],
            ]
          : [[part as CallPart, document]];
      for (const [checked, value] of checks) {
        const v1 = problemsUnder(K09_V1_ID, `${call}.${checked}`, value);
        const lines = validator.check(call, checked, value);
        if (call === "composeInput" && checked !== "request") {
          // v1.6's response and errors are v1's widened (K-03 v1.1's input; two errors more): the same verdict, and
          // nothing to say where v1 accepts; a refusal names v1.6's own branches.
          expect(lines.length === 0, `${call}.${checked}`).toBe(v1.length === 0);
        } else {
          expect(lines, `${call}.${checked}`).toEqual(v1);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// T-1174: composeInput by K-09 v1.6's definitions

describe("composeInput is checked by K-09 v1.6's definitions, every other call by v1.5's (T-1174)", () => {
  const k09v16 = contractFile("tool-api/tool-api.v1.6.schema.json") as {
    $id: string;
    $defs: Record<string, Json>;
  };
  const v16Entries = (
    JSON.parse(readFileSync(path.join(CONTRACTS_DIR, "tool-api", "fixtures", "index.json"), "utf8")) as {
      fixtures: { file: string; version: string; def: string; expect: string; rule?: string }[];
    }
  ).fixtures.filter((entry) => entry.version === "v1.6");

  it("names v1.6 for composeInput alone, whose files the validator holds beside v1.5's", () => {
    expect(COMPOSE_INPUT_TOOL_API_SCHEMA_ID).toBe(k09v16.$id);
    for (const call of CALL_NAMES) {
      expect(toolApiSchemaIdOf(call), call).toBe(
        call === "composeInput" ? COMPOSE_INPUT_TOOL_API_SCHEMA_ID : TOOL_API_SCHEMA_ID,
      );
    }
    const reached = closureOf([
      "tool-api/tool-api.v1.5.schema.json",
      "tool-api/tool-api.v1.6.schema.json",
      "event-trace/event-trace.v1.1.schema.json",
    ]);
    expect([...SCHEMA_FILES].sort()).toEqual(reached);
    expect(k09v16.$defs["composeInput.request"]).toEqual({
      $ref: "tool-api.v1.5.schema.json#/$defs/composeInput.request",
    });
  });

  it("v1.6 holds six composeInput fixtures: three accepted, three refused", () => {
    expect(v16Entries.map((entry) => [entry.def, entry.expect])).toEqual([
      ["composeInput.exchange", "accept"],
      ["composeInput.exchange", "accept"],
      ["composeInput.exchange", "accept"],
      ["composeInput.exchange", "refuse"],
      ["composeInput.exchange", "refuse"],
      ["composeInput.exchange", "refuse"],
    ]);
  });

  for (const file of [
    "compose-input-s1-02-v1.6.json",
    "compose-input-fixed-line-row.json",
    "compose-input-master-line-missing.json",
  ]) {
    it(`${file}: its request passes, its outcome passes v1.6's response or errors, and v1.5 refuses the outcome`, () => {
      const { request, outcome } = v15Exchange(file);
      expect(validator.check("composeInput", "request", request)).toEqual([]);
      const asResponse = validator.check("composeInput", "response", outcome);
      const asErrors = validator.check("composeInput", "errors", outcome);
      expect(asResponse.length === 0 || asErrors.length === 0).toBe(true);
      const underV15 = [
        ...problemsUnder(TOOL_API_SCHEMA_ID, "composeInput.response", outcome),
        ...problemsUnder(TOOL_API_SCHEMA_ID, "composeInput.errors", outcome),
      ];
      expect(underV15.length).toBeGreaterThan(0);
      expect(
        problemsUnder(TOOL_API_SCHEMA_ID, "composeInput.response", outcome).length === 0 ||
          problemsUnder(TOOL_API_SCHEMA_ID, "composeInput.errors", outcome).length === 0,
      ).toBe(false);
    });
  }

  it("refuses a term fact with no source line, or one that names a slot, and no problem line holds its words", () => {
    for (const file of [
      "invalid/refuse-term-fact-no-source.json",
      "invalid/refuse-term-fact-names-slot.json",
    ]) {
      const { outcome } = v15Exchange(file);
      const asResponse = validator.check("composeInput", "response", outcome);
      expect(asResponse, file).not.toEqual([]);
      expect(validator.check("composeInput", "errors", outcome), file).not.toEqual([]);
      expect(asResponse.join("\n"), file).not.toContain("$2");
    }
  });

  it("takes a term fact that is no card line, which the schema cannot see: only compose input's own build gives card lines", () => {
    const { request, outcome } = v15Exchange("invalid/refuse-term-fact-not-card-line.json");
    expect(validator.check("composeInput", "request", request)).toEqual([]);
    expect(validator.check("composeInput", "response", outcome)).toEqual([]);
  });
});

describe("the walking skeleton's turn 1 (K-09 v1.5): the sign-up door and the turn's service and chat id", () => {
  for (const file of ["build-frontier-s1-01.json", "commit-s1-01.json"]) {
    it(`${file}: its request passes, and its outcome passes the call's response, as K-09 v1 never let it`, () => {
      const { call, request, outcome } = v15Exchange(file);
      expect(validator.check(call, "request", request)).toEqual([]);
      expect(validator.check(call, "response", outcome)).toEqual([]);
      const underV1 = [
        ...problemsUnder(K09_V1_ID, `${call}.request`, request),
        ...problemsUnder(K09_V1_ID, `${call}.response`, outcome),
      ];
      expect(underV1).not.toEqual([]);
    });
  }

  it("build-frontier-s1-01.json's frontier offers the sign-up door (K-02 v1.1)", () => {
    const { outcome } = v15Exchange("build-frontier-s1-01.json");
    const { context } = outcome as { context: { choices: Json[] } };
    expect(context.choices.map((choice) => [choice.kind, choice.door, choice.step])).toEqual([
      ["door", "signUp", "S1-01"],
    ]);
  });

  it("commit-s1-01.json's turn carries the service and the chat id, beside K-05 v1's seven fields", () => {
    const { request } = v15Exchange("commit-s1-01.json");
    const turn = request.turn as Json;
    const k05 = contractFile("data-access/data-access.v1.schema.json") as {
      $defs: { turn: { properties: Json } };
    };
    expect(Object.keys(turn)).toEqual([...Object.keys(k05.$defs.turn.properties), "service", "chatId"]);
    expect([turn.service, turn.chatId]).toEqual(["imessage", CHAT_ID]);
  });

  it("both or neither: a turn with the service and no chat id, or the chat id and no service, is refused", () => {
    const noChatId = commitS101With((turn) => {
      delete turn.chatId;
    });
    const noService = commitS101With((turn) => {
      delete turn.service;
    });
    expect(validator.check("gateAndCommit", "request", noChatId)).toContain(
      "/turn must have property chatId when property service is present",
    );
    expect(validator.check("gateAndCommit", "request", noService)).toContain(
      "/turn must have property service when property chatId is present",
    );
    const neither = commitS101With((turn) => {
      delete turn.service;
      delete turn.chatId;
    });
    expect(validator.check("gateAndCommit", "request", neither)).toEqual([]);
    const nullChatId = commitS101With((turn) => {
      turn.chatId = null;
    });
    expect(validator.check("gateAndCommit", "request", nullChatId)).toEqual([]);
  });

  it("a clock's firing carries neither: its turn with the service and chat id is refused", () => {
    const clock = fixture("clock-staff-invite-48h.json") as { request: Json & { turn: Json | null } };
    expect(validator.check("gateAndCommit", "request", clock.request)).toEqual([]);
    expect(clock.request.turn).not.toBeNull();
    const withText = {
      ...clock.request,
      turn: { ...clock.request.turn, service: "imessage", chatId: CHAT_ID },
    };
    expect(validator.check("gateAndCommit", "request", withText)).not.toEqual([]);
  });

  it("a service K-06 v1 does not name is refused, and no problem line holds the chat id", () => {
    const refusals = [
      commitS101With((turn) => {
        turn.service = "carrierPigeon";
      }),
      commitS101With((turn) => {
        delete turn.service;
      }),
      commitS101With((turn) => {
        turn.chatId = 42;
      }),
    ].map((request) => validator.check("gateAndCommit", "request", request));
    for (const problems of refusals) {
      expect(problems).not.toEqual([]);
      expect(problems.join("\n")).not.toContain(CHAT_ID);
    }
  });
});
