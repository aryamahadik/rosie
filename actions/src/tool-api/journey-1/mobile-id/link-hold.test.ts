// T-1533's unit proof of the secure link's way from S1-10's writer to the slot filler, through the turn face (K-09
// README default 211; DL-1167 (3) and (4)). `npm run test:unit -- actions/src/tool-api/journey-1/mobile-id`.
//
// Under test, as they are: the face's gateAndCommit and finalizeMessage with its link hold (turn-face.ts, held.ts
// HeldLinks), T-305's gate and one commit per turn with its GATE_RUNS, S1-10's writer and its minting (writer.ts,
// link.ts) staging into the face's own HeldLinks, rows.ts's compose and finalize bindings giving the held link to the
// row it is held for, T-309's compose input and T-313's finalize with T-310's link.secure filler and the Values check.
//
// Doubles, for ports only: the commit binding of turn 1 (calls-test-support.ts callDoubles: commit-s1-01.json's request,
// K-05's fake commitTurn, T-318's safety world, the same-bytes sealer), whose walk's writesOf is wrapped to add S1-10's
// rows after its own as the walk adds them on S1-09's answer (bundle v3 reaches S1-10 only through S1-09, which turn 1's
// door does not walk; mobile-id.test.ts proves the real walk on bundle v3), S1-09's reading taken by T-635a's own settler
// on the same turn object; the K-05 reads of S1-10's writer and the stop home's reads (test-support.ts); and K-05's row
// reads for S1-10's row (read-outbox-row-s1-02-not-sensitive.json's answer moved to S1-10's line 2, on a copy of
// bundle-v0-skeleton.json holding bundle v3's S1-10). The links are made from the Web Crypto generator, under staging's
// place (rosfield.com/test); nothing in them is real.
//
// The card's cases here: S1-10's line 2 row's finalized text carries https://<host><base>/<code> and the line ending
// "These texts are only about your business on Rosie."; the same turn replayed holds nothing new; a conflict's second
// run hands on its own code; the commit's accounts_mobile_key refusal (23505) holds nothing; compose input allows
// link.secure only on that row; a row with no held code never sends a link, and the sample rosfield.com/v/s01 is never
// sent; nothing logs.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createPlacesDouble } from "../../../../../adapters/src/places/double";
import type { CommitDeps, CommitTurnContext, OpenHolds, PassedPart, UnitWrites } from "../../../commit";
import { textSourceOf, type StepRows } from "../../../commit/walk";
import { flowAV3 } from "../../../commit/walk/test-support";
import { sampleBundle, type BundleDocument } from "../../../frontier/assemble/test-support";
import { readsOn, seedWorld } from "../../../homes/stop/test-support";
import { contractFile, fixture, traceFor } from "../../test-support";
import {
  callDoubles,
  fixedLineFactsS102,
  outboxRowS102,
  rowDoubles,
  type CallDoubles,
} from "../../turn-face/calls-test-support";
import { NOTHING_OPEN_AT } from "../../turn-face/commit";
import { HeldLinks } from "../../turn-face/held";
import { composeInputDeps, finalizeDeps, type OutboxRowRead } from "../../turn-face/rows";
import { createTurnFace, type TurnFace, type TurnFaceCalls } from "../../turn-face/turn-face";
import { createToolApiValidator } from "../../validator";
import { OWNER_MATCHES, listingReadsOf } from "../listing";
import { RULING_WORDS, fakeListingK05, s1_09Step, s1_09Turn } from "../listing/test-support";
import {
  LINK_CODE_FORM,
  mobileIdReadsOf,
  mobileIdSteps,
  type MobileIdSteps,
  type MobileIdStepsDeps,
} from "./index";
import { fakeMobileIdK05, linkDeps, s1_10Step, SAM_PERSON } from "./test-support";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** S1-10's line 2 row of turn 1 (default 131: turn key sam). */
const S1_10_ROW = "outbox-s1-10-sam-1";

/** S1-10's line 2 (say[4]) as bundle v3 compiles it: its last sentence ends the finalized text. */
const LAST_SENTENCE = "These texts are only about your business on Rosie.";

/** The sample link bundle v3's S1-10 card carries (MC C6): never sent. */
const SAMPLE_LINK = "rosfield.com/v/s01";

/** The face's commit, compose and finalize over the doubles, sharing one HeldLinks, and what each double saw. */
interface Face {
  readonly face: TurnFace;
  readonly links: HeldLinks;
  readonly commit: CallDoubles;
  /** Every K-05 request each gate run sent, answered by the fake or by a given answer, in order. */
  readonly sent: Parameters<CommitDeps["ports"]["commitTurn"]>[0][];
  readonly plans: ReturnType<typeof rowDoubles>["plans"];
}

/**
 * Turn 1's commit binding (callDoubles) with K-05's fake commitTurn answering `answers` first (null: commit), its
 * writesOf wrapped so each gate run adds S1-10's rows after the walk's own: S1-09's settler, then S1-10's writer, on that
 * run's own turn object, with the face's HeldLinks as the writer's stage. Compose input and finalize read S1-10's row.
 */
function faceOver(answers: readonly (Json | null)[] = []): Face {
  const links = new HeldLinks();
  const commit = callDoubles();
  // The steps over the call's repo as the face hands it (no database here): the doubles read no repo.
  const deps: MobileIdStepsDeps = {
    places: createPlacesDouble({ now: () => "2026-10-19T18:05:04Z" }),
    reads: listingReadsOf(fakeListingK05().k05),
    stop: readsOn(seedWorld(), null),
    mobileId: { reads: mobileIdReadsOf(fakeMobileIdK05().k05), link: linkDeps(links) },
  };
  const steps = mobileIdSteps(deps);
  const answered = [...answers];
  const sent: Face["sent"][number][] = [];
  const commitDeps = (at: Parameters<TurnFaceCalls<unknown>["commit"]>[0]): CommitDeps => {
    const deps = commit.calls.commit(at);
    const writesOf = async (
      part: PassedPart,
      context: CommitTurnContext,
      open: OpenHolds,
    ): Promise<UnitWrites> => {
      const walked = await deps.ports.writesOf(part, context, open);
      const rows = await s1_10RowsOn(steps, context);
      return {
        ...walked,
        state: [...walked.state, ...rows.state],
        messages: [...walked.messages, ...rows.messages],
        gives: [...walked.gives, ...rows.gives],
      };
    };
    const commitTurn: CommitDeps["ports"]["commitTurn"] = (request, call) => {
      sent.push(structuredClone(request));
      const next = answered.shift();
      if (next === undefined || next === null) return deps.ports.commitTurn(request, call);
      // A commit that throws (a lost connection the port does not answer): the call fails closed.
      if (next.throws === true) return Promise.reject(new Error("the commit's connection was lost"));
      return Promise.resolve(next as never);
    };
    return { ...deps, ports: { ...deps.ports, writesOf, commitTurn } };
  };
  const rows = rowDoubles({ row: s1_10Read(), facts: textedBeforeFacts(), bundle: skeletonWithS110() });
  const binding = { ...rows.binding, links };
  const calls: TurnFaceCalls<unknown> = {
    scope: commit.calls.scope,
    commit: commitDeps,
    compose: composeInputDeps(binding),
    finalize: finalizeDeps(binding),
    held: rows.held,
    links,
  };
  const face = createTurnFace<never>({
    scope: { withBusiness: () => Promise.reject(new Error("the frontier is not called here")) },
    bundles: binding.bundles,
    validator,
    calls,
  });
  return { face, links, commit, sent, plans: rows.plans };
}

/** S1-09's settler, then S1-10's writer, on one gate run's turn object, as the walk calls them on S1-09's answer. */
async function s1_10RowsOn(steps: MobileIdSteps, context: CommitTurnContext): Promise<StepRows> {
  const { part, choice } = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
  await steps.settlers["S1-09"]({
    repo: context.repo,
    businessId: context.businessId,
    step: s1_09Step(),
    part,
    choice,
    turn: context,
  });
  const counts = new Map<string, number>();
  return steps.writers["S1-10"]({
    repo: context.repo,
    step: s1_10Step(),
    part,
    choice,
    writer: {
      turn: context,
      why: { step: "S1-09", choice: OWNER_MATCHES },
      zone: "America/New_York",
      writerLane: "owner",
      rowId: (kind) => {
        const n = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, n);
        return `${kind}-s1-10-sam-${String(n)}`;
      },
      text: () => textSourceOf(context.request),
    },
  });
}

/** bundle-v0-skeleton.json (the row's pin), a test's own copy, holding bundle v3's S1-10 (T-1526) as compiled. */
function skeletonWithS110(): BundleDocument {
  const bundle = sampleBundle("bundle-v0-skeleton.json");
  const step = (flowAV3() as unknown as { steps: Record<string, Json | undefined> }).steps["S1-10"];
  if (step === undefined) throw new Error("bundle v3 holds S1-10");
  (bundle.flows.A as { steps: Record<string, Json> }).steps["S1-10"] = step;
  return bundle;
}

/** S1-10's line 2 row of turn 1 as K-05 v1.22 reads it: S1-02's row's answer, moved to the row's own step and line. */
function s1_10Read(): OutboxRowRead {
  const read = structuredClone(outboxRowS102());
  return {
    ...read,
    outboxRowId: S1_10_ROW,
    row: { ...read.row, openQuestionId: null },
    line: { step: "S1-10", index: 2, from: "row" },
    slotSource: { ...read.slotSource, question: null },
    openQuestions: [],
  };
}

/** A later text's two facts (K-05 fixed-line-facts-texted-before.json): no opener, the opt-out line delivered. */
function textedBeforeFacts() {
  const before = (
    contractFile("data-access/fixtures/fixed-line-facts-texted-before.json") as {
      outcome: { textedAboutBusiness: boolean; optOutLineDeliveredAt: string | null };
    }
  ).outcome;
  return {
    ...fixedLineFactsS102(),
    textedAboutBusiness: before.textedAboutBusiness,
    optOutLineDeliveredAt: before.optOutLineDeliveredAt,
  };
}

/** commit-s1-01.json's request (turn 1, Sam's own handle and person, on iMessage). */
function turnOne(): Json {
  return (fixture("commit-s1-01.json") as { request: Json }).request;
}

async function gateAndCommit(face: TurnFace): Promise<Json> {
  const request = turnOne();
  return (await face.gateAndCommit(
    structuredClone(request),
    NOTHING_OPEN_AT,
    traceFor(request).trace,
  )) as unknown as Json;
}

/** finalize-pass.json's request for S1-10's row, its plan S1-10's line with the link slot, as a composer writes it. */
function finalizeRequest(lines: readonly { role: string; text: string }[]): Json {
  const { request } = fixture("finalize-pass.json") as { request: Json };
  return {
    ...request,
    outboxRowId: S1_10_ROW,
    plan: {
      row: S1_10_ROW,
      channel: "imessage",
      copyOf: null,
      plan: { formats: ["text"], lines, question: null, pageType: null, threadReplyTo: null },
    },
  };
}

/** S1-10's line as the composer would write it, the secure link in its slot. */
const LINK_PLAN = [
  {
    role: "first",
    text: "This is Rosie, an automated assistant, setting up {{biz.name}}. Your secure ID upload is below: {{link.secure}}",
  },
  { role: "fact", text: LAST_SENTENCE },
];

async function finalize(face: TurnFace, lines: readonly { role: string; text: string }[] = LINK_PLAN) {
  const request = finalizeRequest(lines);
  const answer = (await face.finalizeMessage(
    structuredClone(request),
    traceFor(request).trace,
  )) as unknown as Json;
  expect(validator.check("finalizeMessage", "response", answer)).toEqual([]);
  return answer as Json & { outcome: string; finalParts: { sends: { text: string }[] } | null };
}

/** The page_links row's code hash in each K-05 request a gate run sent, in order (null: none). */
function hashesSent(made: Face): unknown[] {
  return made.sent.map((request) => {
    const insert = request.writes.state.find((write) => write.table === "page_links");
    return insert?.op === "insert" ? insert.values.code_sha256 : null;
  });
}

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const codeOf = (link: string): string => link.slice(link.lastIndexOf("/") + 1);

const consoleNames = ["log", "info", "warn", "error", "debug"] as const;
let spies: MockInstance[] = [];
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  spies = consoleNames.map((name) =>
    vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }),
  );
});

afterEach(() => {
  // No code, link or number in any log line: the face's calls log nothing here.
  for (const line of lines) {
    expect(line).not.toMatch(/[0-9a-f]{32}/);
    expect(line).not.toContain("rosfield.com");
    expect(line).not.toContain("5555550100");
  }
  for (const spy of spies) spy.mockRestore();
});

describe("the face holds S1-10's link from a fresh commit only (K-09 README default 211; DL-1167 (3))", () => {
  it("a fresh commit holds the link of the row it wrote; its hash is the one the commit stored; nothing stays staged", async () => {
    const made = faceOver();
    const answer = await gateAndCommit(made.face);
    expect(answer).toMatchObject({ result: "committed", turnId: "turn-s1-01-sam", repeated: false });
    expect(answer.written).toMatchObject({
      outboxRows: [{ id: "outbox-s1-02-sam-1" }, { id: S1_10_ROW }],
    });
    const link = made.links.of(S1_10_ROW);
    expect(link).toMatch(/^https:\/\/rosfield\.com\/test\/[0-9a-f]{32}$/);
    const code = codeOf(link ?? "");
    expect(code).toMatch(LINK_CODE_FORM);
    expect(hashesSent(made)).toEqual([await sha256(code)]);
    expect(made.links.of("outbox-s1-02-sam-1")).toBeNull();
    expect(made.links.stagedTurns).toBe(0);
    // The commit's request carries the hash alone: never the code or the link.
    expect(JSON.stringify(made.commit.k05.requests)).not.toContain(code);
    // The accounts row for Sam's own sign-in rode in the same commit.
    expect(made.commit.k05.requests[0]?.writes.state).toContainEqual({
      op: "insert",
      table: "accounts",
      values: { person_id: SAM_PERSON, mobile: "+15555550100", mobile_proven_at: "2026-10-19T18:05:00Z" },
    });
  });

  it("the same turn replayed writes nothing and holds no new code: the first commit's link stays the one held", async () => {
    const made = faceOver();
    await gateAndCommit(made.face);
    const first = made.links.of(S1_10_ROW);
    const again = await gateAndCommit(made.face);
    expect(again).toMatchObject({ result: "committed", repeated: true });
    expect(made.commit.k05.commits).toHaveLength(1);
    expect(made.links.of(S1_10_ROW)).toBe(first);
    expect(made.links.size).toBe(1);
    expect(made.links.stagedTurns).toBe(0);
  });

  it("a replay in a face that holds nothing (an isolate started again) holds nothing", async () => {
    const made = faceOver();
    await gateAndCommit(made.face);
    made.links.letGo(S1_10_ROW);
    const again = await gateAndCommit(made.face);
    expect(again).toMatchObject({ result: "committed", repeated: true });
    expect(made.links.of(S1_10_ROW)).toBeNull();
    expect(made.links.size).toBe(0);
  });

  it("a conflict's second run hands on its own code: the one whose hash the committing request carries, never the first run's", async () => {
    const conflict = {
      error: "versionChanged",
      changed: [{ table: "phones", rowId: "handle-sam", readVersion: 2, currentVersion: 3 }],
    };
    const made = faceOver([conflict]);
    const answer = await gateAndCommit(made.face);
    expect(answer).toMatchObject({ result: "committed", repeated: false });
    const [firstRun, secondRun, more] = hashesSent(made);
    expect(more).toBeUndefined();
    expect(firstRun).toMatch(/^[0-9a-f]{64}$/);
    expect(secondRun).toMatch(/^[0-9a-f]{64}$/);
    expect(firstRun).not.toEqual(secondRun);
    const link = made.links.of(S1_10_ROW);
    expect(await sha256(codeOf(link ?? ""))).toBe(secondRun);
    expect(made.links.stagedTurns).toBe(0);
  });

  it("the commit's accounts_mobile_key refusal (23505, another person's mobile) holds nothing and names no one", async () => {
    const refused = { error: "constraint", sqlstate: "23505", constraint: "accounts_mobile_key" };
    const made = faceOver([refused]);
    const answer = await gateAndCommit(made.face);
    expect(answer).toEqual(refused);
    expect(made.commit.k05.commits).toEqual([]);
    expect(made.links.size).toBe(0);
    expect(made.links.stagedTurns).toBe(0);
    expect(JSON.stringify(answer)).not.toContain("person-");
  });

  it("a call whose commit throws after S1-10's writer staged its link holds nothing and leaves nothing staged", async () => {
    const made = faceOver([{ throws: true }]);
    const request = turnOne();
    const outcome = await made.face
      .gateAndCommit(structuredClone(request), NOTHING_OPEN_AT, traceFor(request).trace)
      .then(
        (answer) => ({ answer }),
        (thrown: unknown) => ({ thrown }),
      );
    expect(outcome).not.toMatchObject({ answer: { result: "committed" } });
    // The writer ran and staged its link before the commit was sent; the commit wrote nothing.
    expect(hashesSent(made)).toHaveLength(1);
    expect(made.commit.k05.commits).toEqual([]);
    expect(made.links.size).toBe(0);
    expect(made.links.stagedTurns).toBe(0);
  });
});

describe("compose input and finalize take the held link for its row alone (DL-1167 (4))", () => {
  it("compose input allows link.secure on S1-10's row while its link is held, and on no row once it is not", async () => {
    const made = faceOver();
    await gateAndCommit(made.face);
    const { request } = fixture("compose-input-s1-02.json") as { request: Json };
    const forRow = { ...request, outboxRowId: S1_10_ROW };
    const answer = (await made.face.composeInput(
      structuredClone(forRow),
      traceFor(forRow).trace,
    )) as unknown as Json;
    expect(validator.check("composeInput", "response", answer)).toEqual([]);
    expect(answer).toMatchObject({
      result: "compose",
      input: { row: S1_10_ROW, masterText: { step: "S1-10" }, allowedLinks: ["link.secure"] },
    });
    // The link is never a fact the composer reads, and never its words.
    expect(JSON.stringify((answer as { input: Json }).input.facts)).not.toContain("rosfield.com");

    made.links.letGo(S1_10_ROW);
    const after = (await made.face.composeInput(
      structuredClone(forRow),
      traceFor(forRow).trace,
    )) as unknown as Json;
    expect(after).toMatchObject({ result: "compose", input: { allowedLinks: [] } });
  });

  it("S1-10's line 2 row's finalized text carries https://<host><base>/<code> and ends with its last line; then the link is let go", async () => {
    const made = faceOver();
    await gateAndCommit(made.face);
    const link = made.links.of(S1_10_ROW) ?? "";
    const answer = await finalize(made.face);
    expect(answer.outcome).toBe("send");
    const text = answer.finalParts?.sends.map((send) => send.text).join("\n") ?? "";
    expect(link).toMatch(/^https:\/\/rosfield\.com\/test\/[0-9a-f]{32}$/);
    expect(text).toContain(`Your secure ID upload is below: ${link}`);
    expect(text.endsWith(LAST_SENTENCE)).toBe(true);
    expect(text).not.toContain(SAMPLE_LINK);
    expect(made.plans).toHaveLength(1);
    // Sent: the face lets the row's link go.
    expect(made.links.of(S1_10_ROW)).toBeNull();
  });

  it("a row with no held code never sends a link: the slot is left unfilled, and the plan is not sent as written", async () => {
    const made = faceOver();
    const answer = await finalize(made.face);
    expect(answer.outcome).not.toBe("send");
    expect(answer.outcome).not.toBe("sendAndLog");
    const text = JSON.stringify(answer.finalParts);
    expect(text).not.toContain("rosfield.com");
  });

  it("a plan that writes the sample link rosfield.com/v/s01 is never sent, even with the row's link held", async () => {
    const made = faceOver();
    await gateAndCommit(made.face);
    const answer = await finalize(made.face, [
      {
        role: "first",
        text: `This is Rosie, an automated assistant, setting up {{biz.name}}. Your secure ID upload is below: ${SAMPLE_LINK}`,
      },
      { role: "fact", text: LAST_SENTENCE },
    ]);
    expect(answer.outcome).not.toBe("send");
    expect(answer.outcome).not.toBe("sendAndLog");
    expect(JSON.stringify(answer.finalParts)).not.toContain(SAMPLE_LINK);
  });

  it("a rewrite keeps the row's link held for the next attempt, whose plan then carries it and is sent", async () => {
    const made = faceOver();
    await gateAndCommit(made.face);
    const link = made.links.of(S1_10_ROW);
    const first = await finalize(made.face, [
      {
        role: "first",
        text: `This is Rosie, an automated assistant, setting up {{biz.name}}. Your secure ID upload is below: ${SAMPLE_LINK}`,
      },
      { role: "fact", text: LAST_SENTENCE },
    ]);
    expect(first.outcome).toBe("rewrite");
    expect(made.links.of(S1_10_ROW)).toBe(link);
  });
});
