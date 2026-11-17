// T-630's proofs (DL-867), on K-09's own frozen schemas and fixtures and the base's recording scope, never a database:
//   - K-09 v1's journey 1 and 2 calls are the four its README's table names, and saveSetupStep saves the 32 steps of its
//     request's variants; each of them is registered once, by the folder of its call task, and through the base every
//     call and every step a K-09 v1 exchange saves reaches that folder's handler, inside its business's scope;
//   - journey 1's folders are its call tasks' (T-633 to T-656), each with its index.ts, as JOURNEY_1_LANE lists them;
//   - each unbuilt handler answers notBuilt and writes nothing: its transaction rolled back, nothing read, no row noted;
//   - registration refuses a call outside the four (each other K-09 v1 call, the turn face's among them), a step that
//     saveSetupStep does not save, a call or a step registered already, and a folder its lane lists twice;
//   - the walking skeleton's handlers are unchanged: withSetupCalls keeps every other call's handler as given (the turn
//     face's gateAndCommit and the frontier's buildFrontier the very same functions), the skeleton registers none of the
//     four, and every accepted exchange of another call, the skeleton's S1-01 and S1-02 turn among them, answers exactly
//     as it does without the registry.
// Values come only from the contracts' fixtures (the master's sample cast, the 555-01xx range: rule 9).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Span } from "../../../../runtime/src/trace";
import { defaultCommitDeps } from "../../commit";
import { frontierHandlers, type FrontierRepo } from "../../frontier";
import { fakeBundles } from "../../frontier/assemble/test-support";
import { CALL_NAMES, hopOf, isCallerKind, type CallName, type RequestOf } from "../calls";
import { NotBuiltError } from "../errors";
import { JOURNEY_2_LANE } from "../journey-2";
import {
  acceptedExchanges,
  callerOf,
  contractFile,
  fixture,
  recordingHandlers,
  recordingScope,
  traceFor,
  type Exchange,
  type RecordingRepo,
  type ScopeEvent,
} from "../test-support";
import { createToolApi, notBuiltHandlers, type CallContext, type Handlers } from "../tool-api";
import { NOTHING_OPEN_AT } from "../turn-face";
import { callHandlers } from "../turn-face/turn-face";
import { CONTRACTS_DIR, createToolApiValidator } from "../validator";
import * as afterLive from "./after-live";
import * as agreements from "./agreements";
import * as calendar from "./calendar";
import * as companies from "./companies";
import * as control from "./control";
import * as feeConsent from "./fee-consent";
import * as goLive from "./go-live";
import * as goLivePage from "./go-live-page";
import {
  JOURNEY_1_2_LANES,
  JOURNEY_1_LANE,
  SETUP_CALLS,
  SETUP_STEPS,
  SetupRegistrationError,
  setupHandlers,
  withSetupCalls,
  type SetupEntry,
  type SetupFolder,
  type SetupLane,
  type SetupRefused,
} from "./index";
import * as kinds from "./kinds";
import * as licenses from "./licenses";
import * as listing from "./listing";
import * as mobileId from "./mobile-id";
import * as moneyCard from "./money-card";
import * as places from "./places";
import * as plan from "./plan";
import * as plugIns from "./plug-ins";
import * as profile from "./profile";
import * as rules from "./rules";
import * as services from "./services";
import * as spaces from "./spaces";
import * as start from "./start";
import * as stripeConnect from "./stripe-connect";
import * as summary from "./summary";
import * as teamSize from "./team-size";
import * as timetable from "./timetable";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** This folder, actions/src/tool-api/journey-1/. */
const JOURNEY_1_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Journey 1's call tasks' folders, in the order of their tasks (T-633 to T-656), as each task's May touch names it. */
const JOURNEY_1_FOLDERS = [
  "kinds",
  "plug-ins",
  "companies",
  "plan",
  "listing",
  "mobile-id",
  "control",
  "agreements",
  "licenses",
  "services",
  "places",
  "money-card",
  "spaces",
  "timetable",
  "rules",
  "profile",
  "calendar",
  "team-size",
  "fee-consent",
  "stripe-connect",
  "go-live-page",
  "go-live",
  "after-live",
  "summary",
  "start",
];

/** Each journey 1 folder's module, by the folder's name. */
const FOLDER_MODULES: Record<string, { FOLDER: SetupFolder<unknown> }> = {
  kinds,
  "plug-ins": plugIns,
  companies,
  plan,
  listing,
  "mobile-id": mobileId,
  control,
  agreements,
  licenses,
  services,
  places,
  "money-card": moneyCard,
  spaces,
  timetable,
  rules,
  profile,
  calendar,
  "team-size": teamSize,
  "fee-consent": feeConsent,
  "stripe-connect": stripeConnect,
  "go-live-page": goLivePage,
  "go-live": goLive,
  "after-live": afterLive,
  summary,
  start,
};

/**
 * The folder that answers each setup call, and each of saveSetupStep's steps, as "lane/folder": the call task that builds
 * it (plan cards T-633 to T-664; readSetup is after-live's, T-630's default).
 */
const OWNERS: Record<string, string> = {
  matchKinds: "journey-1/kinds",
  lookupListing: "journey-1/listing",
  readSetup: "journey-1/after-live",
  "saveSetupStep S1-02": "journey-1/kinds",
  "saveSetupStep S1-03": "journey-1/kinds",
  "saveSetupStep S1-11": "journey-1/plug-ins",
  "saveSetupStep S1-04": "journey-1/companies",
  "saveSetupStep S1-09": "journey-1/listing",
  "saveSetupStep S1-10": "journey-1/mobile-id",
  "saveSetupStep S1-72": "journey-1/agreements",
  "saveSetupStep S1-23": "journey-1/licenses",
  "saveSetupStep S1-61": "journey-1/licenses",
  "saveSetupStep S1-12": "journey-1/services",
  "saveSetupStep S1-43": "journey-1/places",
  "saveSetupStep S1-13": "journey-1/money-card",
  "saveSetupStep S1-81": "journey-1/spaces",
  "saveSetupStep S1-83": "journey-1/timetable",
  "saveSetupStep S1-21": "journey-1/rules",
  "saveSetupStep S1-84": "journey-1/profile",
  "saveSetupStep S1-24": "journey-1/calendar",
  "saveSetupStep S1-78": "journey-1/team-size",
  "saveSetupStep S1-25": "journey-1/fee-consent",
  "saveSetupStep S1-27": "journey-1/stripe-connect",
  "saveSetupStep S1-29": "journey-1/go-live-page",
  "saveSetupStep S1-32": "journey-1/go-live",
  "saveSetupStep S1-35": "journey-1/go-live",
  "saveSetupStep S2-02": "journey-2/add-team",
  "saveSetupStep S2-05": "journey-2/join",
  "saveSetupStep S2-06": "journey-2/staff-page",
  "saveSetupStep S2-11": "journey-2/licenses",
  "saveSetupStep S2-29": "journey-2/licenses",
  "saveSetupStep S2-15": "journey-2/skills",
  "saveSetupStep S2-27": "journey-2/on-call",
  "saveSetupStep S2-31": "journey-2/on-call",
  "saveSetupStep S2-24": "journey-2/take-bookings",
};

/** Whether a name is one of the four setup calls. */
function isSetupCall(call: string): boolean {
  return (SETUP_CALLS as readonly string[]).includes(call);
}

/** An entry's name: its call, with its step for saveSetupStep. */
function entryName(entry: { readonly call: string; readonly step?: unknown }): string {
  return entry.call === "saveSetupStep" ? `saveSetupStep ${String(entry.step)}` : entry.call;
}

/** What a request asks of the registry: its call, with the step for saveSetupStep. */
function requestName(call: string, request: Json): string {
  return call === "saveSetupStep" ? `saveSetupStep ${String((request.step as Json).step)}` : call;
}

// ---- K-09 v1's own words: the README's table and the schema's variants ------------------------------------------------

/** The calls K-09's README lists under "Journeys 1 and 2: the setup calls", in its table's order. */
function readmeSetupCalls(): string[] {
  const lines = readFileSync(path.join(CONTRACTS_DIR, "tool-api", "README.md"), "utf8").split("\n");
  const heading = lines.findIndex((line) => line.startsWith("### Journeys 1 and 2: the setup calls"));
  const calls: string[] = [];
  let inTable = false;
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith("|")) {
      inTable = true;
      const name = /^\|\s*`([A-Za-z]+)`/u.exec(line)?.[1];
      if (name !== undefined) calls.push(name);
    } else if (inTable) {
      break;
    }
  }
  return calls;
}

/** The step each variant of K-09 v1's saveSetupStep request saves (its `step.const`), in the variants' order. */
function schemaSteps(): string[] {
  const defs = (contractFile("tool-api/tool-api.v1.schema.json") as { $defs: Record<string, Json> }).$defs;
  const request = defs["saveSetupStep.request"] as { properties: { step: { oneOf: Json[] } } };
  return request.properties.step.oneOf.map((variant) => {
    const ref = variant.$ref;
    const def = typeof ref === "string" ? defs[ref.replace("#/$defs/", "")] : variant;
    return (def as { properties: { step: { const: string } } }).properties.step.const;
  });
}

// ---- K-09 v1's exchanges of the setup calls ---------------------------------------------------------------------------

/** Every accepted K-09 v1 exchange of a setup call, with its file. */
const SETUP_EXCHANGES = acceptedExchanges().filter(({ exchange }) => isSetupCall(exchange.call));

/** A readSetup request (K-09 v1 holds no readSetup exchange): match-kinds.json's caller, reading its own business. */
function readSetupRequest(): Json {
  const caller = callerOf((fixture("match-kinds.json") as Exchange).request);
  return { caller, businessId: caller?.businessId };
}

/** The setup exchanges with readSetup's request (its outcome unused), each with its file. */
const SETUP_REQUESTS: { file: string; call: CallName; request: Json }[] = [
  ...SETUP_EXCHANGES.map(({ file, exchange }) => ({ file, call: exchange.call, request: exchange.request })),
  { file: "readSetup (match-kinds.json's caller)", call: "readSetup", request: readSetupRequest() },
];

// ---- bases and handlers -----------------------------------------------------------------------------------------------

/** One of K-09 v1's errors every setup call has (K-05 transientError), which a recording handler answers. */
const TRANSIENT = { error: "transient", sqlstate: "40001" } as const;

/** What a recording entry saw. */
interface Seen {
  owner: string;
  entry: string;
  request: unknown;
  businessId: string;
}

/** `entry` with a handler that notes what it saw, reads the business row through the scoped repo, then answers TRANSIENT. */
function recorded(entry: SetupEntry<unknown>, owner: string, seen: Seen[]): SetupEntry<RecordingRepo> {
  const entryIs = entryName(entry);
  const handler = async (
    request: unknown,
    context: CallContext<RecordingRepo>,
  ): Promise<typeof TRANSIENT> => {
    seen.push({ owner, entry: entryIs, request, businessId: context.businessId });
    await context.repo.read("businesses", context.businessId);
    return TRANSIENT;
  };
  return entry.call === "saveSetupStep"
    ? { call: entry.call, step: entry.step, handler }
    : { call: entry.call, handler };
}

/** JOURNEY_1_2_LANES with every entry recording (as tool-api.test.ts's recordingHandlers do for one call). */
function recordingLanes(seen: Seen[]): SetupLane<RecordingRepo>[] {
  return JOURNEY_1_2_LANES.map(({ lane, folders }) => ({
    lane,
    folders: folders.map(({ folder, entries }) => ({
      folder,
      entries: entries.map((entry) => recorded(entry, `${lane}/${folder}`, seen)),
    })),
  }));
}

/** What one call left: its answer or what it threw, its scope's events and its spans. */
interface Ran {
  answered: unknown;
  thrown: unknown;
  events: ScopeEvent[];
  spans: Span[];
}

async function run(call: string, request: unknown, handlers: Handlers<RecordingRepo>): Promise<Ran> {
  const scope = recordingScope();
  const api = createToolApi<RecordingRepo>({ validator, scope, handlers });
  const { trace, spans } = traceFor(request);
  const settled = await api.call(call, structuredClone(request), trace).then(
    (answered) => ({ answered, thrown: undefined }),
    (thrown: unknown) => ({ answered: undefined, thrown }),
  );
  return { ...settled, events: scope.events, spans };
}

/** The one span a call left; fails the test when there is not exactly one. */
function onlySpan(spans: readonly Span[]): Span {
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no span");
  return span;
}

/** A span without its timing, which two runs of a call never share. */
function untimed(span: Span): Partial<Span> {
  const copy: Partial<Span> = { ...span };
  delete copy.at;
  delete copy.ms;
  return copy;
}

/** A handler called as anything may call it, with values it should never touch. */
type AnyHandler = (request: unknown, context: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------------------------------------------------

describe("every journey 1 and 2 call of K-09 v1 resolves to the handler its folder registers", () => {
  it("K-09 v1's journey 1 and 2 calls are the four its README's table names, each a call of v1, in callName's order", () => {
    expect(readmeSetupCalls()).toEqual([...SETUP_CALLS]);
    expect(CALL_NAMES.filter((call) => isSetupCall(call))).toEqual([...SETUP_CALLS]);
  });

  it("saveSetupStep saves the 32 steps of K-09 v1's request variants, in their order", () => {
    expect(schemaSteps()).toEqual([...SETUP_STEPS]);
    expect(SETUP_STEPS).toHaveLength(32);
  });

  it("each call and each step is registered once, by the folder of the call task that builds it", () => {
    const owners: Record<string, string> = {};
    for (const { lane, folders } of JOURNEY_1_2_LANES) {
      for (const { folder, entries } of folders) {
        for (const entry of entries) {
          const name = entryName(entry);
          expect(owners[name], name).toBeUndefined();
          owners[name] = `${lane}/${folder}`;
        }
      }
    }
    expect(owners).toEqual(OWNERS);
    expect(Object.keys(OWNERS)).toHaveLength(SETUP_CALLS.length - 1 + SETUP_STEPS.length);
    expect(JOURNEY_1_2_LANES).toEqual([JOURNEY_1_LANE, JOURNEY_2_LANE]);
  });

  it("journey 1's folders are its call tasks' (T-633 to T-656), each with its index.ts, as JOURNEY_1_LANE lists them", () => {
    const folders = readdirSync(JOURNEY_1_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual([...JOURNEY_1_FOLDERS].sort());
    expect(JOURNEY_1_LANE.lane).toBe("journey-1");
    expect(JOURNEY_1_LANE.folders.map(({ folder }) => folder)).toEqual(JOURNEY_1_FOLDERS);
    for (const folder of JOURNEY_1_LANE.folders) {
      expect(existsSync(path.join(JOURNEY_1_DIR, folder.folder, "index.ts")), folder.folder).toBe(true);
      expect(folder, folder.folder).toBe(FOLDER_MODULES[folder.folder]?.FOLDER);
    }
  });

  it("through the base, each call and each step a K-09 v1 exchange saves reaches its folder's handler, inside its business's scope", async () => {
    expect(validator.check("readSetup", "request", readSetupRequest())).toEqual([]);
    const reached = new Set<string>();
    for (const { file, call, request } of SETUP_REQUESTS) {
      const seen: Seen[] = [];
      const handlers = withSetupCalls(notBuiltHandlers(), recordingLanes(seen));
      const { answered, events } = await run(call, request, handlers);
      const name = requestName(call, request);
      expect(answered, file).toEqual(TRANSIENT);
      expect(seen, file).toEqual([
        { owner: OWNERS[name], entry: name, request, businessId: callerOf(request)?.businessId },
      ]);
      expect(
        events.map((event) => event.what),
        file,
      ).toEqual(["begin", "scope", "read", "rollback"]);
      reached.add(name);
    }
    // matchKinds, lookupListing and readSetup, and the 20 steps K-09 v1's accepted exchanges save (the next test runs
    // each of the 32).
    expect([...reached].filter((name) => isSetupCall(name)).sort()).toEqual([
      "lookupListing",
      "matchKinds",
      "readSetup",
    ]);
    expect([...reached].filter((name) => name.startsWith("saveSetupStep "))).toHaveLength(20);
  });

  it("saveSetupStep's handler runs the entry of the step its request saves, for each of the 32 steps", async () => {
    const seen: Seen[] = [];
    const handlers = setupHandlers(recordingLanes(seen));
    const context: CallContext<RecordingRepo> = {
      repo: { read: () => Promise.resolve(null) },
      businessId: "biz-lees-barbershop",
      span: { limits: [], rows: [] },
    };
    for (const step of SETUP_STEPS) {
      // Only the dispatch is under test here: the base holds a real request to K-09 first (the test above).
      const request = { step: { step } } as unknown as RequestOf<"saveSetupStep">;
      await expect(handlers.saveSetupStep(request, context), step).resolves.toEqual(TRANSIENT);
      expect(seen.at(-1), step).toMatchObject({
        owner: OWNERS[`saveSetupStep ${step}`],
        entry: `saveSetupStep ${step}`,
      });
    }
    expect(seen).toHaveLength(SETUP_STEPS.length);
  });
});

describe("each unbuilt handler answers notBuilt and writes nothing", () => {
  it("K-09 v1 holds 23 accepted exchanges of the setup calls, each caller naming a business", () => {
    expect(SETUP_EXCHANGES).toHaveLength(23);
    for (const { file, request } of SETUP_REQUESTS) {
      expect(typeof callerOf(request)?.businessId, file).toBe("string");
    }
  });

  for (const { file, call, request } of SETUP_REQUESTS) {
    it(`${file}: ${call} answers notBuilt inside its scope, rolled back, nothing read and no row noted`, async () => {
      const businessId = callerOf(request)?.businessId as string;
      const { answered, thrown, events, spans } = await run(
        call,
        request,
        withSetupCalls(notBuiltHandlers()),
      );
      expect(thrown).toBeUndefined();
      expect(answered).toEqual({ error: "notBuilt", call });
      expect(events).toEqual([{ what: "begin" }, { what: "scope", businessId }, { what: "rollback" }]);
      const kind = callerOf(request)?.kind;
      const span = onlySpan(spans);
      expect(span).toMatchObject({
        hop: hopOf(call, isCallerKind(kind) ? kind : undefined),
        outcome: "refused",
        error_code: "notBuilt",
        decided: { answered: "notBuilt" },
        got: { toolCall: call, callerKind: kind },
      });
      expect(span.rows).toBeUndefined();
      expect(validator.checkSpan(span)).toEqual([]);
    });
  }

  it("each folder's handler itself rejects with NotBuiltError naming its call, and touches neither its request nor its context", async () => {
    let handlers = 0;
    for (const { lane, folders } of JOURNEY_1_2_LANES) {
      for (const { folder, entries } of folders) {
        for (const entry of entries) {
          const where = `${lane}/${folder} ${entryName(entry)}`;
          const touched: string[] = [];
          const watched = (what: string): object =>
            new Proxy(
              {},
              {
                get(_target, key) {
                  touched.push(`${what}.${String(key)}`);
                  return undefined;
                },
              },
            );
          const settled = (entry.handler as unknown as AnyHandler)(watched("request"), watched("context"));
          await expect(settled, where).rejects.toBeInstanceOf(NotBuiltError);
          await expect(settled, where).rejects.toMatchObject({ name: "NotBuiltError", call: entry.call });
          expect(touched, where).toEqual([]);
          handlers += 1;
        }
      }
    }
    expect(handlers).toBe(SETUP_CALLS.length - 1 + SETUP_STEPS.length);
  });

  it("a call or a step no lane registers answers notBuilt too, nothing read", async () => {
    const take = SETUP_EXCHANGES.find(({ file }) => file === "take-bookings.json");
    const kindsMatched = SETUP_EXCHANGES.find(({ file }) => file === "match-kinds.json");
    if (take === undefined || kindsMatched === undefined) throw new Error("fixtures missing");
    const journeyOneOnly = withSetupCalls(notBuiltHandlers(), [JOURNEY_1_LANE]);
    const none = withSetupCalls(notBuiltHandlers(), []);
    for (const [handlers, exchange] of [
      [journeyOneOnly, take.exchange],
      [none, take.exchange],
      [none, kindsMatched.exchange],
    ] as const) {
      const { answered, events } = await run(exchange.call, exchange.request, handlers);
      expect(answered).toEqual({ error: "notBuilt", call: exchange.call });
      expect(events.map((event) => event.what)).toEqual(["begin", "scope", "rollback"]);
    }
  });
});

describe("registration refuses a call outside the four, a step saveSetupStep does not save, and anything registered twice", () => {
  const stub = (): Promise<never> => Promise.reject(new Error("never run"));

  /** A lane of one folder holding `entries`, typed loosely so a test can hand it what the types would refuse. */
  function laneOf(entries: readonly Json[], lane = "journey-1", folder = "kinds"): SetupLane<unknown> {
    return { lane, folders: [{ folder, entries: entries as unknown as readonly SetupEntry<unknown>[] }] };
  }

  /** The error registering `lanes` throws; fails the test when the handlers are made. */
  function refusal(lanes: readonly SetupLane<unknown>[]): SetupRegistrationError {
    try {
      setupHandlers(lanes);
    } catch (error) {
      if (error instanceof SetupRegistrationError) return error;
      throw error;
    }
    throw new Error("the lanes were registered");
  }

  function expectRefused(
    lanes: readonly SetupLane<unknown>[],
    expected: { lane: string; folder: string; entry: string; why: SetupRefused },
  ): SetupRegistrationError {
    const error = refusal(lanes);
    expect(error).toMatchObject(expected);
    expect(error.message).toContain(`(${expected.why})`);
    return error;
  }

  it("journeys 1 and 2's lanes register, and so do no lanes at all", () => {
    expect(() => setupHandlers()).not.toThrow();
    expect(() => setupHandlers([])).not.toThrow();
    expect(() => withSetupCalls(notBuiltHandlers())).not.toThrow();
  });

  it("each K-09 v1 call outside the four is refused by name, the turn face's among them, and so is a name that is no call", () => {
    const others = CALL_NAMES.filter((call) => !isSetupCall(call));
    expect(others).toHaveLength(25);
    expect(others).toEqual(
      expect.arrayContaining(["buildFrontier", "gateAndCommit", "composeInput", "finalizeMessage"]),
    );
    for (const call of [...others, "showMoneyBefore", "bookEverything", "__proto__", ""]) {
      expectRefused([laneOf([{ call, handler: stub }])], {
        lane: "journey-1",
        folder: "kinds",
        entry: call,
        why: "call",
      });
    }
  });

  it("a step saveSetupStep does not save is refused: S1-01 (the turn's own), S1-74 (S1-02's pick), S1-08, S2-21 and others", () => {
    for (const step of ["S1-01", "S1-74", "S1-08", "S1-75", "S2-21", "S3-01", "s1-02", "", undefined]) {
      expectRefused([laneOf([{ call: "saveSetupStep", step, handler: stub }])], {
        lane: "journey-1",
        folder: "kinds",
        entry: `saveSetupStep ${String(step)}`,
        why: "step",
      });
    }
  });

  it("a call or a step registered already is refused: in one folder, by another folder and by another lane", () => {
    expectRefused(
      [
        laneOf([
          { call: "matchKinds", handler: stub },
          { call: "matchKinds", handler: stub },
        ]),
      ],
      { lane: "journey-1", folder: "kinds", entry: "matchKinds", why: "registered" },
    );
    const byFolder = expectRefused(
      [
        {
          lane: "journey-1",
          folders: [
            ...JOURNEY_1_LANE.folders,
            { folder: "kinds-again", entries: [{ call: "saveSetupStep", step: "S1-02", handler: stub }] },
          ],
        },
      ],
      { lane: "journey-1", folder: "kinds-again", entry: "saveSetupStep S1-02", why: "registered" },
    );
    expect(byFolder.message).toContain("journey-1/kinds registered it already");
    const byLane = expectRefused(
      [...JOURNEY_1_2_LANES, laneOf([{ call: "saveSetupStep", step: "S2-24", handler: stub }], "journey-9")],
      { lane: "journey-9", folder: "kinds", entry: "saveSetupStep S2-24", why: "registered" },
    );
    expect(byLane.message).toContain("journey-2/take-bookings registered it already");
    expectRefused([JOURNEY_1_LANE, laneOf([{ call: "readSetup", handler: stub }], "journey-2", "summary")], {
      lane: "journey-2",
      folder: "summary",
      entry: "readSetup",
      why: "registered",
    });
  });

  it("a folder its lane lists twice is refused, and so is a lane listed twice", () => {
    expectRefused([{ lane: "journey-1", folders: [plan.FOLDER, plan.FOLDER] }], {
      lane: "journey-1",
      folder: "plan",
      entry: "(folder)",
      why: "folder",
    });
    expectRefused([JOURNEY_1_LANE, JOURNEY_1_LANE], {
      lane: "journey-1",
      folder: "kinds",
      entry: "(folder)",
      why: "folder",
    });
  });
});

describe("the walking skeleton's handlers are unchanged (DL-867 item 2)", () => {
  it("withSetupCalls keeps every other call's handler as given and answers only the four setup calls", () => {
    const given: Record<string, AnyHandler> = {};
    for (const call of CALL_NAMES) given[call] = () => Promise.reject(new Error(call));
    const handlers = given as unknown as Handlers<unknown>;
    const merged = withSetupCalls(handlers);
    expect(Object.keys(merged).sort()).toEqual([...CALL_NAMES].sort());
    for (const call of CALL_NAMES) {
      if (isSetupCall(call)) expect(merged[call], call).not.toBe(handlers[call]);
      else expect(merged[call], call).toBe(handlers[call]);
    }
  });

  it("the turn face's and the frontier's handlers keep their very functions, and register none of the four setup calls", async () => {
    const face = callHandlers<RecordingRepo>(
      { scope: recordingScope(), commit: () => defaultCommitDeps<RecordingRepo>() },
      NOTHING_OPEN_AT,
    );
    const frontier = frontierHandlers<FrontierRepo>({ bundles: fakeBundles() });
    for (const [skeleton, handlers] of [
      ["turn face", face as Handlers<unknown>],
      ["frontier", frontier as Handlers<unknown>],
    ] as const) {
      const merged = withSetupCalls(handlers);
      for (const call of CALL_NAMES.filter((each) => !isSetupCall(each))) {
        expect(merged[call], `${skeleton} ${call}`).toBe(handlers[call]);
      }
      // The skeleton serves none of the four (each is notBuiltHandlers' stub there), so no entry stands in front of it.
      for (const call of SETUP_CALLS) {
        await expect(
          (handlers[call] as unknown as AnyHandler)({}, {}),
          `${skeleton} ${call}`,
        ).rejects.toMatchObject({ name: "NotBuiltError", call });
      }
    }
  });

  it("every accepted exchange of another call, the skeleton's S1-01 and S1-02 turn among them, answers exactly as without the registry", async () => {
    const index = (contractFile("tool-api/fixtures/index.json") as { fixtures: Json[] }).fixtures;
    const later = index
      .filter(
        (entry) =>
          (entry.version === "v1.5" || entry.version === "v1.6") &&
          entry.expect === "accept" &&
          String(entry.def).endsWith(".exchange"),
      )
      .map((entry) => ({ file: String(entry.file), exchange: fixture(String(entry.file)) as Exchange }));
    const exchanges = [...acceptedExchanges(), ...later].filter(
      ({ exchange }) => !isSetupCall(exchange.call),
    );
    const skeleton = [
      "build-frontier-s1-01.json",
      "commit-s1-01.json",
      "build-frontier-s1-02.json",
      "commit-s1-02.json",
      "compose-input-s1-02.json",
      "compose-input-s1-02-v1.6.json",
    ];
    expect(exchanges.map(({ file }) => file)).toEqual(expect.arrayContaining(skeleton));
    for (const { file, exchange } of exchanges) {
      // The call's own handler is served (it answers its fixture), as the turn face serves the skeleton's calls.
      const served = recordingHandlers(exchange.call, () => structuredClone(exchange.outcome));
      const plain = await run(exchange.call, exchange.request, served);
      const withRegistry = await run(exchange.call, exchange.request, withSetupCalls(served));
      expect(withRegistry.answered, file).toEqual(plain.answered);
      expect(withRegistry.thrown, file).toEqual(plain.thrown);
      expect(withRegistry.events, file).toEqual(plain.events);
      expect(withRegistry.spans.map(untimed), file).toEqual(plain.spans.map(untimed));
      if (skeleton.includes(file)) expect(withRegistry.answered, file).toEqual(exchange.outcome);
    }
  });
});
