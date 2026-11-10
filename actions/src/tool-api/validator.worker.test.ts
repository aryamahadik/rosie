// T-1144's proof, widened by T-1150 and T-1189, inside the Workers runtime (workerd): the Tool API's validator checks
// K-09 v1's 29 calls by K-09 v1.5's definitions of the same name, composeInput's by K-09 v1.6's (T-1174, T-1189: its
// answer is K-03 v1.1's input, term facts among its facts, or one of its errors, fixedLineRow and masterLineMissing
// among them), and K-08 v1.1's span, with the prebuilt code (Ajv's standalone code, compiled ahead of time from the
// same definitions by `npm run build:validators`), never with Ajv's compiler, which makes each check's code with new
// Function: the Workers runtime refuses that when it serves a request. This test pool's workerd does not refuse it (a
// compiled check would not throw here), so the test does not lean on a throw: it traps Function and eval while
// validator.ts makes its validator and runs every check below, and the trap counts no call; the same trap counts Ajv's
// compiler.
//
// The build also records, in ajv-answers.js, what Ajv's compiler answers in Node (validator.ts's own setup) to every
// check on the contracts' fixtures: each K-09 fixture of a K-09 v1 call (every version: K-09 v1.2 to v1.4 add fixtures
// only for calls v1 does not have, v1.5 turn 1's two, v1.6 composeInput's six), against the version validator.ts checks
// its call by; each K-08 span fixture; and {} against each of the Tool API's 88 definitions. Here, each check gives the
// same verdict and the same errors (path, schema path, keyword, params, message), so validator.ts gives the same
// problem lines; and validator.ts accepts every accepted fixture validator.test.ts checks in Node and refuses every
// refused one: compose-input-s1-02-v1.6.json's term facts are accepted here, and a term fact with no source line is
// refused. The build's K-02 v1.1 checks are the frontier's (frontier/assemble/check.worker.test.ts). Values come only
// from the contracts' fixtures (rule 9).

import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import eventTraceIndex from "../../../contracts/event-trace/fixtures/index.json";
import refuseRawPhoneInSpan from "../../../contracts/event-trace/fixtures/invalid/refuse-raw-phone-in-span.json";
import modelIndex from "../../../contracts/model/fixtures/index.json";
import buildFrontierS101 from "../../../contracts/tool-api/fixtures/build-frontier-s1-01.json";
import buildFrontierS102 from "../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS101 from "../../../contracts/tool-api/fixtures/commit-s1-01.json";
import composeInputFixedLineRow from "../../../contracts/tool-api/fixtures/compose-input-fixed-line-row.json";
import composeInputMasterLineMissing from "../../../contracts/tool-api/fixtures/compose-input-master-line-missing.json";
import composeInputS102V16 from "../../../contracts/tool-api/fixtures/compose-input-s1-02-v1.6.json";
import toolApiIndex from "../../../contracts/tool-api/fixtures/index.json";
import refuseTeamWithoutTick from "../../../contracts/tool-api/fixtures/invalid/refuse-team-without-tick.json";
import refuseTermFactNoSource from "../../../contracts/tool-api/fixtures/invalid/refuse-term-fact-no-source.json";
import { K02_PARTS } from "../frontier/assemble/check";
import { CALL_NAMES, type CallName } from "./calls";
import { ajvAnswers, type AjvCheck } from "./generated/ajv-answers";
import { build, definitions } from "./generated/validators";
import {
  AJV_OPTIONS,
  COMPOSE_INPUT_TOOL_API_SCHEMA_ID,
  EVENT_TRACE_SCHEMA_ID,
  MODEL_SCHEMA_ID,
  RUNS_IN_WORKERD,
  SCHEMA_FILES,
  TOOL_API_SCHEMA_ID,
  createToolApiValidator,
  formatProblems,
  loadToolApiSchemas,
  toolApiSchemaIdOf,
  type CallPart,
  type ToolApiValidator,
} from "./validator";

type Json = Record<string, unknown>;

const PARTS: readonly CallPart[] = ["request", "response", "errors"];
const SPAN_REF = `${EVENT_TRACE_SCHEMA_ID}#/$defs/span`;
const TOOL_API_DEFS = `${TOOL_API_SCHEMA_ID}#/$defs/`;
const V1_6_DEFS = `${COMPOSE_INPUT_TOOL_API_SCHEMA_ID}#/$defs/`;
const MODEL_DEFS = `${MODEL_SCHEMA_ID}#/$defs/`;

/** The prebuilt validator: inside workerd, createToolApiValidator() takes no schemas and compiles nothing. */
const validator = createToolApiValidator();

/** The Tool API's recorded checks: K-09 v1.5's, v1.6's (composeInput's) and K-08's span (K-02's are the frontier's). */
const TOOL_API_CHECKS = ajvAnswers.checks.filter(
  (check) =>
    check.definition === SPAN_REF ||
    check.definition.startsWith(TOOL_API_DEFS) ||
    check.definition.startsWith(V1_6_DEFS),
);

/** The value a check reads: the fixture's value at its path (an exchange's request or outcome, or the whole file), or {}. */
function valueOf(check: AjvCheck): unknown {
  let value: unknown = check.source === null ? {} : ajvAnswers.fixtures[check.source];
  for (const key of check.at) value = (value as Record<string | number, unknown>)[key];
  return value;
}

/**
 * The call and part of a recorded K-09 check; throws unless it is against the version validator.ts checks the call by
 * (toolApiSchemaIdOf: v1.6 for composeInput, v1.5 for every other call).
 */
function callPartOf(definition: string): [CallName, CallPart] {
  const prefix = [TOOL_API_DEFS, V1_6_DEFS].find((each) => definition.startsWith(each));
  if (prefix === undefined) throw new Error(`${definition} is not K-09 v1.5's or v1.6's`);
  const [call, part] = definition.slice(prefix.length).split(".") as [CallName, CallPart];
  if (`${toolApiSchemaIdOf(call)}#/$defs/` !== prefix) {
    throw new Error(`${definition} is not of the K-09 version validator.ts checks ${call} by`);
  }
  return [call, part];
}

/** A validator's problem lines for one check: K-08's span, or a call's part of K-09 v1.5 or v1.6. */
function linesOf(checker: ToolApiValidator, check: AjvCheck, value: unknown): string[] {
  if (check.definition === SPAN_REF) return checker.checkSpan(value);
  const [call, part] = callPartOf(check.definition);
  return checker.check(call, part, value);
}

/** The prebuilt code's validate function for a $ref; fails the test when it holds none. */
function prebuiltOf(ref: string): NonNullable<(typeof definitions)[string]> {
  const validate = definitions[ref];
  if (validate === undefined) throw new Error(`the prebuilt code holds no ${ref}`);
  return validate;
}

/** The Tool API's checks on each fixture (or on {}), by fixture, in the build's order. */
function checksBySource(): Map<string, AjvCheck[]> {
  const bySource = new Map<string, AjvCheck[]>();
  for (const check of TOOL_API_CHECKS) {
    const source = check.source ?? "{} against each definition";
    bySource.set(source, [...(bySource.get(source) ?? []), check]);
  }
  return bySource;
}

/** The recorded check of an exchange's outcome against v1.6's composeInput.<part>; fails the test when none. */
function recordedOutcome(file: string, part: "response" | "errors"): AjvCheck {
  const found = TOOL_API_CHECKS.find(
    (check) =>
      check.source === `tool-api/fixtures/${file}` &&
      check.at.join("/") === "outcome" &&
      check.definition === `${V1_6_DEFS}composeInput.${part}`,
  );
  if (found === undefined)
    throw new Error(`no check of ${file}'s outcome against v1.6's composeInput.${part}`);
  return found;
}

/**
 * Traps Function and eval (the ways to make code from a string that Ajv's compiler uses) until the test ends: each call
 * is counted, then made as asked.
 */
function trapCodeFromStrings(): { readonly calls: string[] } {
  const calls: string[] = [];
  const realFunction = globalThis.Function;
  const realEval = globalThis.eval;
  vi.stubGlobal(
    "Function",
    new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls.push("new Function");
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, self, args) {
        calls.push("Function()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  vi.stubGlobal(
    "eval",
    new Proxy(realEval, {
      apply(target, self, args) {
        calls.push("eval()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inside workerd, validator.ts makes no code", () => {
  it("runs in the Workers runtime, and validator.ts knows it", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(RUNS_IN_WORKERD).toBe(true);
  });

  it("the trap counts Ajv's compiler: compiling one schema makes its code with new Function", () => {
    const trap = trapCodeFromStrings();
    new Ajv2020(AJV_OPTIONS).compile({ type: "string" });
    expect(trap.calls).toContain("new Function");
  });

  it("making the validator and running every recorded check, with the trap set, makes no code at all", () => {
    const trap = trapCodeFromStrings();
    const trapped = createToolApiValidator();
    for (const check of TOOL_API_CHECKS) {
      const value = valueOf(check);
      expect(linesOf(trapped, check, value)).toEqual(formatProblems(check.errors));
      prebuiltOf(check.definition)(value);
    }
    expect(TOOL_API_CHECKS.length).toBeGreaterThan(88);
    expect(TOOL_API_CHECKS.filter((check) => check.definition.startsWith(V1_6_DEFS)).length).toBeGreaterThan(
      3,
    );
    expect(trap.calls).toEqual([]);
  });

  it("validator.ts never reaches for the compiler or the disk here: both refuse, by name", () => {
    expect(() => createToolApiValidator([])).toThrow("cannot run inside workerd");
    expect(() => loadToolApiSchemas()).toThrow("no contracts/ on disk");
  });
});

describe("the prebuilt code holds exactly validator.ts's definitions", () => {
  it("built for K-09 v1.5 and v1.6, K-08 v1.1 and K-02 v1.1 from validator.ts's schema files, with its Ajv options", () => {
    expect(build.toolApiSchemaId).toBe(TOOL_API_SCHEMA_ID);
    expect(build.toolApiSchemaId).toBe("https://rosie.invalid/contracts/tool-api/tool-api.v1.5.schema.json");
    expect(build.composeInputToolApiSchemaId).toBe(COMPOSE_INPUT_TOOL_API_SCHEMA_ID);
    expect(build.composeInputToolApiSchemaId).toBe(
      "https://rosie.invalid/contracts/tool-api/tool-api.v1.6.schema.json",
    );
    expect([...build.composeInputToolApiCalls]).toEqual(["composeInput"]);
    expect(build.eventTraceSchemaId).toBe(EVENT_TRACE_SCHEMA_ID);
    expect(build.modelSchemaId).toBe(MODEL_SCHEMA_ID);
    expect([...build.schemaFiles].sort()).toEqual([...SCHEMA_FILES].sort());
    expect(build.schemaFiles).toEqual(
      expect.arrayContaining([
        "tool-api/tool-api.v1.6.schema.json",
        "message-plan/message-plan.v1.1.schema.json",
      ]),
    );
    expect(build.options).toEqual(AJV_OPTIONS);
    expect(Object.keys(build.sha256).sort()).toEqual([...SCHEMA_FILES].sort());
  });

  it("each of K-09 v1's 29 calls' request, response and errors (composeInput's v1.6's, every other v1.5's), the span, and K-02 v1.1's four: 92", () => {
    const toolApi = [
      ...CALL_NAMES.flatMap((call) =>
        PARTS.map((part) => `${toolApiSchemaIdOf(call)}#/$defs/${call}.${part}`),
      ),
      SPAN_REF,
    ];
    const frontier = K02_PARTS.map((part) => `${MODEL_DEFS}${part}`);
    expect(Object.keys(definitions).sort()).toEqual([...toolApi, ...frontier].sort());
    expect(toolApi).toHaveLength(88);
    expect(frontier).toHaveLength(4);
    expect(Object.keys(definitions).filter((ref) => ref.startsWith(V1_6_DEFS))).toEqual(
      PARTS.map((part) => `${V1_6_DEFS}composeInput.${part}`),
    );
    for (const part of PARTS)
      expect(definitions[`${TOOL_API_DEFS}composeInput.${part}`], part).toBeUndefined();
  });

  it("throws for a name that is no call, rather than checking against nothing", () => {
    expect(() => validator.check("bookEverything" as never, "request", {})).toThrow("not a call of K-09 v1");
    expect(() => validator.check("openRequest" as never, "request", {})).toThrow("not a call of K-09 v1");
  });
});

describe("every check gives the answer of Ajv's compiler in Node", () => {
  const bySource = checksBySource();

  it("the build recorded the compiler's answers on each K-09 fixture of a v1 call, each K-08 span and K-02's frontier fixtures", () => {
    const calls = new Set<string>(CALL_NAMES);
    const k09 = toolApiIndex.fixtures.filter((entry) => {
      const [call, part] = entry.def.split(".");
      return call !== undefined && calls.has(call) && ["exchange", ...PARTS].includes(part ?? "");
    });
    const k08 = eventTraceIndex.fixtures.filter((entry) => entry.def === "span");
    const k02 = modelIndex.fixtures.filter((entry) => (K02_PARTS as readonly string[]).includes(entry.def));
    const sources = [
      ...k09.map((entry) => `tool-api/fixtures/${entry.file}`),
      ...k08.map((entry) => `event-trace/fixtures/${entry.file}`),
      ...k02.map((entry) => `model/fixtures/${entry.file}`),
    ];
    expect(Object.keys(ajvAnswers.fixtures).sort()).toEqual([...sources].sort());
    // Every check of validator.test.ts's is among them: each v1 fixture of a v1 call, v1.5's turn 1 and v1.6's six.
    const v1 = k09
      .filter((entry) => entry.version === "v1")
      .map((entry) => `tool-api/fixtures/${entry.file}`);
    expect(v1.length).toBeGreaterThanOrEqual(59 + 6);
    expect(sources).toEqual(expect.arrayContaining(v1));
    expect(sources).toEqual(
      expect.arrayContaining([
        "tool-api/fixtures/build-frontier-s1-01.json",
        "tool-api/fixtures/commit-s1-01.json",
      ]),
    );
    const v16 = k09.filter((entry) => entry.version === "v1.6");
    expect(v16.map((entry) => entry.def)).toEqual(Array.from({ length: 6 }, () => "composeInput.exchange"));
    expect(sources).toEqual(expect.arrayContaining(v16.map((entry) => `tool-api/fixtures/${entry.file}`)));
    expect(bySource.get("{} against each definition")).toHaveLength(88);
    // Every composeInput check is against v1.6's definitions, whatever the fixture's version.
    const composeInputChecks = TOOL_API_CHECKS.filter((check) =>
      check.definition.includes("#/$defs/composeInput."),
    );
    expect(composeInputChecks.length).toBeGreaterThan(3 * 6);
    for (const check of composeInputChecks) expect(check.definition.startsWith(V1_6_DEFS)).toBe(true);
    // The recorded fixtures are the files themselves.
    expect(ajvAnswers.fixtures["tool-api/fixtures/build-frontier-s1-02.json"]).toEqual(buildFrontierS102);
    expect(ajvAnswers.fixtures["tool-api/fixtures/build-frontier-s1-01.json"]).toEqual(buildFrontierS101);
    expect(ajvAnswers.fixtures["tool-api/fixtures/commit-s1-01.json"]).toEqual(commitS101);
    expect(ajvAnswers.fixtures["tool-api/fixtures/compose-input-s1-02-v1.6.json"]).toEqual(
      composeInputS102V16,
    );
    expect(ajvAnswers.fixtures["tool-api/fixtures/invalid/refuse-term-fact-no-source.json"]).toEqual(
      refuseTermFactNoSource,
    );
    expect(ajvAnswers.fixtures["tool-api/fixtures/invalid/refuse-team-without-tick.json"]).toEqual(
      refuseTeamWithoutTick,
    );
    expect(ajvAnswers.fixtures["event-trace/fixtures/invalid/refuse-raw-phone-in-span.json"]).toEqual(
      refuseRawPhoneInSpan,
    );
  });

  for (const [source, checks] of bySource) {
    it(`${source}: the same verdict, errors and problem lines`, () => {
      for (const check of checks) {
        const value = valueOf(check);
        const where = `/${check.at.join("/")} against ${check.definition}`;
        const validate = prebuiltOf(check.definition);
        const valid = validate(value);
        expect(valid, where).toBe(check.valid);
        expect(valid ? [] : validate.errors, where).toEqual(check.errors);
        expect(linesOf(validator, check, value), where).toEqual(formatProblems(check.errors));
      }
    });
  }
});

describe("composeInput is checked by K-09 v1.6 inside workerd, as in Node (T-1189)", () => {
  it("toolApiSchemaIdOf names v1.6 for composeInput here too, and v1.5 for every other call", () => {
    for (const call of CALL_NAMES) {
      expect(toolApiSchemaIdOf(call), call).toBe(
        call === "composeInput" ? COMPOSE_INPUT_TOOL_API_SCHEMA_ID : TOOL_API_SCHEMA_ID,
      );
    }
  });

  it("compose-input-s1-02-v1.6.json's request and answer are accepted, a term fact with no source is refused, and the trap counts no call", () => {
    const trap = trapCodeFromStrings();
    const trapped = createToolApiValidator();
    const { request, outcome } = structuredClone(composeInputS102V16);
    // Its answer is K-03 v1.1's input, its four facts term facts with their source lines.
    expect(outcome.input.facts).toHaveLength(4);
    for (const fact of outcome.input.facts) expect(Object.keys(fact)).toEqual(["value", "source"]);
    expect(trapped.check("composeInput", "request", request)).toEqual([]);
    expect(trapped.check("composeInput", "response", outcome)).toEqual([]);
    expect(trapped.check("composeInput", "errors", outcome)).not.toEqual([]);
    // The same answer with the $2 fee's term fact missing its source line: refused as a response and as an error.
    const refused = structuredClone(refuseTermFactNoSource).outcome;
    const asResponse = trapped.check("composeInput", "response", refused);
    expect(asResponse).not.toEqual([]);
    expect(trapped.check("composeInput", "errors", refused)).not.toEqual([]);
    expect(trap.calls).toEqual([]);
    // Ajv's compiler gives both answers in Node, and the problem lines name places, never the fact's words.
    const accepted = recordedOutcome("compose-input-s1-02-v1.6.json", "response");
    expect([accepted.valid, accepted.errors]).toEqual([true, []]);
    const noSource = recordedOutcome("invalid/refuse-term-fact-no-source.json", "response");
    expect(noSource.valid).toBe(false);
    expect(asResponse).toEqual(formatProblems(noSource.errors));
    expect(asResponse.join("\n")).not.toContain("$2");
  });

  it("v1.6's two new errors, fixedLineRow and masterLineMissing, are accepted as composeInput's errors here", () => {
    const trap = trapCodeFromStrings();
    const trapped = createToolApiValidator();
    for (const exchange of [composeInputFixedLineRow, composeInputMasterLineMissing]) {
      const { request, outcome } = structuredClone(exchange);
      expect(trapped.check("composeInput", "request", request), outcome.error).toEqual([]);
      expect(trapped.check("composeInput", "errors", outcome), outcome.error).toEqual([]);
      expect(trapped.check("composeInput", "response", outcome), outcome.error).not.toEqual([]);
    }
    expect(trap.calls).toEqual([]);
  });
});

describe("validator.ts accepts and refuses as validator.test.ts does in Node", () => {
  const v1 = toolApiIndex.fixtures.filter((entry) => entry.version === "v1");
  const v16 = toolApiIndex.fixtures.filter((entry) => entry.version === "v1.6");
  const fixture = (file: string): unknown => ajvAnswers.fixtures[`tool-api/fixtures/${file}`];
  const accepted = v1.filter((entry) => entry.expect === "accept" && entry.def.endsWith(".exchange"));
  const refused = v1.filter((entry) => entry.expect === "refuse" && entry.def.endsWith(".request"));
  const v16Accepted = v16.filter((entry) => entry.expect === "accept");
  // Refused by the schema itself; refuse-term-fact-not-card-line.json is refused by its named rule alone.
  const v16Refused = v16.filter((entry) => entry.expect === "refuse" && entry.rule === undefined);

  it("reads all 59 accepted exchanges and the six refused requests, and v1.6's three accepted and two refused", () => {
    expect(accepted).toHaveLength(59);
    expect(refused).toHaveLength(6);
    expect(v16Accepted.map((entry) => entry.file)).toEqual([
      "compose-input-s1-02-v1.6.json",
      "compose-input-fixed-line-row.json",
      "compose-input-master-line-missing.json",
    ]);
    expect(v16Refused.map((entry) => entry.file)).toEqual([
      "invalid/refuse-term-fact-no-source.json",
      "invalid/refuse-term-fact-names-slot.json",
    ]);
  });

  for (const entry of [
    ...accepted,
    ...v16Accepted,
    { file: "build-frontier-s1-01.json" },
    { file: "commit-s1-01.json" },
  ]) {
    it(`${entry.file}: the request passes its call's request and the outcome its response or errors`, () => {
      const exchange = fixture(entry.file) as { call: CallName; request: unknown; outcome: unknown };
      expect(validator.check(exchange.call, "request", exchange.request)).toEqual([]);
      const asResponse = validator.check(exchange.call, "response", exchange.outcome);
      const asErrors = validator.check(exchange.call, "errors", exchange.outcome);
      expect(asResponse.length === 0 || asErrors.length === 0).toBe(true);
    });
  }

  for (const entry of refused) {
    it(`${entry.file} is refused by ${entry.def}`, () => {
      const call = entry.def.replace(/[.]request$/u, "") as CallName;
      expect(validator.check(call, "request", fixture(entry.file))).not.toEqual([]);
    });
  }

  for (const entry of v16Refused) {
    it(`${entry.file}: its request passes, and its outcome is refused as composeInput's response and errors`, () => {
      const exchange = fixture(entry.file) as { request: unknown; outcome: unknown };
      expect(validator.check("composeInput", "request", exchange.request)).toEqual([]);
      expect(validator.check("composeInput", "response", exchange.outcome)).not.toEqual([]);
      expect(validator.check("composeInput", "errors", exchange.outcome)).not.toEqual([]);
    });
  }

  it("takes a term fact that is no card line, which the schema cannot see, as validator.test.ts does in Node", () => {
    const { request, outcome } = fixture("invalid/refuse-term-fact-not-card-line.json") as {
      request: unknown;
      outcome: unknown;
    };
    expect(validator.check("composeInput", "request", request)).toEqual([]);
    expect(validator.check("composeInput", "response", outcome)).toEqual([]);
  });

  it("commit-s1-01.json's turn with its service and no chat id is refused here too (both or neither: default 135)", () => {
    const { request } = structuredClone(commitS101) as { request: Json & { turn: Json } };
    delete request.turn.chatId;
    expect(validator.check("gateAndCommit", "request", request)).toContain(
      "/turn must have property chatId when property service is present",
    );
  });

  for (const entry of eventTraceIndex.fixtures.filter((each) => each.def === "span")) {
    it(`K-08's ${entry.file} is ${entry.expect === "accept" ? "accepted" : "refused"} as a span`, () => {
      const problems = validator.checkSpan(ajvAnswers.fixtures[`event-trace/fixtures/${entry.file}`]);
      if (entry.expect === "accept") expect(problems).toEqual([]);
      else expect(problems).not.toEqual([]);
    });
  }
});
